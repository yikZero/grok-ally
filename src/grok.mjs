import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };
import { collectOwned, hostGuard, isAlive, isOwnedBy, listProcesses, sameIdentity, signalGroup, signalPid } from './process.mjs';

export const TERM_MS = 2000;
export const CLOSE_MS = 8000;

export function binary() {
  if (process.env.GROK_BINARY) return process.env.GROK_BINARY;
  const name = process.platform === 'win32' ? 'grok.exe' : 'grok';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  const installed = path.join(process.env.GROK_HOME || path.join(homedir(), '.grok'), 'bin', name);
  if (existsSync(installed)) return installed;
  throw new Error('Grok Build was not found. Install it from https://docs.x.ai/build/overview and run grok login.');
}

export function workspace(cwd) {
  if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute workspace path.');
  const resolved = realpathSync(cwd);
  if (!statSync(resolved).isDirectory()) throw new Error('cwd must be a directory.');
  return resolved;
}

export function safeError(error) {
  return String(error?.message || error)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:xai-|sk-)[\w-]+/g, '[redacted]')
    .slice(0, 2000);
}

export async function setup() {
  const command = binary();
  const { stdout } = await promisify(execFile)(command, ['--version'], { timeout: 15000, maxBuffer: 65536 });
  return { version: stdout.trim(), transport: 'mcp-stdio → acp-stdio',
    authentication: 'Managed by Grok Build. Run grok login if needed; a chat verifies actual access.',
    defaultSandbox: 'read-only' };
}

export class GrokSession {
  constructor(options, onUpdate) {
    this.options = options;
    this.sessionId = options.sessionId;
    const args = ['--sandbox', options.write ? 'workspace' : 'read-only',
      'agent', '--no-leader', '--always-approve'];
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--reasoning-effort', options.effort);
    args.push('stdio');
    this.child = spawn(binary(), args, {
      cwd: options.cwd,
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1', GROK_SUBAGENTS: '0',
        GROK_ALLY_ACTIVE: '1', NO_COLOR: '1', RUST_LOG: 'off' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.guard = hostGuard();
    this.owned = new Map();
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    this.connection = client({ name: 'grok-ally', version: pkg.version })
      .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
      .onNotification('session/update', ({ params }) => {
        // Ignore session/load replay and notifications belonging to another session.
        if (this.prompting && params.sessionId === this.sessionId) {
          this.observeBackground(params.update);
          onUpdate(params.update);
        }
      })
      .connect(ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
    this.child.on('error', error => this.close(new Error(safeError(error))));
    this.child.on('exit', (code, signal) => {
      this.close(new Error(`Grok exited (${code ?? signal}): ${safeError(this.stderr)}`));
    });
    this.child.on('spawn', () => this.rememberLeader());
    if (this.child.pid) this.rememberLeader();
    // A child that exits early can otherwise surface an unhandled pipe error.
    this.child.stdin.on('error', error => this.close(error));
  }

  async initialize() {
    const timer = setTimeout(() => this.close(new Error('Grok startup timed out. Check grok login and grok doctor.')), 60000);
    try {
      const init = await this.connection.agent.request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-ally', version: pkg.version },
        // Grok's ReplayBuffer batches text upstream; tool boundaries and prompt completion flush it.
        _meta: { bufferingSettings: { maxItems: 100, maxBytes: 16384, maxDurationMs: 200 } },
      });
      if (init.protocolVersion !== 1) throw new Error('Grok did not negotiate ACP v1.');
      this.supportsClose = init.agentCapabilities?.sessionCapabilities?.close != null;
      const params = { cwd: this.options.cwd, mcpServers: [] };
      if (this.sessionId) {
        if (!init.agentCapabilities?.loadSession) throw new Error('This Grok version cannot load sessions.');
        // Grok 1.0.13 returns {}; the requested id is authoritative. Never silently start over.
        await this.connection.agent.request('session/load', { ...params, sessionId: this.sessionId });
      } else {
        const session = await this.connection.agent.request('session/new', params);
        if (!session.sessionId) throw new Error('Grok returned no sessionId.');
        // Native CLI overrides can silently fall back. Check before sending user content.
        const model = session.configOptions?.find(option => option.id === 'model')?.currentValue
          ?? session.models?.currentModelId;
        const effort = session.configOptions?.find(option => option.id === 'reasoning_effort')?.currentValue
          ?? session.models?.availableModels?.find(entry => entry.modelId === model)?._meta?.reasoningEffort;
        for (const [name, actual] of [['model', model], ['effort', effort]]) {
          const requested = this.options[name];
          if (requested && actual !== requested) {
            throw new Error(`Requested ${name} "${requested}" was not selected: Grok reported "${actual ?? 'unknown'}". Use an available value or omit ${name} for Grok's default.`);
          }
        }
        this.sessionId = session.sessionId;
      }
      return this.sessionId;
    } finally { clearTimeout(timer); }
  }

  async prompt(text) {
    this.prompting = true;
    try {
      return await this.connection.agent.request('session/prompt', {
        sessionId: this.sessionId, prompt: [{ type: 'text', text }],
      });
    } finally {
      // Record live descendants before the prompt returns; Grok may then exit and reparent them.
      this.snapshotOwned();
      this.prompting = false;
    }
  }

  cancel() { return this.connection.agent.notify('session/cancel', { sessionId: this.sessionId }); }

  async closeSession() {
    if (!this.sessionId || this.closing) return { attempted: false, reason: 'unavailable' };
    if (!this.supportsClose) return { attempted: false, reason: 'unsupported' };
    try {
      const result = await this.connection.agent.request('session/close', { sessionId: this.sessionId });
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

  observeBackground(update) {
    const raw = update?.rawOutput;
    if (raw?.type !== 'BackgroundTaskStarted') return;
    const pid = Number(raw.pid);
    const taskId = typeof raw.task_id === 'string' ? raw.task_id.slice(0, 80) : undefined;
    if (!Number.isInteger(pid) || pid <= 0) return;
    const listed = listProcesses();
    if (!listed.ok) { this.listUnknown ??= listed.reason; return; }
    const info = listed.processes.get(pid);
    if (!info || !isOwnedBy(info, this.child.pid, {
      processes: listed.processes, recorded: this.recorded(), guard: this.guard,
    })) return;
    this.rememberOwned({ ...info, ...(taskId ? { taskId } : {}) });
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

  close(error = new Error('Grok connection closed. Resume with the same sessionId.')) {
    if (this.closing) return;
    this.closing = true;
    this.snapshotOwned();
    try { this.connection.close(error); } catch {}
    try { this.child.stdin.end(); } catch {}
    if (this.signalOwned('SIGTERM')) {
      // Keep cleanup alive even if Grok exits before its descendants do.
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
