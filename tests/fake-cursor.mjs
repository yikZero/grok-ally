#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('cursor test'); process.exit(); }
if (process.argv.includes('--help')) { console.log('Cursor Agent acp'); process.exit(); }
const log = data => appendFileSync(process.env.CURSOR_TEST_LOG, JSON.stringify(data) + '\n');
log({ event: 'spawn', pid: process.pid, args: process.argv.slice(2), recursive: process.env.GROK_ALLY_ACTIVE });
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, message) => send({ id, error: { code: -32602, message } });
const values = { mode: 'agent', model: 'grok-4.6', effort: 'high', fast: 'true' };
const choices = { mode: ['agent', 'ask'], model: ['grok-4.6', 'composer-2.5'], effort: ['high', 'xhigh'], fast: ['false', 'true'] };
const config = () => Object.entries(values).map(([id, currentValue]) => ({ id, name: id, currentValue, type: 'select',
  category: id === 'effort' ? 'thought_level' : id === 'fast' ? 'model_config' : id,
  options: choices[id].map(value => ({ value, name: value })) }));
const chunk = (sessionId, text) => send({ method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let active;
const waiting = new Map();
function request(method, params) {
  const id = randomUUID();
  return new Promise(resolve => { waiting.set(id, resolve); send({ id, method, params }); });
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params, result, error } = JSON.parse(line);
  log({ method, params, result, error });
  if (!method) { waiting.get(id)?.(result || error); waiting.delete(id); return; }
  if (method === 'initialize') return reply(id, { protocolVersion: 1,
    agentCapabilities: { loadSession: true }, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] });
  if (method === 'authenticate') return process.env.CURSOR_TEST_FAULT === 'auth' ? fail(id, 'Not logged in') : reply(id, {});
  if (method === 'session/new') return reply(id, { sessionId: randomUUID(), configOptions: config() });
  if (method === 'session/load') {
    if (params.sessionId === 'missing') return fail(id, 'No such session');
    chunk(params.sessionId, 'REPLAY MUST NOT LEAK');
    return reply(id, { configOptions: config() });
  }
  if (method === 'session/set_config_option') {
    if (process.env.CURSOR_TEST_FAULT !== params.configId) values[params.configId] = params.value;
    return reply(id, { configOptions: config() });
  }
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text === 'permissions') {
      const outcomes = {};
      for (const kind of ['read', 'edit', 'execute', 'other']) {
        outcomes[kind] = await request('session/request_permission', { sessionId: params.sessionId,
          toolCall: { toolCallId: kind, title: kind, kind }, options: [
            { optionId: 'persistent', kind: 'allow_always', name: 'Always' }, { optionId: 'once', kind: 'allow_once', name: 'Once' }] });
      }
      outcomes.question = await request('cursor/ask_question', { questions: [] });
      outcomes.plan = await request('cursor/create_plan', { plan: 'x' });
      chunk(params.sessionId, JSON.stringify(outcomes));
    } else if (text === 'slow') {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      log({ event: 'descendant', pid: child.pid });
      active = id;
      return;
    } else chunk(params.sessionId, 'Cursor:' + text);
    return reply(id, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel' && active) { reply(active, { stopReason: 'cancelled' }); active = null; return; }
  if (id !== undefined) fail(id, 'Unsupported: ' + method);
});
process.stdin.on('end', () => process.exit());
