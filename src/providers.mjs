import { GrokSession, setup as grokSetup } from './grok.mjs';
import { CursorSession, cursorHandle, setup as cursorSetup } from './cursor.mjs';

export function providerFor(input = {}) {
  const saved = input.sessionId ? (input.sessionId.startsWith('cursor:') ? 'cursor' : 'grok') : undefined;
  if (saved && input.provider && input.provider !== saved) throw new Error('provider conflicts with sessionId. Start a new session to change providers.');
  const provider = saved || input.provider || process.env.GROK_ALLY_PROVIDER || 'grok';
  if (!['grok', 'cursor'].includes(provider)) throw new Error('provider / GROK_ALLY_PROVIDER must be grok or cursor.');
  if (provider === 'cursor' && input.effort) throw new Error('Cursor effort is part of model. Omit effort; the default is cursor-grok-4.6-xhigh.');
  return provider;
}

export function sessionKey(id) {
  return id?.startsWith('cursor:') ? `cursor:${cursorHandle(id).id}` : `grok:${id}`;
}

export const sessions = { grok: GrokSession, cursor: CursorSession };
export async function setup(input = {}) {
  const provider = providerFor(input);
  return provider === 'cursor' ? cursorSetup() : { provider, ...await grokSetup() };
}
