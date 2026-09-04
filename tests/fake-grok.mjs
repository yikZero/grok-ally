#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.argv.includes('--version')) { console.log('grok 1.0.13 (test)'); process.exit(0); }
const log = data => appendFileSync(process.env.GROK_TEST_LOG, JSON.stringify(data) + '\n');
log({ event: 'spawn', pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), subagents: process.env.GROK_SUBAGENTS });
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
const reply = (id, result) => send({ id, result });
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const model = argument('--model') === 'grok-4.5' ? 'grok-4.5' : 'grok-4.6';
const effort = process.argv.includes('--reasoning-effort') && argument('--reasoning-effort') !== 'minimal'
  ? argument('--reasoning-effort') : 'high';
const chunk = (sessionId, text) => send({ method: 'session/update', params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} });
let active;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  log({ method, params, result: message.result, pid: process.pid });
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (method === 'session/new' && argument('--model') === 'config-model') return reply(id, {
    sessionId: randomUUID(), configOptions: [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'config-model', options: [{ value: 'config-model', name: 'Config model' }] },
      { id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: effort, options: [{ value: effort, name: effort }] },
    ],
  });
  if (method === 'session/new') return reply(id, { sessionId: randomUUID(),
    models: { currentModelId: model, availableModels: [
      { modelId: model, name: model, _meta: { reasoningEffort: effort } },
    ] } });
  if (method === 'session/load') {
    if (params.sessionId === 'missing') return send({ id, error: { code: -32602, message: 'No such session' } });
    chunk(params.sessionId, 'REPLAY MUST NOT LEAK');
    return reply(id, {});
  }
  if (method === 'session/cancel') {
    if (active) { reply(active.id, { stopReason: 'cancelled' }); active = null; }
    return;
  }
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text === 'text-around-tools') {
      chunk(params.sessionId, 'Before ');
      chunk(params.sessionId, 'tools.');
      send({ method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', status: 'in_progress' } } });
      chunk(params.sessionId, '');
      send({ method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' } } });
      chunk(params.sessionId, 'After ');
      chunk(params.sessionId, 'tools.');
      return reply(id, { stopReason: 'end_turn' });
    }
    if (text === 'exit') return process.exit(7);
    if (text === 'error') return send({ id, error: { code: -32603, message: 'Bearer fake-secret xai-fake-secret' } });
    // Unicode and unrelated session notifications exercise the real SDK transport.
    chunk('unrelated-session', 'WRONG SESSION');
    chunk(params.sessionId, text === 'huge' ? 'x'.repeat(70000) : `回答:${text}`);
    send({ method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE THOUGHT' } } } });
    if (text === 'slow') { active = { id }; return; }
    if (text.startsWith('descendant')) {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => {
        log({ event: 'descendant', pid: child.pid });
        reply(id, { stopReason: 'end_turn' });
        if (text === 'descendant-exit') setTimeout(() => process.exit(7), 20);
      });
      return;
    }
    if (text === 'permission') send({ id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: params.sessionId, toolCall: { toolCallId: 'write', title: 'Write' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    } });
    reply(id, { stopReason: text === 'limit' ? 'max_turn_requests' : 'end_turn' });
    if (text === 'idle-exit') setTimeout(() => process.exit(), 20);
    return;
  }
});
process.stdin.on('end', () => process.exit());
