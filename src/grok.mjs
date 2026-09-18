import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { isOwnedBy, listProcesses } from './process.mjs';
import { AcpSession } from './acp.mjs';
export { safeError, workspace } from './common.mjs';
export { TERM_MS, CLOSE_MS } from './acp.mjs';

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

export async function setup() {
  const command = binary();
  const { stdout } = await promisify(execFile)(command, ['--version'], { timeout: 15000, maxBuffer: 65536 });
  return { version: stdout.trim(), transport: 'mcp-stdio → acp-stdio',
    authentication: 'Managed by Grok Build. Run grok login if needed; a chat verifies actual access.',
    defaultSandbox: 'read-only' };
}

export class GrokSession extends AcpSession {
  constructor(options, onUpdate) {
    const args = ['--sandbox', options.write ? 'workspace' : 'read-only',
      'agent', '--no-leader', '--always-approve'];
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--reasoning-effort', options.effort);
    args.push('stdio');
    super(options, onUpdate, { command: binary(), args, label: 'Grok',
      env: { GROK_DISABLE_AUTOUPDATER: '1', GROK_SUBAGENTS: '0', RUST_LOG: 'off' } });
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

}
