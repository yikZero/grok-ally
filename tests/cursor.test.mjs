import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CursorSession, cursorHandle, modelSelection } from '../src/cursor.mjs';
import { providerFor, sessionKey } from '../src/providers.mjs';
import { isAlive } from '../src/process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fake = path.join(root, 'tests/fake-cursor.mjs');
chmodSync(fake, 0o755);
async function fixture(t, { cwd = mkdtempSync(path.join(tmpdir(), 'ally-cursor-')), fault, provider } = {}) {
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const log = path.join(cwd, 'events.jsonl');
  const env = { ...process.env, CURSOR_BINARY: fake, CURSOR_TEST_LOG: log, GROK_BINARY: path.join(root, 'tests/fake-grok.mjs'), GROK_TEST_LOG: log };
  delete env.GROK_ALLY_ACTIVE; delete env.GROK_ALLY_PROVIDER; delete env.CURSOR_TEST_FAULT;
  if (fault) env.CURSOR_TEST_FAULT = fault;
  if (provider) env.GROK_ALLY_PROVIDER = provider;
  const c = new Client({ name: 'cursor-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'plugins/grok-ally/dist/server.mjs')], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  await c.connect(transport);
  t.after(async () => { await c.close(); assert.equal(stderr, ''); });
  const call = (name, args) => c.callTool({ name, arguments: args });
  const chat = async args => (await call('grok_chat', { cwd, provider: 'cursor', ...args })).structuredContent;
  const events = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  return { c, cwd, call, chat, events };
}

test('Cursor default model/mode are negotiated, continued, and restored after MCP restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('grok_setup', { provider: 'cursor' })).structuredContent.defaultModel, 'cursor-grok-4.6-xhigh');
  const first = await f.chat({ prompt: 'one' });
  assert.equal(first.status, 'completed'); assert.equal(first.provider, 'cursor'); assert.equal(first.text, 'Cursor:one');
  assert.equal(first.model, 'grok-4.6[effort=xhigh,fast=false]'); assert.equal(first.mode, 'ask');
  assert.equal(cursorHandle(first.sessionId).model, first.model);
  assert.deepEqual(f.events().find(e => e.event === 'spawn').args, ['--sandbox', 'enabled', 'acp']);
  assert.equal(f.events().find(e => e.event === 'spawn').recursive, '1');
  const second = await f.chat({ sessionId: first.sessionId, provider: undefined, prompt: 'two' });
  assert.equal(second.sessionId, first.sessionId); assert.equal(second.text, 'Cursor:two');
  assert.equal(f.events().filter(e => e.method === 'session/new').length, 1);
  assert.equal((await f.call('grok_chat', { cwd: f.cwd, sessionId: first.sessionId, provider: 'grok', prompt: 'wrong' })).isError, true);
  assert.equal((await f.chat({ prompt: 'write', write: true })).mode, 'agent');
  await f.c.close();
  const resumed = await fixture(t, { cwd: f.cwd, provider: 'grok' });
  const third = await resumed.chat({ sessionId: first.sessionId, provider: undefined, prompt: 'three' });
  assert.equal(third.sessionId, first.sessionId); assert.equal(third.text, 'Cursor:three');
  assert.ok(resumed.events().some(e => e.method === 'session/load' && e.params.sessionId === cursorHandle(first.sessionId).id));
  const missing = await resumed.chat({ sessionId: `cursor:missing:${Buffer.from(first.model).toString('base64url')}`, prompt: 'no' });
  assert.equal(missing.status, 'failed'); assert.equal(missing.error.includes('No such session'), true);
});

test('native Grok IDs survive a Cursor default; backend and creation arguments are explicit', async t => {
  const f = await fixture(t, { provider: 'cursor' });
  const implicit = await f.chat({ provider: undefined, prompt: 'default' });
  assert.equal(implicit.provider, 'cursor');
  const grok = await f.chat({ provider: 'grok', prompt: 'grok' });
  const same = await f.chat({ provider: undefined, sessionId: grok.sessionId, prompt: 'resume' });
  assert.equal(same.provider, 'grok'); assert.equal(same.text, '回答:resume');
  for (const args of [{ effort: 'high' }, { model: 'cursor-unknown' }, { sessionId: implicit.sessionId, model: 'grok-4.6' }]) {
    assert.equal((await f.call('grok_chat', { cwd: f.cwd, provider: 'cursor', prompt: 'bad', ...args })).isError, true);
  }
  const custom = await f.chat({ prompt: 'custom', model: 'grok-4.6[effort=high,fast=true]' });
  assert.equal(custom.model, 'grok-4.6[effort=high,fast=true]');
  assert.equal(providerFor({ sessionId: grok.sessionId }), 'grok');
  assert.throws(() => modelSelection('grok-4.6[mode=agent]'));
  assert.throws(() => cursorHandle('cursor:bad'));
});

test('ignored model/mode and authentication errors never send a user prompt', async t => {
  for (const fault of ['effort', 'fast', 'mode', 'auth']) {
    const f = await fixture(t, { fault });
    const r = await f.chat({ prompt: 'private prompt' });
    assert.equal(r.status, 'failed'); assert.equal(f.events().some(e => e.method === 'session/prompt'), false);
  }
  const f = await fixture(t);
  assert.equal((await f.chat({ prompt: 'invalid', model: 'unknown-model' })).status, 'failed');
  assert.equal(f.events().some(e => e.method === 'session/prompt'), false);
});

test('Cursor permissions stay within mode; questions and plans return without inventing answers', async t => {
  const f = await fixture(t);
  for (const write of [false, true]) {
    const r = await f.chat({ prompt: 'permissions', write });
    assert.equal(r.status, 'completed');
    const outcomes = JSON.parse(r.text.slice(r.text.indexOf('{')));
    assert.equal(outcomes.read.outcome.optionId, 'once');
    for (const kind of ['edit', 'execute']) assert.equal(outcomes[kind].outcome.outcome, write ? 'selected' : 'cancelled');
    assert.equal(outcomes.other.outcome.outcome, 'cancelled');
    assert.equal(outcomes.question.outcome.outcome, 'skipped'); assert.equal(outcomes.plan.outcome.outcome, 'rejected');
    assert.ok(r.text.includes('cannot answer interactive'));
  }
});

test('Cursor cancellation retires its process tree without session/close and can resume', async t => {
  const f = await fixture(t);
  const r = await f.chat({ prompt: 'slow', write: true, waitSeconds: 1 });
  assert.equal(r.status, 'running');
  assert.equal(sessionKey(r.sessionId), `cursor:${cursorHandle(r.sessionId).id}`);
  const cancelled = (await f.call('grok_cancel', { requestId: r.requestId })).structuredContent;
  assert.equal(cancelled.status, 'cancelling');
  const end = (await f.call('grok_status', { requestId: r.requestId, waitSeconds: 10 })).structuredContent;
  assert.equal(end.status, 'cancelled'); assert.equal(end.cleanup.state, 'confirmed');
  for (const e of f.events().filter(e => ['spawn', 'descendant'].includes(e.event))) {
    for (let i = 0; i < 20 && isAlive(e.pid); i++) await delay(25);
    assert.equal(isAlive(e.pid), false);
  }
  assert.equal(f.events().some(e => e.method === 'session/close'), false);
  const resumed = await f.chat({ prompt: 'after cancel', sessionId: r.sessionId, write: true });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.sessionId, r.sessionId);
});

test('Cursor rejects permission requests after cancellation and from another session', () => {
  const state = { prompting: true, nativeSessionId: 'current', options: { write: true } };
  const params = { sessionId: 'current', toolCall: { kind: 'execute' }, options: [{ kind: 'allow_once', optionId: 'once' }] };
  assert.equal(CursorSession.prototype.permission.call(state, params).outcome.optionId, 'once');
  assert.equal(CursorSession.prototype.permission.call(state, { ...params, sessionId: 'other' }).outcome.outcome, 'cancelled');
  state.cancelling = true;
  assert.equal(CursorSession.prototype.permission.call(state, params).outcome.outcome, 'cancelled');
});
