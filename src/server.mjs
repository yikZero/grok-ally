#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { Bridge } from './bridge.mjs';
import { safeError, setup } from './grok.mjs';

if (process.env.GROK_BRIDGE_ACTIVE === '1') {
  console.error('Recursive Grok Bridge launch blocked. Call the bridge from the host MCP client.');
  process.exit(1);
}

const bridge = new Bridge();
const server = new McpServer({ name: 'grok-bridge', version: '0.1.0' });
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
    maxTurns: z.number().int().min(1).max(100).default(20),
    model: z.string().min(1).max(200).optional().describe('New sessions only. Omit for Grok native default.'),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional().describe('New sessions only.'),
    waitSeconds,
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, handle((input, extra) => bridge.wait(bridge.start(input), input.waitSeconds, extra, true)));

server.registerTool('grok_status', {
  description: 'Read a turn result or wait up to 25 seconds. Repeat while starting/running/cancelling. Keep sessionId for follow-ups. Results are retained in this MCP process for the last 100 turns.',
  inputSchema: z.object({ requestId, waitSeconds }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle((input, extra) => bridge.wait(bridge.get(input.requestId), input.waitSeconds, extra)));

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

if (process.argv.includes('--version')) console.log('grok-bridge 0.1.0');
else if (process.argv.includes('--check')) {
  try { console.log(JSON.stringify(await setup(), null, 2)); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
} else await server.connect(new StdioServerTransport());
