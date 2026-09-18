#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { Bridge } from './bridge.mjs';
import { safeError } from './common.mjs';
import { setup } from './providers.mjs';
import pkg from '../package.json' with { type: 'json' };

if (process.env.GROK_ALLY_ACTIVE === '1') {
  console.error('Recursive Grok Ally launch blocked. Call the bridge from the host MCP client.');
  process.exit(1);
}

const bridge = new Bridge();
const server = new McpServer({ name: 'grok-ally', version: pkg.version });
const waitSeconds = z.number().int().min(0).max(60).default(25);
const detail = z.enum(['compact', 'full']).default('compact').describe('Compact status by default; full adds workspace metadata, the recent tool list, and running text.');
const provider = z.enum(['grok', 'cursor']).optional().describe('Backend for new sessions. Defaults to GROK_ALLY_PROVIDER or grok; saved sessionId selects its original backend.');
const requestId = z.string().uuid();
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data, isError: data.status === 'failed' || data.status === 'incomplete' });
const handle = fn => async (...args) => {
  try { return result(await fn(...args)); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: safeError(error) }] }; }
};

server.registerTool('grok_chat', {
  description: 'Start or continue Grok Build or Cursor Agent using the real project cwd. Cursor defaults to cursor-grok-4.6-xhigh. Default read-only; write=true authorizes edits. Keep sessionId for follow-ups. Poll unfinished requests with grok_status; host chat history is not imported.',
  inputSchema: z.object({
    prompt: z.string().trim().min(1).max(100000),
    cwd: z.string().min(1),
    provider,
    sessionId: z.string().min(1).max(2000).optional(),
    write: z.boolean().default(false).describe('Authorize native edits and commands. Grok uses its workspace sandbox; Cursor uses Agent mode, without an equivalent OS confinement guarantee.'),
    model: z.string().min(1).max(200).optional().describe('New sessions only. Grok: exact grok models ID, or native default. Cursor: defaults to cursor-grok-4.6-xhigh; other choices use ACP model IDs with bracket parameters.'),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional().describe('New sessions only. Must be honored by the selected Grok model.'),
    waitSeconds,
    detail,
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, handle((input, extra) => bridge.wait(bridge.start(input), input.waitSeconds, extra, true, { detail: input.detail })));

server.registerTool('grok_status', {
  description: 'Wait for a turn to finish (default 25s), then return its answer. Ordinary waits omit afterRevision; that cursor wakes on progress and can increase polling. Compact replies include toolSummary.state (active|unconfirmed|confirmed). Page answers with outputOffset or outputLimit (limit alone starts at 0). Page sanitized tool history with toolOffset/toolLimit. Use cwd instead of requestId to find requests. Results expire when this MCP process exits.',
  inputSchema: z.object({ requestId: requestId.optional(),
    cwd: z.string().min(1).optional().describe('Absolute workspace path. Use instead of requestId to find requests.'),
    waitSeconds,
    detail,
    afterRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Opt into progress-triggered returns using the last revision; omit to wait for completion.'),
    outputOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Read full text from UTF-8 byte offset 0, then output.nextOffset while hasMore. Pages return immediately.'),
    outputLimit: z.number().int().min(4).max(64000).optional().describe('Page size in UTF-8 bytes; default 16000. Alone, starts at outputOffset 0.'),
    toolOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Read sanitized tool-state history from this stable record cursor. Pages return immediately.'),
    toolLimit: z.number().int().min(1).max(100).optional().describe('History page size; default 20, max 100. Pages also stop at 16000 UTF-8 bytes. Alone, starts at toolOffset 0. Do not mix with output paging.'),
  }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle((input, extra) => {
  if (Boolean(input.requestId) === Boolean(input.cwd)) throw new Error('Pass either requestId or cwd, not both.');
  const outputPaging = input.outputOffset !== undefined || input.outputLimit !== undefined;
  const toolPaging = input.toolOffset !== undefined || input.toolLimit !== undefined;
  if (input.cwd && (input.afterRevision !== undefined || outputPaging || toolPaging)) {
    throw new Error('afterRevision and paging require requestId.');
  }
  if (outputPaging && toolPaging) throw new Error('Pass either output paging or tool history paging, not both.');
  const query = { ...input };
  if (query.outputLimit !== undefined && query.outputOffset === undefined) query.outputOffset = 0;
  if (query.toolLimit !== undefined && query.toolOffset === undefined) query.toolOffset = 0;
  return input.requestId ? bridge.wait(bridge.get(input.requestId), input.waitSeconds, extra, false, query) : bridge.list(input.cwd);
}));

server.registerTool('grok_cancel', {
  description: 'Cancel a turn through ACP, then close the native session when supported and retire the process. Returns cancelling until cleanup settles; check cleanup.state via grok_status before taking over. Existing edits are not rolled back. Follow-up with the same sessionId loads a new process.',
  inputSchema: z.object({ requestId, detail }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, handle(input => bridge.cancel(input.requestId, { detail: input.detail })));

server.registerTool('grok_setup', {
  description: 'Check the selected backend binary and version (provider: grok or cursor). Does not read credentials or claim that authentication was verified.',
  inputSchema: z.object({ provider }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle(input => setup(input)));

server.server.onclose = () => bridge.close();
process.once('SIGTERM', () => { bridge.close(); void server.close(); });
process.once('SIGINT', () => { bridge.close(); void server.close(); });
process.stdin.once('end', () => { bridge.close(); void server.close(); });

if (process.argv.includes('--version')) console.log(`grok-ally ${pkg.version}`);
else if (process.argv.includes('--check')) {
  try { console.log(JSON.stringify(await setup(), null, 2)); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
} else await server.connect(new StdioServerTransport());
