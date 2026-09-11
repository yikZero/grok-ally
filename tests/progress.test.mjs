import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.mjs';
import { HISTORY_PAGE_BYTES } from '../src/history.mjs';

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

test('compact tool state, failure recovery, history paging, and private history cleanup', async t => {
  const { bridge, job, message, tool } = fixture(t);
  await delay(0);
  const failedContent = { content: [{ type: 'content', content: { type: 'text',
    text: 'exit 1: missing file\u0007 Bearer fake-secret' } }], rawOutput: { log: 'SECRET_OUTPUT' } };
  tool('boom', 'failed', { title: 'Compile', ...failedContent });
  for (let i = 0; i < 105; i++) tool(`ok-${i}`, 'completed', { rawOutput: { secret: 'SECRET_OUTPUT' } });
  let snapshot = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(snapshot.toolSummary.state, 'confirmed');
  assert.equal(snapshot.toolSummary.dropped, 6);
  assert.equal(snapshot.latestFailure.id, 'boom');
  assert.equal(snapshot.latestFailure.recovery, 'unknown');
  assert.match(snapshot.latestFailure.reason, /exit 1: missing file/);
  assert.doesNotMatch(JSON.stringify(snapshot), /fake-secret|SECRET_OUTPUT|\u0007/);
  job.session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'other', status: 'completed' });
  assert.equal(bridge.snapshot(job, { detail: 'compact' }).latestFailure.recovery, 'unknown');
  job.session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'boom', status: 'completed' });
  snapshot = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(snapshot.latestFailure.recovery, 'completed');
  assert.equal(snapshot.tools, undefined);
  const historyDir = job.history.directory;
  if (process.platform !== 'win32') {
    assert.equal(statSync(historyDir).mode & 0o777, 0o700);
    assert.equal(statSync(`${historyDir}/history.jsonl`).mode & 0o777, 0o600);
  }
  const page = bridge.snapshot(job, { toolLimit: 20 });
  assert.equal(page.text, undefined);
  assert.equal(page.toolHistory.offset, 0);
  assert.equal(page.toolHistory.records[0].id, 'boom');
  assert.equal(page.toolHistory.records[0].status, 'failed');
  assert.equal(page.toolHistory.records[0].reason.includes('fake-secret'), false);
  const later = bridge.snapshot(job, { toolOffset: page.toolHistory.nextOffset });
  assert.equal(later.toolHistory.offset, 20);
  assert.equal(later.toolHistory.records[0].record, 20);
  for (let i = 0; i < 4; i++) tool(`open-${i}`, 'in_progress');
  job.session.finish('end_turn');
  await job.done;
  snapshot = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.toolSummary.state, 'unconfirmed');
  assert.equal(snapshot.unconfirmedTools.length, 3);
  assert.equal(snapshot.latestFailure.recovery, 'completed');
  const unconfirmed = bridge.snapshot(job, { toolOffset: snapshot.toolSummary.historyRecords - 4, toolLimit: 4 });
  assert.deepEqual(unconfirmed.toolHistory.records.map(record => record.status),
    ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed']);
  for (let i = 0; i < 100; i++) {
    const next = bridge.start({ cwd: tmpdir(), write: false, sessionId: job.sessionId, prompt: 'next' });
    await delay(0);
    next.session.finish('end_turn');
    await next.done;
  }
  assert.equal(existsSync(historyDir), false);
});

test('a tool-history storage error fails the turn instead of dropping snapshots', async t => {
  const { bridge, job, tool } = fixture(t);
  await delay(0);
  job.history.append = () => { throw new Error('Disk full'); };
  tool('boom', 'failed', { title: 'Compile' });
  await job.done;
  const result = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /retain tool history.*Disk full/);
});

test('a later failed update without content keeps the same tool reason', async t => {
  const { bridge, job, tool } = fixture(t);
  await delay(0);
  tool('read', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'File not found: missing.txt' } }] });
  assert.equal(bridge.snapshot(job, { detail: 'compact' }).latestFailure.reason, 'File not found: missing.txt');
  job.session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'failed', title: 'Read missing.txt' });
  const after = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(after.latestFailure.id, 'read');
  assert.equal(after.latestFailure.title, 'Read missing.txt');
  assert.equal(after.latestFailure.reason, 'File not found: missing.txt');
  tool('other', 'failed', { title: 'Other' });
  const other = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(other.latestFailure.id, 'other');
  assert.equal(other.latestFailure.title, 'Other');
  assert.equal(other.latestFailure.reason, undefined);
});

test('finalization converts every active tool to unconfirmed even if history storage fails', async t => {
  const { bridge, job, tool } = fixture(t);
  await delay(0);
  tool('one', 'in_progress', { title: 'Build' });
  tool('two', 'in_progress', { title: 'Test' });
  const original = job.history.append.bind(job.history);
  let failures = 0;
  job.history.append = record => {
    if (record.status === 'unconfirmed') {
      failures++;
      throw new Error(failures === 1 ? 'simulated disk failure' : 'second disk failure');
    }
    return original(record);
  };
  const rejections = [];
  const onReject = error => rejections.push(error);
  process.on('unhandledRejection', onReject);
  t.after(() => process.off('unhandledRejection', onReject));
  job.session.finish('end_turn');
  await job.done;
  assert.deepEqual(rejections, []);
  const result = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /retain tool history.*simulated disk failure/);
  assert.doesNotMatch(result.error, /second disk failure/);
  assert.equal(result.toolSummary.active, 0);
  assert.equal(result.toolSummary.unconfirmed, 2);
  assert.equal(result.toolSummary.state, 'unconfirmed');
  assert.equal(result.unconfirmedTools.length, 2);
  assert.deepEqual(result.unconfirmedTools.map(item => item.reportedStatus), ['in_progress', 'in_progress']);
  const full = bridge.snapshot(job);
  assert.equal(full.tools.every(item => item.status === 'unconfirmed'), true);
  assert.equal(full.tools.some(item => item.status === 'pending' || item.status === 'in_progress'), false);
});

test('long Unicode tool paths page within the history byte budget and reconstruct exactly', async t => {
  const { bridge, job, tool } = fixture(t);
  await delay(0);
  const filePath = '目录'.repeat(100);
  for (let i = 0; i < 20; i++) {
    tool(`read-${i}`, 'completed', {
      title: `Read ${i}`,
      locations: Array.from({ length: 10 }, (_, n) => ({ path: filePath, line: n + 1 })),
    });
  }
  job.session.finish('end_turn');
  await job.done;
  const packed = job.history.page(0, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(packed.toolHistory)) <= HISTORY_PAGE_BYTES);
  assert.ok(packed.toolHistory.records.length < 20);
  const expected = Array.from({ length: job.history.totalRecords }, (_, i) => job.history.readRecord(i));
  let offset = 0, actual = [], pages = 0;
  do {
    const page = bridge.snapshot(job, { toolOffset: offset, toolLimit: 20 });
    pages++;
    assert.ok(Buffer.byteLength(JSON.stringify(page.toolHistory)) <= HISTORY_PAGE_BYTES);
    assert.ok(page.toolHistory.records.length >= 1);
    assert.ok(page.toolHistory.nextOffset > offset);
    actual.push(...page.toolHistory.records);
    offset = page.toolHistory.nextOffset;
    assert.equal(page.toolHistory.hasMore, offset < job.history.totalRecords);
  } while (offset < job.history.totalRecords);
  assert.ok(pages > 1);
  assert.equal(actual.length, expected.length);
  assert.deepEqual(actual, expected);
  assert.equal(actual[0].locations[0].path, filePath);
  assert.equal(actual[0].locations.length, 10);
});
