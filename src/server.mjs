#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { Bridge } from './bridge.mjs';
import { safeError, setup } from './grok.mjs';
import pkg from '../package.json' with { type: 'json' };

if (process.env.GROK_ALLY_ACTIVE === '1') {
  console.error('Recursive Grok Ally launch blocked. Call the bridge from the host MCP client.');
  process.exit(1);
}

const bridge = new Bridge();
const server = new McpServer({ name: 'grok-ally', version: pkg.version });
const waitSeconds = z.number().int().min(0).max(60).default(25);
const detail = z.enum(['compact', 'full']).default('compact').describe('Compact status by default; full adds workspace metadata, tool history, and running text.');
const requestId = z.string().uuid();
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data, isError: data.status === 'failed' || data.status === 'incomplete' });
const handle = fn => async (...args) => {
  try { return result(await fn(...args)); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: safeError(error) }] }; }
};

server.registerTool('grok_chat', {
  description: 'Start or continue Grok Build using the real project cwd. Default read-only; write=true authorizes edits. Keep sessionId for follow-ups. Poll unfinished requests with grok_status; host chat history is not imported.',
  inputSchema: z.object({
    prompt: z.string().trim().min(1).max(100000),
    cwd: z.string().min(1),
    sessionId: z.string().min(1).max(200).optional(),
    write: z.boolean().default(false),
    model: z.string().min(1).max(200).optional().describe('New sessions only. Exact model ID from grok models; omit for the native default.'),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional().describe('New sessions only. Must be honored by the selected Grok model.'),
    waitSeconds,
    detail,
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, handle((input, extra) => bridge.wait(bridge.start(input), input.waitSeconds, extra, true, { detail: input.detail })));

server.registerTool('grok_status', {
  description: 'Wait for a turn to finish (default 25s), then return its answer. Running replies are compact; use detail=full for diagnostics or afterRevision for early progress returns. Page long answers with outputOffset. Use cwd instead of requestId to find active/recent requests. Results expire when this MCP process exits.',
  inputSchema: z.object({ requestId: requestId.optional(),
    cwd: z.string().min(1).optional().describe('Absolute workspace path. Use instead of requestId to find requests.'),
    waitSeconds,
    detail,
    afterRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Opt into progress-triggered returns using the last revision; omit to wait for completion.'),
    outputOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Read full text from UTF-8 byte offset 0, then output.nextOffset while hasMore. Pages return immediately.'),
    outputLimit: z.number().int().min(4).max(64000).optional().describe('Page size in UTF-8 bytes; default 16000. Use with outputOffset.'),
  }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle((input, extra) => {
  if (Boolean(input.requestId) === Boolean(input.cwd)) throw new Error('Pass either requestId or cwd, not both.');
  if (input.cwd && (input.afterRevision !== undefined || input.outputOffset !== undefined || input.outputLimit !== undefined)) {
    throw new Error('afterRevision and output paging require requestId.');
  }
  if (input.outputLimit !== undefined && input.outputOffset === undefined) throw new Error('outputLimit requires outputOffset.');
  return input.requestId ? bridge.wait(bridge.get(input.requestId), input.waitSeconds, extra, false, input) : bridge.list(input.cwd);
}));

server.registerTool('grok_cancel', {
  description: 'Cancel a Grok turn through ACP. Returns cancelling until Grok stops; use grok_status to confirm. Existing edits are not rolled back.',
  inputSchema: z.object({ requestId, detail }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, handle(input => bridge.cancel(input.requestId, { detail: input.detail })));

server.registerTool('grok_setup', {
  description: 'Check the locally installed Grok Build binary and version. Does not read credentials or claim that authentication was verified.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle(setup));

server.server.onclose = () => bridge.close();
process.once('SIGTERM', () => { bridge.close(); void server.close(); });
process.once('SIGINT', () => { bridge.close(); void server.close(); });
process.stdin.once('end', () => { bridge.close(); void server.close(); });

if (process.argv.includes('--version')) console.log(`grok-ally ${pkg.version}`);
else if (process.argv.includes('--check')) {
  try { console.log(JSON.stringify(await setup(), null, 2)); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
} else await server.connect(new StdioServerTransport());
