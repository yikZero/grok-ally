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
import { Output } from '../src/output.mjs';
import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const fake = path.join(root, 'tests/fake-grok.mjs');
chmodSync(fake, 0o755);

async function fixture(t, previous) {
  const cwd = previous?.cwd || mkdtempSync(path.join(tmpdir(), 'grok ally '));
  if (!previous) t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const log = path.join(cwd, 'events.jsonl');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'plugins/grok-ally/dist/server.mjs')],
    env: { ...process.env, GROK_BINARY: fake, GROK_TEST_LOG: log, GROK_SUBAGENTS: '1' }, stderr: 'pipe', cwd });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'bridge-test', version: '1' });
  await client.connect(transport);
  t.after(async () => { await client.close(); assert.equal(stderr, ''); });
  // Exercise the full diagnostic contract in the existing suite; compact defaults have separate checks below.
  const call = (name, args = {}, options) => client.callTool({ name,
    arguments: { ...(['grok_chat', 'grok_status', 'grok_cancel'].includes(name) ? { detail: 'full' } : {}), ...args } }, undefined, options);
  const events = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const chat = async args => (await call('grok_chat', { cwd, ...args })).structuredContent;
  return { cwd, client, call, events, chat };
}

test('official MCP client: schemas, same-process conversation, defaults and isolated sessions', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.client.getServerVersion(), { name: pkg.name, version: pkg.version });
  for (const file of ['plugins/grok-ally/.codex-plugin/plugin.json', 'claude/grok-ally/.claude-plugin/plugin.json']) {
    assert.equal(JSON.parse(readFileSync(path.join(root, file), 'utf8')).version, pkg.version);
  }
  assert.deepEqual((await f.client.listTools()).tools.map(t => t.name), ['grok_chat', 'grok_status', 'grok_cancel', 'grok_setup']);
  assert.equal((await f.call('grok_chat', { prompt: 'missing cwd' })).isError, true);
  assert.equal((await f.call('grok_chat', { cwd: f.cwd, prompt: 'x', write: 'false' })).isError, true);
  assert.equal((await f.call('grok_chat', { cwd: '.', prompt: 'x' })).isError, true);
  assert.equal((await f.call('grok_chat', { cwd: f.cwd, prompt: 'x', maxTurns: 1 })).isError, true);
  const first = await f.chat({ prompt: '你好' });
  assert.equal(first.status, 'completed');
  assert.equal(first.text, '回答:你好');
  const second = await f.chat({ prompt: 'again', sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.text, '回答:again');
  assert.equal(f.events().filter(e => e.event === 'spawn').length, 1);
  assert.equal(f.events().filter(e => e.method === 'initialize').length, 1);
  assert.equal(f.events().find(e => e.method === 'initialize').params.clientInfo.version, pkg.version);
  assert.deepEqual(f.events().find(e => e.method === 'initialize').params._meta.bufferingSettings,
    { maxItems: 100, maxBytes: 16384, maxDurationMs: 200 });
  assert.equal(f.events().filter(e => e.method === 'session/load').length, 0);
  const spawn = f.events()[0];
  assert.equal(spawn.cwd, realpathSync(f.cwd));
  assert.deepEqual(spawn.args.slice(0, 2), ['--sandbox', 'read-only']);
  assert.ok(spawn.args.includes('--no-leader'));
  assert.equal(spawn.args.includes('--max-turns'), false);
  assert.equal(spawn.subagents, '0');
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

test('explicit model and effort mismatches fail before sending the prompt', async t => {
  const f = await fixture(t);
  const valid = await f.chat({ prompt: 'selected', model: 'grok-4.5', effort: 'xhigh' });
  assert.equal(valid.status, 'completed');
  assert.equal((await f.chat({ prompt: 'configured', model: 'config-model', effort: 'low' })).status, 'completed');
  const before = f.events().filter(e => e.method === 'session/prompt').length;
  const missing = await f.chat({ prompt: 'must not send', model: 'missing-model' });
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /model.*missing-model.*grok-4\.6/i);
  const ignored = await f.chat({ prompt: 'must not send', model: 'grok-4.6', effort: 'minimal' });
  assert.equal(ignored.status, 'failed');
  assert.match(ignored.error, /effort.*minimal.*high/i);
  assert.equal(f.events().filter(e => e.method === 'session/prompt').length, before);
});

