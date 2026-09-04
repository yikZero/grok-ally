import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const fake = path.join(root, 'tests/fake-grok.mjs');
chmodSync(fake, 0o755);

async function fixture(t, previous) {
  const cwd = previous?.cwd || mkdtempSync(path.join(tmpdir(), 'grok bridge '));
  if (!previous) t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const log = path.join(cwd, 'events.jsonl');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'plugins/grok-bridge/dist/server.mjs')],
    env: { ...process.env, GROK_BINARY: fake, GROK_TEST_LOG: log }, stderr: 'pipe', cwd });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'bridge-test', version: '1' });
  await client.connect(transport);
  t.after(async () => { await client.close(); assert.equal(stderr, ''); });
  const call = (name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);
  const events = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const chat = async args => (await call('grok_chat', { cwd, ...args })).structuredContent;
  return { cwd, client, call, events, chat };
}

test('official MCP client: schemas, same-process conversation, defaults and isolated sessions', async t => {
  const f = await fixture(t);
  assert.equal(f.client.getServerVersion().version, pkg.version);
  for (const file of ['plugins/grok-bridge/.codex-plugin/plugin.json', 'claude/grok-bridge/.claude-plugin/plugin.json']) {
    assert.equal(JSON.parse(readFileSync(path.join(root, file), 'utf8')).version, pkg.version);
  }
  assert.deepEqual((await f.client.listTools()).tools.map(t => t.name), ['grok_chat', 'grok_status', 'grok_cancel', 'grok_setup']);
  assert.equal((await f.call('grok_chat', { prompt: 'missing cwd' })).isError, true);
  assert.equal((await f.call('grok_chat', { cwd: f.cwd, prompt: 'x', write: 'false' })).isError, true);
  assert.equal((await f.call('grok_chat', { cwd: '.', prompt: 'x' })).isError, true);
  const first = await f.chat({ prompt: '你好' });
  assert.equal(first.status, 'completed');
  assert.equal(first.text, '回答:你好');
  const second = await f.chat({ prompt: 'again', sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.text, '回答:again');
  assert.equal(f.events().filter(e => e.event === 'spawn').length, 1);
  assert.equal(f.events().filter(e => e.method === 'initialize').length, 1);
  assert.equal(f.events().find(e => e.method === 'initialize').params.clientInfo.version, pkg.version);
  assert.equal(f.events().filter(e => e.method === 'session/load').length, 0);
  const spawn = f.events()[0];
  assert.equal(spawn.cwd, realpathSync(f.cwd));
  assert.deepEqual(spawn.args.slice(0, 2), ['--sandbox', 'read-only']);
  assert.ok(spawn.args.includes('--no-leader'));
  assert.equal((await f.call('grok_chat', { cwd: f.cwd, prompt: 'change mode', sessionId: first.sessionId, write: true })).isError, true);
  const unrelated = await f.chat({ prompt: 'separate' });
  assert.notEqual(unrelated.sessionId, first.sessionId);
  const write = await f.chat({ prompt: 'authorized', write: true });
  assert.equal(write.write, true);
  assert.ok(f.events().filter(e => e.event === 'spawn').at(-1).args.includes('workspace'));
});

test('resume after MCP restart ignores replay; load failure never starts a new session', async t => {
  const one = await fixture(t);
  const first = await one.chat({ prompt: 'remember' });
  await one.client.close();
  const two = await fixture(t, one);
  const resumed = await two.chat({ prompt: 'continue', sessionId: first.sessionId });
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.text, '回答:continue');
  const failure = await two.chat({ prompt: 'must fail', sessionId: 'missing' });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.sessionId, 'missing');
  assert.equal(two.events().filter(e => e.method === 'session/new').length, 1);
  const idleExit = await two.chat({ prompt: 'idle-exit' });
  await delay(80);
  const reconnected = await two.chat({ prompt: 'reconnect', sessionId: idleExit.sessionId });
  assert.equal(reconnected.status, 'completed');
  assert.equal(reconnected.sessionId, idleExit.sessionId);
});

test('slow turns return handles, reject overlapping prompts and cancel via ACP', async t => {
  const f = await fixture(t);
  let job = await f.chat({ prompt: 'slow', waitSeconds: 0 });
  assert.ok(['starting', 'running'].includes(job.status));
  for (let i = 0; i < 30 && !job.sessionId; i++) {
    await delay(50);
    job = (await f.call('grok_status', { requestId: job.requestId, waitSeconds: 0 })).structuredContent;
  }
  assert.ok(job.sessionId);
  assert.equal((await f.call('grok_chat', { cwd: f.cwd, prompt: 'overlap', sessionId: job.sessionId })).isError, true);
  assert.equal((await f.call('grok_cancel', { requestId: job.requestId })).structuredContent.status, 'cancelling');
  const final = (await f.call('grok_status', { requestId: job.requestId })).structuredContent;
  assert.equal(final.status, 'cancelled');
  assert.equal(final.text, '回答:slow');
  assert.equal(f.events().filter(e => e.method === 'session/cancel').length, 1);
  assert.equal((await f.chat({ prompt: 'after cancel', sessionId: job.sessionId })).status, 'completed');
});

