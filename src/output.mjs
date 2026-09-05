import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PAGE_BYTES = 16000;
const continuation = byte => (byte & 0xc0) === 0x80;

// Full assistant text lives outside the workspace; only bounded pages enter MCP replies.
export class Output {
  totalBytes = 0;
  ending = '';

  append(text) {
    if (this.closed) throw new Error('Output storage is closed.');
    if (this.fd === undefined) {
      this.directory = mkdtempSync(path.join(tmpdir(), 'grok-ally-output-'));
      this.fd = openSync(path.join(this.directory, 'answer.txt'), 'wx+', 0o600);
    }
    const bytes = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(this.fd, bytes, written, bytes.length - written, this.totalBytes);
      if (!count) throw new Error('Could not save Grok output.');
      written += count;
      this.totalBytes += count;
    }
    this.ending = (this.ending + text).slice(-2);
  }

  page(offset, limit = PAGE_BYTES) {
    const preview = offset === undefined;
    offset ??= Math.max(0, this.totalBytes - limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.totalBytes) {
      throw new Error('outputOffset must be between 0 and output.totalBytes.');
    }
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > 64000) {
      throw new Error('outputLimit must be between 4 and 64000 bytes.');
    }
    const bytes = Buffer.alloc(Math.min(limit + 3, this.totalBytes - offset));
    if (bytes.length) {
      const count = readSync(this.fd, bytes, 0, bytes.length, offset);
      if (count !== bytes.length) throw new Error('Saved Grok output is incomplete.');
    }
    let start = 0;
    if (preview) while (start < bytes.length && continuation(bytes[start])) start++;
    else if (bytes.length && continuation(bytes[0])) throw new Error('Use output.nextOffset for a UTF-8 character boundary.');
    let end = Math.min(bytes.length, limit);
    while (end > start && end < bytes.length && continuation(bytes[end])) end--;
    return { text: bytes.subarray(start, end).toString('utf8'),
      truncated: offset + start > 0 || offset + end < this.totalBytes,
      output: { offset: offset + start, nextOffset: offset + end, totalBytes: this.totalBytes,
        hasMore: offset + end < this.totalBytes } };
  }

  close() {
    this.closed = true;
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }
}
