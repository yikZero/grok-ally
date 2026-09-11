import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const HISTORY_PAGE = 20;
export const HISTORY_PAGE_BYTES = 16000;

// Sanitized tool-state snapshots live outside the workspace; only bounded pages enter MCP replies.
export class ToolHistory {
  totalRecords = 0;
  starts = [];
  end = 0;

  append(record) {
    if (this.closed) throw new Error('Tool history storage is closed.');
    if (this.fd === undefined) {
      this.directory = mkdtempSync(path.join(tmpdir(), 'grok-ally-tools-'));
      this.fd = openSync(path.join(this.directory, 'history.jsonl'), 'wx+', 0o600);
    }
    const bytes = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(this.fd, bytes, written, bytes.length - written, this.end + written);
      if (!count) throw new Error('Could not save tool history.');
      written += count;
    }
    this.starts.push(this.end);
    this.end += bytes.length;
    this.totalRecords++;
  }

  readRecord(index) {
    const start = this.starts[index];
    const size = (index + 1 < this.starts.length ? this.starts[index + 1] : this.end) - start;
    const bytes = Buffer.alloc(size);
    const count = readSync(this.fd, bytes, 0, size, start);
    if (count !== size) throw new Error('Saved tool history is incomplete.');
    return JSON.parse(bytes.toString('utf8'));
  }

  page(offset, limit = HISTORY_PAGE) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.totalRecords) {
      throw new Error('toolOffset must be between 0 and toolHistory.totalRecords.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('toolLimit must be between 1 and 100.');
    }
    const max = Math.min(offset + limit, this.totalRecords);
    const envelope = records => ({ offset, nextOffset: offset + records.length,
      totalRecords: this.totalRecords, hasMore: offset + records.length < this.totalRecords, records });
    const records = [];
    for (let i = offset; i < max; i++) {
      const record = this.readRecord(i);
      const candidate = envelope([...records, record]);
      if (records.length && Buffer.byteLength(JSON.stringify(candidate)) > HISTORY_PAGE_BYTES) break;
      records.push(record);
    }
    const toolHistory = envelope(records);
    if (records.length === 1 && Buffer.byteLength(JSON.stringify(toolHistory)) > HISTORY_PAGE_BYTES) {
      throw new Error(`Tool history record at toolOffset ${offset} exceeds the ${HISTORY_PAGE_BYTES}-byte page budget.`);
    }
    return { toolHistory };
  }

  close() {
    this.closed = true;
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }
}
