import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.mjs';

function fixture(t) {
  class Session {
    constructor(options, update) { this.options = options; this.update = update; }
    async initialize() { this.sessionId = 'test-session'; return this.sessionId; }
    prompt() { return new Promise(resolve => { this.finish = stopReason => resolve({ stopReason }); }); }
    async cancel() { this.finish('cancelled'); }
    close() { this.finish?.('cancelled'); }
  }
  const bridge = new Bridge({ Session });
  t.after(() => bridge.close());
  const job = bridge.start({ cwd: tmpdir(), write: false, prompt: 'test' });
  const message = text => job.session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const tool = (id, status, extra = {}) => job.session.update({ sessionUpdate: 'tool_call', toolCallId: id, status, ...extra });
  return { bridge, job, message, tool };
}

test('incremental waits wake on visible progress and completion without replaying unchanged payloads', async t => {
  const { bridge, job, message, tool } = fixture(t);
  await delay(0);
  message('初始🙂');
  let prior = bridge.snapshot(job);
  const wait = query => bridge.wait(job, 60, undefined, false, query);
  const pending = wait({ afterRevision: prior.revision, outputOffset: prior.output.nextOffset });
  tool('read', 'in_progress', { title: 'Read config', locations: [{ path: '/project/config.json' }] });
  const next = await Promise.race([pending, delay(500).then(() => 'late')]);
  assert.notEqual(next, 'late');
  assert.equal(next.changed, true);
  assert.deepEqual(next.tools.map(t => t.id), ['read']);
  assert.equal(next.text, '');
  assert.equal(next.toolSummary.active, 1);
  prior = next;
  const idle = await bridge.wait(job, 0.02, undefined, false, { afterRevision: prior.revision });
  assert.equal(idle.changed, false);
  assert.equal(idle.text, undefined);
  assert.equal(idle.tools, undefined);
  assert.equal(idle.lastProgressAt, prior.lastProgressAt);
  job.session.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden' } });
  assert.equal(job.revision, prior.revision);
  const burst = wait({ afterRevision: prior.revision, outputOffset: prior.output.nextOffset });
  message('后续结论');
  await delay(20);
  message('，已验证');
  const delta = await burst;
  assert.equal(delta.text, '\n\n后续结论，已验证');
  assert.deepEqual(delta.tools, []);
  const backlog = await Promise.race([wait({ afterRevision: delta.revision, outputOffset: 0, outputLimit: 4 }), delay(500).then(() => 'late')]);
  assert.notEqual(backlog, 'late');
  assert.equal(backlog.changed, false);
  assert.equal(backlog.text, '初');
  const complete = wait({ afterRevision: delta.revision });
  job.session.finish('end_turn');
  assert.equal((await complete).status, 'completed');
  assert.equal(job.waiters.size, 0);
});

test('active tools survive 100 completions; tool-only cursor updates and cancellation stay accurate', async t => {
  const { bridge, job, tool } = fixture(t);
  await delay(0);
  tool('active', 'in_progress');
  for (let i = 0; i < 105; i++) tool(`done-${i}`, 'completed');
  let snapshot = bridge.snapshot(job);
  assert.equal(snapshot.toolSummary.active, 1);
  assert.equal(snapshot.toolSummary.dropped, 5);
  assert.ok(snapshot.tools.some(t => t.id === 'active'));
  job.session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'active', status: 'failed', title: 'Build failed' });
  const delta = await bridge.wait(job, 60, undefined, false, { afterRevision: snapshot.revision });
  assert.deepEqual(delta.tools.map(t => t.id), ['active']);
  assert.equal(delta.toolSummary.failed, 1);
  assert.equal(delta.text, undefined);
  tool('cancelled-tool', 'in_progress');
  bridge.cancel(job.requestId);
  await job.done;
  snapshot = bridge.snapshot(job);
  assert.equal(snapshot.status, 'cancelled');
  assert.equal(snapshot.toolSummary.active, 0);
  assert.equal(snapshot.toolSummary.unconfirmed, 1);
});

test('full output files have private permissions and are removed on eviction and shutdown', async t => {
  const { bridge, job, message } = fixture(t);
  await delay(0);
  message('Private fixture output');
  const directory = job.output.directory;
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(`${directory}/answer.txt`).mode & 0o777, 0o600);
  }
  job.session.finish('end_turn');
  await job.done;
  for (let i = 0; i < 100; i++) {
    const next = bridge.start({ cwd: tmpdir(), write: false, sessionId: job.sessionId, prompt: 'next' });
    await delay(0);
    next.session.finish('end_turn');
    await next.done;
  }
  assert.equal(existsSync(directory), false);
  assert.throws(() => bridge.get(job.requestId), /Unknown requestId/);
  const next = bridge.start({ cwd: tmpdir(), write: false, sessionId: job.sessionId, prompt: 'last' });
  await delay(0);
  next.session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'last' } });
  const lastDirectory = next.output.directory;
  bridge.close();
  assert.equal(existsSync(lastDirectory), false);
});

test('a storage error fails the turn and cancels Grok instead of reporting a complete answer', async t => {
  const { bridge, job, message } = fixture(t);
  await delay(0);
  message('Partial answer');
  job.output.append = () => { throw new Error('Disk full'); };
  message('Final answer');
  await job.done;
  const result = bridge.snapshot(job);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /retain complete output.*Disk full/);
  assert.equal(result.text, 'Partial answer');
});
