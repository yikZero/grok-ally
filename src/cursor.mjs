import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { AcpSession } from './acp.mjs';

export const CURSOR_MODEL = 'cursor-grok-4.6-xhigh';
const run = promisify(execFile);

export function binary() {
  if (process.env.CURSOR_BINARY) return process.env.CURSOR_BINARY;
  // `agent` can belong to Grok and `cursor` can be the editor CLI. Resolve only known Agent installs.
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), path.join(homedir(), '.local/bin')]) {
    if (!dir) continue;
    for (const name of ['cursor-agent', 'agent', 'cursor']) {
      const candidate = path.join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (name === 'cursor-agent' || /[\\/]cursor-agent[\\/]/.test(realpathSync(candidate))) return candidate;
      } catch {}
    }
  }
  throw new Error('Cursor Agent was not found. Install it from https://cursor.com/docs/cli/installation, run agent login, or set CURSOR_BINARY to the Cursor Agent executable.');
}

export function modelSelection(model = CURSOR_MODEL) {
  if (model === CURSOR_MODEL) return { model: 'grok-4.6', effort: 'xhigh', fast: 'false' };
  // Other choices use ACP base IDs with explicit optional parameters, not guessed CLI aliases.
  const match = /^([\w.-]+)(?:\[([\w=,.-]+)\])?$/.exec(model);
  if (!match || model.startsWith('cursor-')) throw new Error(`Unsupported Cursor model "${model}". Use ${CURSOR_MODEL} or an ACP model ID such as grok-4.6[effort=xhigh,fast=false].`);
  const selection = { model: match[1] };
  for (const pair of match[2]?.split(',') || []) {
    const [key, value, extra] = pair.split('=');
    if (!value || extra || ['mode', 'model', '__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(selection, key)) {
      throw new Error('Invalid Cursor model parameters.');
    }
    selection[key] = value;
  }
  return selection;
}

export function cursorHandle(handle) {
  const match = /^cursor:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(handle);
  if (!match) throw new Error('Invalid Cursor sessionId. Pass the complete handle returned by grok_chat.');
  const model = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!model || model.length > 800 || Buffer.from(model).toString('base64url') !== match[2]) throw new Error('Invalid Cursor session model.');
  modelSelection(model);
  return { id: match[1], model };
}

export async function setup() {
  const command = binary();
  const { stdout: help } = await run(command, ['acp', '--help'], { timeout: 15000, maxBuffer: 65536 });
  if (!/\bacp\b/i.test(help)) throw new Error('CURSOR_BINARY must point to Cursor Agent with ACP support, not the Cursor editor or Grok.');
  const { stdout } = await run(command, ['--version'], { timeout: 15000, maxBuffer: 65536 });
  return { provider: 'cursor', version: stdout.trim(), transport: 'mcp-stdio → acp-stdio', defaultModel: CURSOR_MODEL,
    authentication: 'Managed by Cursor Agent. Run agent login (or the CURSOR_BINARY login command); a chat verifies access.',
    defaultMode: 'ask', sandboxRequested: 'enabled',
    permissions: 'Cursor Ask/Agent modes and native policies; not the Grok OS read-only sandbox.' };
}

export class CursorSession extends AcpSession {
  constructor(options, onUpdate) {
    const saved = options.sessionId ? cursorHandle(options.sessionId) : null;
    const model = saved?.model || options.model || CURSOR_MODEL;
    const selection = modelSelection(model);
    super(options, onUpdate, { command: binary(), args: ['--sandbox', 'enabled', 'acp'], label: 'Cursor',
      env: { NO_OPEN_BROWSER: '1' } });
    this.nativeSessionId = saved?.id;
    this.selection = selection;
  }

  async initialize() {
    const timer = setTimeout(() => this.close(new Error('Cursor startup timed out. Check Cursor Agent login and ACP support.')), 90000);
    try {
      const init = await this.connection.agent.request('initialize', { protocolVersion: 1,
        clientCapabilities: { _meta: { parameterizedModelPicker: true } }, clientInfo: { name: 'grok-ally', version: pkg.version } });
      if (init.protocolVersion !== 1) throw new Error('Cursor did not negotiate ACP v1.');
      this.supportsClose = init.agentCapabilities?.sessionCapabilities?.close != null;
      if (!init.authMethods?.some(method => method.id === 'cursor_login')) throw new Error('Cursor did not offer existing-login authentication.');
      await this.connection.agent.request('authenticate', { methodId: 'cursor_login' });
      const params = { cwd: this.options.cwd, mcpServers: [] };
      let session;
      if (this.nativeSessionId) {
        if (!init.agentCapabilities?.loadSession) throw new Error('This Cursor version cannot load sessions.');
        session = await this.connection.agent.request('session/load', { ...params, sessionId: this.nativeSessionId });
      } else {
        session = await this.connection.agent.request('session/new', params);
        if (!session.sessionId) throw new Error('Cursor returned no sessionId.');
        this.nativeSessionId = session.sessionId;
      }
      let config = session?.configOptions;
      const desired = { ...this.selection, mode: this.options.write ? 'agent' : 'ask' };
      for (const [configId, value] of Object.entries(desired)) {
        const option = config?.find(option => option.id === configId);
        if (!option || !option.options?.some(entry => entry.value === value)) {
          throw new Error(`Cursor does not offer ${configId} "${value}". Update Cursor Agent or choose an available ACP model; no fallback was used.`);
        }
        if (option.currentValue !== value) {
          const result = await this.connection.agent.request('session/set_config_option', { sessionId: this.nativeSessionId, configId, value });
          config = result.configOptions;
        }
      }
      for (const [id, value] of Object.entries(desired)) {
        const actual = config?.find(option => option.id === id)?.currentValue;
        if (actual !== value) throw new Error(`Cursor did not select ${id} "${value}" (reported "${actual ?? 'unknown'}"). No prompt was sent.`);
      }
      // Include selected parameters in the opaque handle so reloads do not inherit a different global selection.
      const paramsSelected = config.filter(option => option.category === 'thought_level' || option.category === 'model_config');
      this.model = this.selection.model + (paramsSelected.length ? `[${paramsSelected.map(option => `${option.id}=${option.currentValue}`).join(',')}]` : '');
      this.mode = desired.mode;
      this.sessionId = `cursor:${this.nativeSessionId}:${Buffer.from(this.model).toString('base64url')}`;
      return this.sessionId;
    } finally { clearTimeout(timer); }
  }

  permission({ sessionId, toolCall, options }) {
    const kind = toolCall?.kind;
    const allowed = this.prompting && !this.closing && !this.cancelling && sessionId === this.nativeSessionId &&
      (['read', 'search', 'fetch'].includes(kind) || (this.options.write && ['edit', 'execute'].includes(kind)));
    const choice = allowed && options?.find(option => option.kind === 'allow_once');
    if (choice) return { outcome: { outcome: 'selected', optionId: choice.optionId } };
    // No persistent approvals, interactive answers, or approvals for unknown / MCP operations.
    return { outcome: { outcome: 'cancelled' } };
  }
}