test('text around tool calls stays separated while streamed chunks stay joined', async t => {
  const f = await fixture(t);
  const result = await f.chat({ prompt: 'text-around-tools' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Before tools.\n\nAfter tools.');
  assert.deepEqual(result.tools.map(tool => tool.status), ['completed']);
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
    assert.deepEqual(Object.keys(job).sort(), ['createdAt', 'finishedAt', 'lastProgressAt', 'requestId', 'revision', 'sessionId', 'status', 'write']);
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
  assert.equal(huge.text.length, 16000);
  assert.equal(huge.truncated, true);
  assert.ok(huge.text.endsWith('FINAL_CONCLUSION'));
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
  const job = { status: 'running', tools: [], toolTotals: { total: 0, failed: 0, unconfirmed: 0 },
    waiters: new Set(), output: new Output(), done: new Promise(resolve => { finish = resolve; }) };
  bridge.cancel = () => assert.fail('Status cancellation must not cancel the turn');
  const pending = bridge.wait(job, 25, { signal: controller.signal });
  controller.abort();
  try {
    const result = await Promise.race([pending, delay(500).then(() => 'still waiting')]);
    assert.equal(result.status, 'running');
    assert.equal(job.status, 'running');
  } finally { finish(); await pending; }
});

test('long tool histories retain recent actions and disclose unconfirmed completion', async t => {
  const f = await fixture(t);
  const result = await f.chat({ prompt: 'many-tools' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.toolSummary, { total: 132, failed: 13, unconfirmed: 1, active: 0, unfinished: 1, dropped: 31 });
  assert.equal(result.tools.length, 101);
  assert.ok(result.tools.some(t => t.id === 'tool-129'));
  assert.equal(result.tools.find(t => t.id === 'held').status, 'completed');
  const unclosed = result.tools.find(t => t.id === 'unclosed');
  assert.equal(unclosed.status, 'unconfirmed');
  assert.equal(unclosed.reportedStatus, 'in_progress');
  assert.equal(unclosed.finishedAt, null);
  assert.deepEqual(unclosed.locations, [{ path: '/project/实现.mjs', line: 7 }]);
  assert.doesNotMatch(JSON.stringify(result), /fake-secret|SECRET_INPUT/);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.lastProgressAt));
  await delay(30);
  const later = (await f.call('grok_status', { requestId: result.requestId, waitSeconds: 0 })).structuredContent;
  assert.deepEqual(later.tools, result.tools);
});

test('full Unicode output pages reconstruct every chunk and final answer over MCP', async t => {
  const f = await fixture(t);
  const result = await f.chat({ prompt: 'unicode-output' });
  assert.equal(result.status, 'completed');
  assert.ok(result.text.endsWith('\n最终结论：全部通过。'));
  assert.equal(result.truncated, true);
  const expected = Array.from({ length: 40 }, (_, i) => `第${i}段🙂` + '正文'.repeat(1000)).join('') + '\n最终结论：全部通过。';
  const read = args => f.call('grok_status', { requestId: result.requestId, ...args });
  let offset = 0, actual = '';
  do {
    const page = (await read({ outputOffset: offset, outputLimit: 7001 })).structuredContent;
    assert.equal(page.output.offset, offset);
    assert.ok(page.output.nextOffset > offset);
    assert.ok(Buffer.byteLength(page.text) <= 7001);
    assert.equal(page.output.totalBytes, Buffer.byteLength(expected));
    actual += page.text;
    offset = page.output.nextOffset;
    assert.equal(page.output.hasMore, offset < Buffer.byteLength(expected));
  } while (offset < Buffer.byteLength(expected));
  assert.equal(actual, expected);
  assert.equal((await read({ outputOffset: offset })).structuredContent.text, '');
  assert.equal((await read({ outputOffset: 1 })).isError, true);
  assert.equal((await read({ outputOffset: offset + 1 })).isError, true);
  assert.equal((await read({ outputLimit: 50 })).isError, true);
  assert.equal((await f.call('grok_status', { cwd: f.cwd, afterRevision: 0 })).isError, true);
  const unchanged = (await read({ afterRevision: result.revision, waitSeconds: 60 })).structuredContent;
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.text, undefined);
  assert.equal(unchanged.tools, undefined);
  assert.equal((await read({ afterRevision: result.revision + 1 })).isError, true);
});

test('compact defaults keep status useful without streaming text or full tool history', async t => {
  const f = await fixture(t);
  const call = async (name, args) => {
    const result = await f.client.callTool({ name, arguments: args });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result;
  };
  let job = (await call('grok_chat', { cwd: f.cwd, prompt: 'slow', waitSeconds: 0 })).structuredContent;
  while (!job.sessionId || job.status === 'starting') {
    job = (await call('grok_status', { requestId: job.requestId, afterRevision: job.revision })).structuredContent;
  }
  assert.equal(job.text, undefined);
  assert.equal(job.tools, undefined);
  assert.equal(job.cwd, undefined);
  assert.ok(job.toolSummary);
  assert.ok(job.lastProgressAt);
  const full = (await call('grok_status', { requestId: job.requestId, detail: 'full', waitSeconds: 0 })).structuredContent;
  assert.equal(full.text, '回答:slow');
  assert.equal(full.cwd, realpathSync(f.cwd));
  const unchanged = (await call('grok_status', { requestId: job.requestId, afterRevision: full.revision, waitSeconds: 0 })).structuredContent;
  assert.deepEqual(Object.keys(unchanged).sort(), ['changed', 'requestId', 'revision', 'sessionId', 'status']);
  await call('grok_cancel', { requestId: job.requestId });
  const cancelled = (await call('grok_status', { requestId: job.requestId })).structuredContent;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.text, '回答:slow');
  assert.ok(cancelled.finishedAt);
  const incomplete = await call('grok_chat', { cwd: f.cwd, prompt: 'limit' });
  assert.equal(incomplete.isError, true);
  assert.equal(incomplete.structuredContent.status, 'incomplete');
  assert.equal(incomplete.structuredContent.text, '回答:limit');
});

test('compact answers and pages preserve all text without repeating diagnostic history', async t => {
  const f = await fixture(t);
  const result = await f.chat({ prompt: 'many-tools', detail: 'compact' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'All done.');
  assert.equal(result.tools, undefined);
  assert.equal(result.toolSummary.total, 132);
  assert.equal(result.toolSummary.unconfirmed, 1);
  const full = (await f.call('grok_status', { requestId: result.requestId, detail: 'full' })).structuredContent;
  assert.equal(full.tools.length, 101);
  const page = (await f.call('grok_status', { requestId: result.requestId, outputOffset: 0, detail: 'compact' })).structuredContent;
  assert.equal(page.text, result.text);
  assert.equal(page.tools, undefined);
  assert.equal(page.toolSummary, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(full)) / 10);
  const failed = await f.chat({ prompt: 'error', detail: 'compact' });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error);
  assert.doesNotMatch(failed.error, /fake-secret/);
});
