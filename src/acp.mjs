import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };
import { safeError } from './common.mjs';
import { collectOwned, hostGuard, isAlive, listProcesses, sameIdentity, signalGroup, signalPid } from './process.mjs';

export const TERM_MS = 2000;
export const CLOSE_MS = 8000;

// Transport and owned-process cleanup are shared; native configuration stays in each adapter.
export class AcpSession {
  constructor(options, onUpdate, { command, args, env = {}, label }) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.onUpdate = onUpdate;
    this.label = label;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env, GROK_ALLY_ACTIVE: '1', NO_COLOR: '1' },
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.guard = hostGuard();
    this.owned = new Map();
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    // Register updates first: the SDK dispatches responses independently of async handler traversal.
    this.connection = client({ name: 'grok-ally', version: pkg.version })
      .onNotification('session/update', ({ params }) => {
        // Ignore session/load replay and notifications belonging to another session.
        if (this.prompting && params.sessionId === this.nativeId) {
          this.observeBackground?.(params.update);
          this.onUpdate(params.update);
        }
      })
      .onRequest('session/request_permission', ({ params }) => this.permission(params))
      .onRequest('cursor/ask_question', value => value, () => this.interaction('question'))
      .onRequest('cursor/create_plan', value => value, () => this.interaction('plan'))
      .connect(ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
    this.child.on('error', error => this.close(new Error(safeError(error))));
    this.child.on('exit', (code, signal) => {
      this.close(new Error(`${this.label} exited (${code ?? signal}): ${safeError(this.stderr)}`));
    });
    this.child.on('spawn', () => this.rememberLeader());
    if (this.child.pid) this.rememberLeader();
    // A child that exits early can otherwise surface an unhandled pipe error.
    this.child.stdin.on('error', error => this.close(error));
  }

  get nativeId() { return this.nativeSessionId ?? this.sessionId; }

  permission() { return { outcome: { outcome: 'cancelled' } }; }

  interaction(kind) {
    const reason = `Grok Ally cannot answer interactive ${kind} requests. Return the question or plan in your reply for the host to handle.`;
    this.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n[${reason}]\n` } });
    return { outcome: { outcome: kind === 'question' ? 'skipped' : 'rejected', reason } };
  }

  async prompt(text) {
    this.prompting = true;
    try {
      return await this.connection.agent.request('session/prompt', {
        sessionId: this.nativeId, prompt: [{ type: 'text', text }],
      });
    } finally {
      // Record live descendants before the prompt returns; the agent may then exit and reparent them.
      this.snapshotOwned();
      this.prompting = false;
    }
  }

  cancel() { return this.connection.agent.notify('session/cancel', { sessionId: this.nativeId }); }

  async closeSession() {
    if (!this.sessionId || this.closing) return { attempted: false, reason: 'unavailable' };
    if (!this.supportsClose) return { attempted: false, reason: 'unsupported' };
    try {
      const result = await this.connection.agent.request('session/close', { sessionId: this.nativeId });
      return { attempted: true, result };
    } catch (error) {
      return { attempted: true, error: safeError(error) };
    }
  }

  rememberLeader() {
    if (!this.child.pid) return;
    const listed = listProcesses();
    if (!listed.ok) {
      this.listUnknown ??= listed.reason;
      this.leader ??= { pid: this.child.pid };
      return;
    }
    const info = listed.processes.get(this.child.pid);
    if (!info) return;
    if (this.leader?.start && !sameIdentity(this.leader, info)) return;
    this.leader = info;
    this.rememberOwned(info);
  }

  rememberOwned(info) {
    if (!info?.pid) return;
    const prior = this.owned.get(info.pid);
    if (prior && (prior.start !== info.start || prior.pgid !== info.pgid)) return;
    if (!prior) this.owned.set(info.pid, info);
  }

  snapshotOwned() {
    if (process.platform === 'win32') {
      this.treeCleanup = false;
      this.listUnknown ??= 'Process tree cleanup is not supported on this platform.';
      return;
    }
    const listed = listProcesses();
    if (!listed.ok) { this.listUnknown = listed.reason; return; }
    for (const [pid, rec] of this.owned) {
      const live = listed.processes.get(pid);
      if (live && !sameIdentity(rec, live)) this.owned.delete(pid);
    }
    const collected = collectOwned(this.child.pid, {
      processes: listed.processes, recorded: this.recorded(), guard: this.guard,
    });
    for (const proc of collected.processes) this.rememberOwned(proc);
  }

  recorded() {
    return [this.leader, ...this.owned.values()].filter(info => info?.start);
  }

  remainingOwned() {
    if (this.listUnknown || this.treeCleanup === false) return [];
    const listed = listProcesses();
    if (!listed.ok) { this.listUnknown = listed.reason; return []; }
    const collected = collectOwned(this.child.pid, {
      processes: listed.processes, recorded: this.recorded(), guard: this.guard,
    });
    const still = [];
    for (const proc of collected.processes) {
      if (!isAlive(proc.pid)) continue;
      still.push({ pid: proc.pid, reason: 'still running' });
    }
    return still;
  }

  signalOwned(sig) {
    if (process.platform === 'win32') {
      this.treeCleanup = false;
      try { return this.child.kill(sig); }
      catch { return false; }
    }
    const listed = listProcesses();
    if (!listed.ok) {
      this.listUnknown ??= listed.reason;
      if (this.child.pid && this.child.exitCode == null && this.child.signalCode == null) {
        try { process.kill(-this.child.pid, sig); return true; }
        catch { try { return this.child.kill(sig); } catch { return false; } }
      }
      return false;
    }
    const collected = collectOwned(this.child.pid, {
      processes: listed.processes, recorded: this.recorded(), guard: this.guard,
    });
    let sent = false;
    for (const pgid of collected.groups) {
      if (signalGroup(pgid, sig, this.guard)) sent = true;
    }
    for (const proc of collected.processes) {
      if (collected.groups.has(proc.pgid)) continue;
      if (signalPid(proc.pid, sig, this.guard)) sent = true;
    }
    return sent;
  }

  close(error = new Error('ACP connection closed. Resume with the same sessionId.')) {
    if (this.closing) return;
    this.closing = true;
    this.snapshotOwned();
    try { this.connection.close(error); } catch {}
    try { this.child.stdin.end(); } catch {}
    if (this.signalOwned('SIGTERM')) {
      // Keep cleanup alive even if the agent exits before its descendants do.
      const timer = setTimeout(() => this.signalOwned('SIGKILL'), TERM_MS);
      this.child.once('close', () => { if (!this.ownedStillAlive()) clearTimeout(timer); });
    }
  }

  ownedStillAlive() {
    if (this.child?.pid && isAlive(this.child.pid)) return true;
    for (const rec of this.owned.values()) {
      if (rec.pid !== this.child?.pid && isAlive(rec.pid)) return true;
    }
    return false;
  }
}
