import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.mjs';
import { collectOwned, isAlive, listProcesses } from '../src/process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fake = path.join(root, 'tests/fake-grok.mjs');
chmodSync(fake, 0o755);
const listed = listProcesses();
const canList = listed.ok;
const posix = process.platform !== 'win32';
const skipList = !posix ? 'Windows does not claim process-tree cleanup' : !canList
  ? 'ps unavailable in this environment (expected EPERM in the Grok workspace sandbox); host must run this check'
  : false;

function events(log) {
  try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

async function waitFor(pred, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = pred();
    if (value) return value;
    await delay(30);
  }
  throw new Error('timed out');
}

function fixture(t, envExtra = {}, bridgeOptions = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'grok-ally-cleanup-'));
  const log = path.join(cwd, 'events.jsonl');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const previous = {
    GROK_BINARY: process.env.GROK_BINARY,
    GROK_TEST_LOG: process.env.GROK_TEST_LOG,
    GROK_TEST_NO_CLOSE: process.env.GROK_TEST_NO_CLOSE,
    GROK_TEST_SLOW_INIT: process.env.GROK_TEST_SLOW_INIT,
    GROK_ALLY_ACTIVE: process.env.GROK_ALLY_ACTIVE,
  };
  process.env.GROK_BINARY = fake;
  process.env.GROK_TEST_LOG = log;
  delete process.env.GROK_ALLY_ACTIVE;
  for (const [key, value] of Object.entries(envExtra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const bridge = new Bridge({ closeMs: 800, idleMs: 60_000, ...bridgeOptions });
  t.after(() => {
    bridge.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { cwd, log, bridge };
}

async function startSlow(t, prompt, envExtra) {
  const f = fixture(t, envExtra);
  const job = f.bridge.start({ cwd: f.cwd, write: false, prompt });
  await waitFor(() => job.sessionId && job.status === 'running');
  const grokPid = events(f.log).find(e => e.event === 'spawn')?.pid;
  t.after(() => { try { if (grokPid) process.kill(grokPid, 'SIGKILL'); } catch {} });
  return { ...f, job, grokPid };
}

describe('process cleanup', { concurrency: 1 }, () => {
const emptyGuard = { pids: new Set([1]), pgids: new Set() };

test('collectOwned rejects a reused PGID whose start identity changed', () => {
  const processes = new Map([
    [990001, { pid: 990001, ppid: 1, pgid: 990001, start: 'NEW' }],
    [990002, { pid: 990002, ppid: 990001, pgid: 990001, start: 'NEW' }],
  ]);
  const recorded = [{ pid: 990001, ppid: 990000, pgid: 990001, start: 'OLD' }];
  const owned = collectOwned(990000, { processes, recorded, guard: emptyGuard });
  assert.equal(owned.processes.some(p => p.pid === 990001 || p.pid === 990002), false);
  assert.equal(owned.groups.has(990001), false);
});

test('collectOwned rejects a recycled root whose start identity changed', () => {
  const processes = new Map([
    [990000, { pid: 990000, ppid: 1, pgid: 990000, start: 'NEW' }],
    [990001, { pid: 990001, ppid: 990000, pgid: 990000, start: 'NEW' }],
  ]);
  const recorded = [{ pid: 990000, ppid: 1, pgid: 990000, start: 'OLD' }];
  const owned = collectOwned(990000, { processes, recorded, guard: emptyGuard });
  assert.equal(owned.processes.some(p => p.pid === 990000 || p.pid === 990001), false);
  assert.equal(owned.groups.has(990000), false);
});

test('collectOwned lets a surviving child anchor its original group', () => {
  const processes = new Map([
    [101, { pid: 101, ppid: 1, pgid: 100, start: 'T0' }],
    [102, { pid: 102, ppid: 101, pgid: 100, start: 'T0' }],
  ]);
  const recorded = [
    { pid: 100, ppid: 50, pgid: 100, start: 'T0' },
    { pid: 101, ppid: 100, pgid: 100, start: 'T0' },
  ];
  const owned = collectOwned(50, { processes, recorded, guard: emptyGuard });
  assert.ok(owned.processes.some(p => p.pid === 101));
  assert.ok(owned.processes.some(p => p.pid === 102));
  assert.ok(owned.groups.has(100));
  const singles = [];
  for (const proc of owned.processes) {
    if (owned.groups.has(proc.pgid)) continue;
    singles.push(proc.pid);
  }
  assert.deepEqual(singles, []);
});

test('hung cancel notification still reaches native close', async t => {
  let closedNative = false, closed = false;
  class Session {
    constructor(options, update) { this.options = options; this.update = update; this.sessionId = 'hung-cancel'; }
    async initialize() { return this.sessionId; }
    prompt() { return new Promise(resolve => { this.finish = stopReason => resolve({ stopReason }); }); }
    cancel() { return new Promise(() => {}); }
    async closeSession() { closedNative = true; this.finish?.('cancelled'); return { attempted: true }; }
    snapshotOwned() {}
    remainingOwned() { return []; }
    close() { closed = true; this.finish?.('cancelled'); }
  }
  const bridge = new Bridge({ Session, closeMs: 30, termMs: 20 });
  t.after(() => bridge.close());
  const job = bridge.start({ cwd: tmpdir(), write: false, prompt: 'test' });
  await delay(0);
  const pending = bridge.cancel(job.requestId);
  assert.equal(pending.status, 'cancelling');
  assert.equal((() => { try { bridge.start({ cwd: tmpdir(), write: false, sessionId: 'hung-cancel', prompt: 'x' }); return 'started'; } catch (error) { return error.message; } })().includes('active turn'), true);
  const started = Date.now();
  await job.done;
  assert.ok(Date.now() - started < 1500);
  assert.equal(job.status, 'cancelled');
  assert.equal(closedNative, true);
  assert.equal(closed, true);
});

test('hung session/close still closes the connection after the bound', async t => {
  let closed = false;
  class Session {
    constructor(options, update) { this.options = options; this.update = update; this.sessionId = 'hung-close'; }
    async initialize() { return this.sessionId; }
    prompt() { return new Promise(resolve => { this.finish = stopReason => resolve({ stopReason }); }); }
    async cancel() { this.finish('cancelled'); }
    closeSession() { return new Promise(() => {}); }
    snapshotOwned() {}
    remainingOwned() { return []; }
    close() { closed = true; this.finish?.('cancelled'); }
  }
  const bridge = new Bridge({ Session, closeMs: 30, termMs: 20 });
  t.after(() => bridge.close());
  const job = bridge.start({ cwd: tmpdir(), write: false, prompt: 'test' });
  await delay(0);
  const started = Date.now();
  bridge.cancel(job.requestId);
  await job.done;
  assert.ok(Date.now() - started < 1500);
  assert.equal(job.status, 'cancelled');
  assert.equal(closed, true);
});

test('listProcesses reports unconfirmed-quality failure instead of fabricating a table', () => {
  if (canList) {
    assert.ok(listed.processes.size > 0);
    assert.ok(listed.processes.has(process.pid));
    return;
  }
  assert.equal(listed.ok, false);
  assert.ok(listed.reason);
  assert.equal(listed.processes.size, 0);
});

test('unverified leftover cleanup is explicit and separate from toolSummary', async t => {
  class Session {
    constructor(options, update) { this.options = options; this.update = update; this.sessionId = 'mock-cleanup'; }
    async initialize() { return this.sessionId; }
    prompt() { return new Promise(resolve => { this.finish = stopReason => resolve({ stopReason }); }); }
    async cancel() { this.finish('cancelled'); }
    async closeSession() { return { attempted: false, reason: 'unsupported' }; }
    snapshotOwned() {}
    remainingOwned() { return [{ pid: 424242, reason: 'still running' }]; }
    close() { this.finish?.('cancelled'); }
  }
  const bridge = new Bridge({ Session, closeMs: 50, termMs: 20 });
  t.after(() => bridge.close());
  const job = bridge.start({ cwd: tmpdir(), write: false, prompt: 'test' });
  await delay(0);
  const pending = bridge.cancel(job.requestId);
  assert.equal(pending.status, 'cancelling');
  assert.equal(pending.cleanup.state, 'pending');
  assert.equal(pending.cleanup.scope, 'observed-local');
  assert.equal(pending.toolSummary.state === pending.cleanup.state, false);
  await job.done;
  const done = bridge.snapshot(job, { detail: 'compact' });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.cleanup.state, 'unconfirmed');
  assert.deepEqual(done.cleanup.remaining, [{ pid: 424242, reason: 'still running' }]);
});

async function waitTree(log) {
  return waitFor(() => events(log).find(e => e.event === 'descendant' && e.grandchild));
}

function killTree(rec) {
  for (const pid of [rec?.pid, rec?.grandchild]) {
    try { if (pid) process.kill(pid, 'SIGKILL'); } catch {}
    try { if (pid) process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

test('cancel stays cancelling until cleanup; descendants die; no reuse during teardown', { skip: !posix }, async t => {
  const { bridge, job, grokPid, log } = await startSlow(t, 'slow-tree');
  const rec = await waitTree(log);
  t.after(() => killTree(rec));
  assert.ok(isAlive(grokPid));
  assert.ok(isAlive(rec.pid));
  assert.ok(isAlive(rec.grandchild));
  const pending = bridge.cancel(job.requestId);
  assert.equal(pending.status, 'cancelling');
  assert.equal(pending.cleanup.state, 'pending');
  assert.ok(isAlive(rec.pid));
  assert.ok(isAlive(rec.grandchild));
  assert.equal((() => { try { bridge.start({ cwd: job.cwd, write: false, sessionId: job.sessionId, prompt: 'overlap' }); return 'started'; } catch (error) { return error.message; } })().includes('active turn'), true);
  await job.done;
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
  if (canList) assert.equal(job.cleanup.state, 'confirmed');
  else {
    assert.equal(job.cleanup.state, 'unconfirmed');
    assert.ok(job.cleanup.reason);
  }
});

test('detached background PGID is reaped after cancel', { skip: skipList }, async t => {
  const { bridge, job, grokPid, log } = await startSlow(t, 'slow-detached');
  const rec = await waitTree(log);
  t.after(() => killTree(rec));
  const table = listProcesses().processes;
  assert.notEqual(table.get(rec.pid)?.pgid, table.get(grokPid)?.pgid);
  const pending = bridge.cancel(job.requestId);
  assert.equal(pending.status, 'cancelling');
  assert.ok(isAlive(rec.pid));
  assert.ok(isAlive(rec.grandchild));
  await job.done;
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
  assert.equal(job.cleanup.state, 'confirmed');
});

test('children launched during cancellation are gone before takeover', { skip: !posix }, async t => {
  const { bridge, job, grokPid, cwd, log } = await startSlow(t, 'slow-delay-spawn');
  t.after(() => {
    for (const rec of events(log).filter(e => e.event === 'descendant')) killTree(rec);
  });
  const started = Date.now();
  const pending = bridge.cancel(job.requestId);
  assert.equal(pending.status, 'cancelling');
  assert.equal((() => { try { bridge.start({ cwd, write: false, sessionId: job.sessionId, prompt: 'too-soon' }); return 'started'; } catch (error) { return error.message; } })().includes('active turn'), true);
  await job.done;
  const remain = 150 - (Date.now() - started);
  if (remain > 0) await delay(remain);
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  for (const rec of events(log).filter(e => e.event === 'descendant')) {
    assert.equal(isAlive(rec.pid), false);
    if (rec.grandchild) assert.equal(isAlive(rec.grandchild), false);
  }
});

test('stubborn SIGTERM child is escalated to SIGKILL', { skip: skipList }, async t => {
  const { bridge, job, grokPid, log } = await startSlow(t, 'slow-stubborn');
  const rec = await waitTree(log);
  t.after(() => killTree(rec));
  bridge.cancel(job.requestId);
  await job.done;
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
  assert.equal(job.cleanup.state, 'confirmed');
});

test('native close missing still reaps via verified fallback', { skip: skipList }, async t => {
  const { bridge, job, grokPid, log } = await startSlow(t, 'slow-detached', { GROK_TEST_NO_CLOSE: '1' });
  const rec = await waitTree(log);
  t.after(() => killTree(rec));
  bridge.cancel(job.requestId);
  await job.done;
  assert.equal(events(log).some(e => e.method === 'session/close'), false);
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
});

test('native close that acknowledges without killing still reaps the detached group', { skip: skipList }, async t => {
  const { bridge, job, grokPid, log } = await startSlow(t, 'slow-close-noop');
  const rec = await waitTree(log);
  t.after(() => killTree(rec));
  bridge.cancel(job.requestId);
  await job.done;
  assert.ok(events(log).some(e => e.method === 'session/close'));
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
});

test('native close hang falls back to terminate after the close bound', { skip: !posix }, async t => {
  const f = fixture(t, {}, { closeMs: 150, termMs: 400 });
  const job = f.bridge.start({ cwd: f.cwd, write: false, prompt: 'slow-close-hang' });
  await waitFor(() => job.sessionId && job.status === 'running');
  const grokPid = events(f.log).find(e => e.event === 'spawn')?.pid;
  const rec = await waitTree(f.log);
  t.after(() => { try { if (grokPid) process.kill(grokPid, 'SIGKILL'); } catch {} killTree(rec); });
  const started = Date.now();
  f.bridge.cancel(job.requestId);
  await job.done;
  assert.ok(Date.now() - started < 4000);
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
});

test('same sessionId loads a new process after cleanup settles', { skip: !posix }, async t => {
  const { bridge, job, grokPid, cwd } = await startSlow(t, 'slow');
  bridge.cancel(job.requestId);
  assert.equal((() => { try { bridge.start({ cwd, write: false, sessionId: job.sessionId, prompt: 'too-soon' }); return 'started'; } catch (error) { return error.message; } })().includes('active turn'), true);
  await job.done;
  assert.equal(isAlive(grokPid), false);
  const next = bridge.start({ cwd, write: false, sessionId: job.sessionId, prompt: 'hello' });
  await next.done;
  assert.equal(next.status, 'completed');
  assert.equal(next.sessionId, job.sessionId);
  assert.notEqual(next.session.child.pid, grokPid);
});

test('cancellation during startup retires the process', { skip: !posix }, async t => {
  const f = fixture(t, { GROK_TEST_SLOW_INIT: '2000' });
  const job = f.bridge.start({ cwd: f.cwd, write: false, prompt: 'hello' });
  const grokPid = await waitFor(() => events(f.log).find(e => e.event === 'spawn')?.pid);
  t.after(() => { try { process.kill(grokPid, 'SIGKILL'); } catch {} });
  assert.equal(job.status, 'starting');
  const pending = f.bridge.cancel(job.requestId);
  assert.equal(pending.status, 'cancelling');
  await job.done;
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
});

test('unrelated sibling process and session survive cancellation', { skip: !posix }, async t => {
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(sibling.pid, 'SIGKILL'); } catch {} });
  const f = fixture(t);
  const jobA = f.bridge.start({ cwd: f.cwd, write: false, prompt: 'slow-tree' });
  await waitFor(() => jobA.sessionId && jobA.status === 'running');
  const jobB = f.bridge.start({ cwd: f.cwd, write: false, prompt: 'slow' });
  await waitFor(() => jobB.sessionId && jobB.status === 'running');
  const spawns = events(f.log).filter(e => e.event === 'spawn');
  const grokA = spawns[0].pid, grokB = spawns.at(-1).pid;
  const rec = await waitTree(f.log);
  t.after(() => {
    try { process.kill(grokA, 'SIGKILL'); } catch {}
    try { process.kill(grokB, 'SIGKILL'); } catch {}
    killTree(rec);
  });
  f.bridge.cancel(jobA.requestId);
  await jobA.done;
  assert.equal(isAlive(grokA), false);
  assert.equal(isAlive(rec.pid), false);
  assert.equal(isAlive(rec.grandchild), false);
  assert.ok(isAlive(sibling.pid));
  assert.ok(isAlive(grokB));
  assert.equal(jobB.status, 'running');
  f.bridge.cancel(jobB.requestId);
  await jobB.done;
});

test('unrelated reported background PID is never treated as owned', { skip: !posix }, async t => {
  const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(stranger.pid, 'SIGKILL'); } catch {} });
  const { bridge, job, grokPid } = await startSlow(t, 'slow-false-bg', { GROK_TEST_FALSE_PID: String(stranger.pid) });
  bridge.cancel(job.requestId);
  await job.done;
  assert.equal(job.status, 'cancelled');
  assert.equal(isAlive(grokPid), false);
  assert.ok(isAlive(stranger.pid));
  assert.equal(job.cleanup.remaining?.some(item => item.pid === stranger.pid) ?? false, false);
});

test('native stopReason cancelled retires the process', { skip: !posix }, async t => {
  const f = fixture(t);
  const job = f.bridge.start({ cwd: f.cwd, write: false, prompt: 'self-cancel' });
  const grokPid = await waitFor(() => events(f.log).find(e => e.event === 'spawn')?.pid);
  t.after(() => { try { process.kill(grokPid, 'SIGKILL'); } catch {} });
  await job.done;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.stopReason, 'cancelled');
  assert.ok(job.cleanup);
  assert.equal(isAlive(grokPid), false);
  const next = f.bridge.start({ cwd: f.cwd, write: false, sessionId: job.sessionId, prompt: 'hello' });
  await next.done;
  assert.equal(next.status, 'completed');
  assert.equal(next.cleanup, undefined);
  assert.notEqual(next.session.child.pid, grokPid);
});
});
