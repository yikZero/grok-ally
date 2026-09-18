import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

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