test('workspace status recovers handles, isolates projects and bounds finished results', async t => {
  const f = await fixture(t);
  const other = mkdtempSync(path.join(tmpdir(), 'other grok workspace '));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const list = async () => (await f.call('grok_status', { cwd: f.cwd })).structuredContent;
  assert.deepEqual(await list(), { cwd: realpathSync(f.cwd), active: [], recent: [] });
  assert.equal((await f.call('grok_status')).isError, true);
  assert.equal((await f.call('grok_status', { cwd: '.' })).isError, true);
  const active = await f.chat({ prompt: 'slow', waitSeconds: 0 });
  let finished = await f.chat({ prompt: 'done' });
  await f.chat({ cwd: other, prompt: 'unrelated private context' });
  for (let i = 0; i < 10; i++) finished = await f.chat({ prompt: `follow-up ${i}`, sessionId: finished.sessionId });
  const listing = await list();
  assert.deepEqual(listing.active.map(job => job.requestId), [active.requestId]);
  assert.equal(listing.recent.length, 10);
  assert.equal(listing.recent[0].requestId, finished.requestId);
  assert.ok(listing.recent.every(job => job.sessionId === finished.sessionId));
  for (const job of [...listing.active, ...listing.recent]) {
    assert.deepEqual(Object.keys(job).sort(), ['createdAt', 'requestId', 'sessionId', 'status', 'write']);
    assert.ok(Number.isFinite(Date.parse(job.createdAt)));
  }
  assert.equal((await f.call('grok_status', { cwd: f.cwd, requestId: active.requestId })).isError, true);
  await f.call('grok_cancel', { requestId: listing.active[0].requestId });
  assert.equal((await f.call('grok_status', { requestId: active.requestId })).structuredContent.status, 'cancelled');
  const afterCancel = await list();
  assert.deepEqual(afterCancel.active, []);
  assert.equal(afterCancel.recent[0].requestId, active.requestId);
});

test('MCP progress and cancellation reach a running Grok turn', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let progress = 0;
  const pending = f.call('grok_chat', { cwd: f.cwd, prompt: 'slow' }, {
    signal: controller.signal, onprogress: () => { progress++; controller.abort(); },
  });
  await assert.rejects(pending);
  await delay(150);
  assert.ok(progress > 0);
  assert.ok(f.events().some(e => e.method === 'session/cancel'));
});

test('turn limits, child errors, permission requests and output bounds fail honestly', async t => {
  const f = await fixture(t);
  assert.equal((await f.chat({ prompt: 'limit' })).status, 'incomplete');
  const failed = await f.chat({ prompt: 'error' });
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.error, /fake-secret/);
  assert.equal((await f.chat({ prompt: 'exit' })).status, 'failed');
  const huge = await f.chat({ prompt: 'huge' });
  assert.equal(huge.text.length, 64000);
  assert.equal(huge.truncated, true);
  const permission = await f.chat({ prompt: 'permission' });
  assert.equal(permission.status, 'completed');
  await delay(50);
  assert.ok(f.events().some(e => e.result?.outcome?.outcome === 'cancelled'));
});

test('closing the MCP client terminates its Grok process', async t => {
  const f = await fixture(t);
  await f.chat({ prompt: 'hello' });
  const pid = f.events().find(e => e.event === 'spawn').pid;
  await f.client.close();
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); await delay(50); } catch { return; }
  }
  assert.fail('Grok subprocess survived MCP close');
});

for (const unexpected of [false, true]) {
  test(`Grok descendants are cleaned up after ${unexpected ? 'unexpected exit' : 'MCP close'}`, { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t);
    await f.chat({ prompt: unexpected ? 'descendant-exit' : 'descendant' });
    const pid = f.events().find(e => e.event === 'descendant').pid;
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    if (!unexpected) await f.client.close();
    for (let i = 0; i < 60; i++) {
      try { process.kill(pid, 0); await delay(50); } catch { return; }
    }
    assert.fail('Grok descendant survived cleanup');
  });
}

test('aborting a status wait returns promptly without cancelling the Grok turn', async () => {
  const bridge = new Bridge();
  const controller = new AbortController();
  let finish;
  const job = { status: 'running', done: new Promise(resolve => { finish = resolve; }) };
  bridge.cancel = () => assert.fail('Status cancellation must not cancel the turn');
  const pending = bridge.wait(job, 25, { signal: controller.signal });
  controller.abort();
  try {
    const result = await Promise.race([pending, delay(500).then(() => 'still waiting')]);
    assert.equal(result.status, 'running');
    assert.equal(job.status, 'running');
  } finally { finish(); await pending; }
});
