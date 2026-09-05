// Deterministic response-size fixture. No provider calls or tokenizer dependency.
// Optional argument: another checkout's src/bridge.mjs for an identical baseline run.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const moduleUrl = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : new URL('../src/bridge.mjs', import.meta.url).href;
const { Bridge } = await import(moduleUrl);
class Session {
  constructor(options, update) { this.options = options; this.update = update; }
  async initialize() { return this.sessionId = 'benchmark-session'; }
  prompt() { return new Promise(resolve => { this.finish = () => resolve({ stopReason: 'end_turn' }); }); }
  close() { this.finish?.(); }
}

const bridge = new Bridge({ Session });
const job = bridge.start({ cwd: tmpdir(), prompt: 'benchmark', write: false });
const samples = { running: [], unchanged: [], pages: [] };
const encode = result => JSON.stringify({ ...result, requestId: '00000000-0000-4000-8000-000000000000' });
const text = '阶段进展：正在检查实现与验收条件。'.repeat(30) + '\n';
try {
  // Let the fake session initialize before delivering controlled ACP events.
  await Promise.resolve();
  let afterRevision = job.revision;
  for (let i = 0; i < 120; i++) {
    job.session.update({ sessionUpdate: 'tool_call', toolCallId: `tool-${i}`, title: `Read src/module-${i}.mjs`, status: 'in_progress' });
    job.session.update({ sessionUpdate: 'tool_call_update', toolCallId: `tool-${i}`, status: 'completed' });
    job.session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    if (i % 10 === 9) {
      samples.running.push(encode(bridge.snapshot(job, { detail: 'compact', afterRevision })));
      afterRevision = job.revision;
    }
  }
  for (let i = 0; i < 12; i++) samples.unchanged.push(encode(bridge.snapshot(job, { detail: 'compact', afterRevision: job.revision })));
  const conclusion = '最终结论：120 个文件已核对，完整正文保持不变。';
  job.session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: conclusion } });
  job.session.finish();
  await job.done;
  let offset = 0, reconstructed = '', page;
  do {
    page = bridge.snapshot(job, { detail: 'compact', outputOffset: offset, outputLimit: 16000 });
    samples.pages.push(encode(page));
    reconstructed += page.text;
    offset = page.output.nextOffset;
  } while (page.output.hasMore);
  assert.equal(reconstructed, Array.from({ length: 120 }, () => text).join('\n\n') + conclusion);
  console.log(JSON.stringify({ answerBytes: Buffer.byteLength(reconstructed),
    cases: Object.fromEntries(Object.entries(samples).map(([name, replies]) => [name, {
      calls: replies.length, textBytes: replies.reduce((sum, text) => sum + Buffer.byteLength(text), 0), replies,
    }])) }));
} finally { bridge.close(); }
