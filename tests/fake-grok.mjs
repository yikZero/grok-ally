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
const spawned = [];
let active;
let closeHang = false;
let closeNoop = false;
let closeDelay = 0;
let delaySpawn = false;

function spawnTree({ detached = false, stubborn = false } = {}) {
  const ignore = stubborn ? 'process.on("SIGTERM",()=>{});' : '';
  const leaf = `${ignore}if(process.send)process.send({pid:process.pid});setInterval(()=>{},1000);`;
  const code = `${ignore}const {spawn}=require("child_process");const g=spawn(process.execPath,["-e",${JSON.stringify(leaf)}],{stdio:["ignore","ignore","ignore","ipc"]});g.once("message",msg=>{if(process.send)process.send({pid:process.pid,grandchild:msg.pid});});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], {
    detached, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  spawned.push(child);
  child.once('message', msg => {
    log({ event: 'descendant', pid: child.pid, grandchild: msg.grandchild, detached, stubborn });
  });
  if (detached) child.unref();
  return child;
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  log({ method, params, result: message.result, pid: process.pid });
  if (method === 'initialize') {
    const payload = { protocolVersion: 1, agentCapabilities: {
      loadSession: true, sessionCapabilities: process.env.GROK_TEST_NO_CLOSE ? {} : { close: {} },
    }, authMethods: [] };
    if (process.env.GROK_TEST_SLOW_INIT) {
      setTimeout(() => reply(id, payload), Number(process.env.GROK_TEST_SLOW_INIT) || 2000);
      return;
    }
    return reply(id, payload);
  }
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
    if (delaySpawn) setTimeout(() => spawnTree({ detached: true }), 80);
    if (active) { reply(active.id, { stopReason: 'cancelled' }); active = null; }
    return;
  }
  if (method === 'session/close') {
    if (closeHang) return;
    const finish = () => {
      if (!closeNoop) {
        for (const child of spawned) {
          try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {}
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
      }
      reply(id, { _meta: { 'x.ai/closeOutcome': 'closed' } });
    };
    if (closeDelay) setTimeout(finish, closeDelay);
    else finish();
    return;
  }
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text === 'many-tools') {
      const tool = update => send({ method: 'session/update', params: { sessionId: params.sessionId, update } });
      tool({ sessionUpdate: 'tool_call', toolCallId: 'held', title: 'Long build', status: 'in_progress' });
      for (let i = 0; i < 130; i++) {
        tool({ sessionUpdate: 'tool_call', toolCallId: `tool-${i}`, title: `Read ${i}`, status: 'in_progress' });
        tool({ sessionUpdate: 'tool_call_update', toolCallId: `tool-${i}`, status: i % 10 === 0 ? 'failed' : 'completed' });
      }
      tool({ sessionUpdate: 'tool_call_update', toolCallId: 'held', status: 'completed' });
      tool({ sessionUpdate: 'tool_call', toolCallId: 'unclosed', title: 'Read Bearer fake-secret', status: 'in_progress',
        locations: [{ path: '/project/实现.mjs', line: 7 }], rawInput: { secret: 'SECRET_INPUT' } });
      chunk(params.sessionId, 'All done.');
      return reply(id, { stopReason: 'end_turn' });
    }
    if (text === 'failed-evicted') {
      const tool = update => send({ method: 'session/update', params: { sessionId: params.sessionId, update } });
      tool({ sessionUpdate: 'tool_call', toolCallId: 'boom', title: 'Compile', status: 'in_progress',
        rawInput: { token: 'SECRET_INPUT' } });
      tool({ sessionUpdate: 'tool_call_update', toolCallId: 'boom', status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'exit 1: missing file\u0007 Bearer fake-secret' } }],
        rawOutput: { log: 'SECRET_OUTPUT', stack: 'x'.repeat(5000) } });
      for (let i = 0; i < 110; i++) {
        tool({ sessionUpdate: 'tool_call', toolCallId: `ok-${i}`, title: `Read ${i}`, status: 'in_progress' });
        tool({ sessionUpdate: 'tool_call_update', toolCallId: `ok-${i}`, status: 'completed',
          rawOutput: { ok: true, secret: 'SECRET_OUTPUT' } });
      }
      send({ method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE THOUGHT' } } } });
      chunk(params.sessionId, 'Finished despite a failed compile.');
      return reply(id, { stopReason: 'end_turn' });
    }
    if (text === 'failed-then-recovered') {
      const tool = update => send({ method: 'session/update', params: { sessionId: params.sessionId, update } });
      tool({ sessionUpdate: 'tool_call', toolCallId: 'build', title: 'Build', status: 'in_progress' });
      tool({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'compiler error: missing header' } }] });
      tool({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'in_progress' });
      tool({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'completed' });
      chunk(params.sessionId, 'Rebuilt.');
      return reply(id, { stopReason: 'end_turn' });
    }
    if (text === 'unicode-output') {
      for (let i = 0; i < 40; i++) chunk(params.sessionId, `第${i}段🙂` + '正文'.repeat(1000));
      chunk(params.sessionId, '\n最终结论：全部通过。');
      return reply(id, { stopReason: 'end_turn' });
    }
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
    chunk(params.sessionId, text === 'huge' ? 'x'.repeat(70000) + 'FINAL_CONCLUSION' : `回答:${text}`);
    send({ method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE THOUGHT' } } } });
    if (text === 'self-cancel') {
      chunk(params.sessionId, 'stopping');
      return reply(id, { stopReason: 'cancelled' });
    }
    if (text === 'slow') { active = { id }; return; }
    if (text.startsWith('slow-')) {
      if (text === 'slow-close-hang') { closeHang = true; spawnTree({ detached: false }); }
      if (text === 'slow-close-noop') { closeNoop = true; spawnTree({ detached: true }); }
      if (text === 'slow-delay-spawn') delaySpawn = true;
      if (text === 'slow-false-bg') {
        const pid = Number(process.env.GROK_TEST_FALSE_PID);
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call', toolCallId: 'bg-false', title: 'run', status: 'in_progress', kind: 'execute',
        } } });
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'bg-false', status: 'completed',
          title: '[bg] node (falsepid)',
          rawOutput: { type: 'BackgroundTaskStarted', pid, task_id: randomUUID(), status: 'running' },
        } } });
      }
      if (text === 'slow-tree' || text === 'slow-stubborn' || text === 'slow-detached') {
        if (text === 'slow-tree') closeDelay = 250;
        if (text === 'slow-stubborn') closeNoop = true;
        const child = spawnTree({
          detached: text !== 'slow-tree', stubborn: text === 'slow-stubborn',
        });
        if (text === 'slow-detached') {
          child.once('message', () => {
            send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
              sessionUpdate: 'tool_call', toolCallId: 'bg-1', title: 'run', status: 'in_progress', kind: 'execute',
            } } });
            send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'bg-1', status: 'completed',
              title: '[bg] node (testdetached)',
              rawOutput: { type: 'BackgroundTaskStarted', pid: child.pid, task_id: randomUUID(), status: 'running' },
            } } });
          });
        }
      }
      active = { id };
      return;
    }
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
