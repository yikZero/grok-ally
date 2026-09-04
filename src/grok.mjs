import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };

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
      '--no-subagents', '--max-turns', String(options.maxTurns), 'agent', '--no-leader', '--always-approve'];
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--reasoning-effort', options.effort);
    args.push('stdio');
    this.child = spawn(binary(), args, {
      cwd: options.cwd,
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1', GROK_ALLY_ACTIVE: '1', NO_COLOR: '1', RUST_LOG: 'off' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    this.connection = client({ name: 'grok-ally', version: pkg.version })
      .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
      .onNotification('session/update', ({ params }) => {
        // Ignore session/load replay and notifications belonging to another session.
        if (this.prompting && params.sessionId === this.sessionId) onUpdate(params.update);
      })
      .connect(ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
    this.child.on('error', error => this.close(new Error(safeError(error))));
    this.child.on('exit', (code, signal) => {
      this.close(new Error(`Grok exited (${code ?? signal}): ${safeError(this.stderr)}`));
    });
    // A child that exits early can otherwise surface an unhandled pipe error.
    this.child.stdin.on('error', error => this.close(error));
  }

  async initialize() {
    const timer = setTimeout(() => this.close(new Error('Grok startup timed out. Check grok login and grok doctor.')), 60000);
    try {
      const init = await this.connection.agent.request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-ally', version: pkg.version },
      });
      if (init.protocolVersion !== 1) throw new Error('Grok did not negotiate ACP v1.');
      const params = { cwd: this.options.cwd, mcpServers: [] };
      if (this.sessionId) {
        if (!init.agentCapabilities?.loadSession) throw new Error('This Grok version cannot load sessions.');
        // Grok 1.0.13 returns {}; the requested id is authoritative. Never silently start over.
        await this.connection.agent.request('session/load', { ...params, sessionId: this.sessionId });
      } else {
        const session = await this.connection.agent.request('session/new', params);
        if (!session.sessionId) throw new Error('Grok returned no sessionId.');
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
    } finally { this.prompting = false; }
  }

  cancel() { return this.connection.agent.notify('session/cancel', { sessionId: this.sessionId }); }

  close(error = new Error('Grok connection closed. Resume with the same sessionId.')) {
    if (this.closing) return;
    this.closing = true;
    this.connection.close(error);
    this.child.stdin.end();
    const kill = signal => {
      if (!this.child.pid) return false;
      try {
        if (process.platform !== 'win32') process.kill(-this.child.pid, signal);
        else return this.child.kill(signal);
        return true;
      } catch { return false; }
    };
    if (kill('SIGTERM')) {
      // Keep cleanup alive even if Grok exits before its descendants do.
      const timer = setTimeout(() => kill('SIGKILL'), 2000);
      this.child.once('close', () => { if (!kill(0)) clearTimeout(timer); });
    }
  }
}
