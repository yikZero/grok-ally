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
const waitSeconds = z.number().int().min(0).max(25).default(25);
const requestId = z.string().uuid();
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data, isError: data.status === 'failed' || data.status === 'incomplete' });
const handle = fn => async (...args) => {
  try { return result(await fn(...args)); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: safeError(error) }] }; }
};

server.registerTool('grok_chat', {
  description: 'Send a message to Grok Build. Omit sessionId to start; pass the returned sessionId to continue. Always supply the real workspace cwd. Default read-only; write=true authorizes workspace edits. If status is starting/running, poll grok_status with requestId. No host transcript is imported.',
  inputSchema: z.object({
    prompt: z.string().trim().min(1).max(100000),
    cwd: z.string().min(1),
    sessionId: z.string().min(1).max(200).optional(),
    write: z.boolean().default(false),
    model: z.string().min(1).max(200).optional().describe('New sessions only. Exact model ID from grok models; omit for the native default.'),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional().describe('New sessions only. Must be honored by the selected Grok model.'),
    waitSeconds,
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, handle((input, extra) => bridge.wait(bridge.start(input), input.waitSeconds, extra, true)));

server.registerTool('grok_status', {
  description: 'Pass requestId to read a turn or wait up to 25 seconds; repeat while starting/running/cancelling. Pass cwd instead to immediately list all active and the 10 most recent finished requests for that exact workspace. Listings contain IDs and status, not message text. Results exist only in this MCP process; keep sessionId for follow-ups.',
  inputSchema: z.object({ requestId: requestId.optional(),
    cwd: z.string().min(1).optional().describe('Absolute workspace path. Use instead of requestId to find requests.'),
    waitSeconds }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle((input, extra) => {
  if (Boolean(input.requestId) === Boolean(input.cwd)) throw new Error('Pass either requestId or cwd, not both.');
  return input.requestId ? bridge.wait(bridge.get(input.requestId), input.waitSeconds, extra) : bridge.list(input.cwd);
}));

server.registerTool('grok_cancel', {
  description: 'Cancel a Grok turn through ACP. Returns cancelling until Grok stops; use grok_status to confirm. Existing edits are not rolled back.',
  inputSchema: z.object({ requestId }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, handle(input => bridge.cancel(input.requestId)));

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
