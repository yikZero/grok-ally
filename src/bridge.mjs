import { randomUUID } from 'node:crypto';
import { GrokSession, safeError, workspace } from './grok.mjs';

const RUNNING = new Set(['starting', 'running', 'cancelling']);
const MAX_TEXT = 64000;

export class Bridge {
  constructor({ Session = GrokSession, idleMs = 300000, turnMs = 3600000, cancelMs = 5000 } = {}) {
    Object.assign(this, { Session, idleMs, turnMs, cancelMs });
    // ponytail: leases are process-local; add disk leases before concurrent hosts may prompt the same session.
    this.sessions = new Set();
    this.jobs = new Map();
  }

  start(input) {
    const options = { ...input, cwd: workspace(input.cwd) };
    if (options.sessionId && (options.model || options.effort)) {
      throw new Error('model and effort apply only to a new session; omit them when continuing.');
    }
    let session = [...this.sessions].find(s => s.sessionId === options.sessionId && options.sessionId);
    if (session && !session.busy && session.connection?.signal.aborted) {
      this.drop(session);
      session = undefined;
    }
    if (session) {
      if (session.busy) throw new Error('This session already has an active turn. Wait or cancel it first.');
      if (session.options.cwd !== options.cwd || session.options.write !== options.write || session.options.maxTurns !== options.maxTurns) {
        throw new Error('A live session must keep the same cwd, write and maxTurns settings.');
      }
      clearTimeout(session.idleTimer);
    } else {
      if (this.sessions.size >= 4) {
        const idle = [...this.sessions].find(s => !s.busy);
        if (!idle) throw new Error('Four Grok sessions are active. Wait or cancel one first.');
        this.drop(idle);
      }
      session = new this.Session(options, update => this.update(session, update));
      this.sessions.add(session);
    }
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < 100) break;
      if (!RUNNING.has(job.status)) this.jobs.delete(id);
    }
    const job = { requestId: randomUUID(), sessionId: session.sessionId || null, status: 'starting',
      text: '', truncated: false, tools: [], session, cwd: options.cwd, write: options.write };
    session.busy = job;
    this.jobs.set(job.requestId, job);
    job.done = this.run(job, options.prompt);
    return job;
  }

  async run(job, prompt) {
    const session = job.session;
    const timeout = setTimeout(() => {
      job.error = 'Turn exceeded one hour; cancelled. Partial output and sessionId are retained.';
      this.cancel(job.requestId);
    }, this.turnMs);
    try {
      if (!session.ready) {
        job.sessionId = await session.initialize();
        session.ready = true;
      }
      if (job.status === 'cancelling') { job.status = 'cancelled'; return; }
      job.status = 'running';
      const result = await session.prompt(prompt);
      job.stopReason = result.stopReason;
      job.status = job.error ? 'failed' : job.status === 'cancelling' || result.stopReason === 'cancelled'
        ? 'cancelled' : result.stopReason === 'end_turn' ? 'completed' : 'incomplete';
    } catch (error) {
      const cancelled = job.status === 'cancelling';
      job.status = cancelled && !job.error ? 'cancelled' : 'failed';
      if (!cancelled) job.error = safeError(error);
      this.drop(session);
    } finally {
      clearTimeout(timeout);
      clearTimeout(job.cancelTimer);
      session.busy = null;
      if (this.sessions.has(session)) {
        session.idleTimer = setTimeout(() => this.drop(session), this.idleMs);
        session.idleTimer.unref();
      }
    }
  }

  update(session, update) {
    const job = session.busy;
    if (!job) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const text = job.text + update.content.text;
      job.text = text.slice(0, MAX_TEXT);
      job.truncated ||= text.length > MAX_TEXT;
    } else if (update.sessionUpdate === 'tool_call' && job.tools.length < 100) {
      job.tools.push({ id: update.toolCallId, title: String(update.title || 'tool').slice(0, 200),
        kind: update.kind, status: update.status });
    } else if (update.sessionUpdate === 'tool_call_update') {
      const tool = job.tools.find(t => t.id === update.toolCallId);
      if (tool && update.status) tool.status = update.status;
    }
    // Thought streams and raw tool inputs/outputs are not part of the chat result.
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown requestId (or bridge restarted). Continue with the saved sessionId and cwd.');
    return job;
  }

  snapshot(job) {
    return { requestId: job.requestId, sessionId: job.sessionId, status: job.status,
      cwd: job.cwd, write: job.write, text: job.text, truncated: job.truncated,
      tools: job.tools, ...(job.stopReason ? { stopReason: job.stopReason } : {}),
      ...(job.error ? { error: job.error } : {}) };
  }

  async wait(job, seconds = 25, extra, cancelOnAbort = false) {
    let timer;
    let finishWait;
    const deadline = new Promise(resolve => {
      finishWait = resolve;
      timer = setTimeout(resolve, seconds * 1000);
    });
    const abort = () => {
      if (cancelOnAbort) this.cancel(job.requestId);
      finishWait();
    };
    extra?.signal?.addEventListener('abort', abort, { once: true });
    if (extra?.signal?.aborted) abort();
    let progress = 0;
    const token = extra?._meta?.progressToken;
    const progressTimer = token === undefined ? null : setInterval(() => {
      void extra.sendNotification({ method: 'notifications/progress', params: {
        progressToken: token, progress: ++progress,
        message: `Grok ${job.status}${job.sessionId ? ` · ${job.sessionId}` : ''} · ${job.text.length} characters`,
      } }).catch(() => {});
    }, 1000);
    try {
      await Promise.race([job.done, deadline]);
      return this.snapshot(job);
    } finally {
      clearTimeout(timer);
      clearInterval(progressTimer);
      extra?.signal?.removeEventListener('abort', abort);
    }
  }

  cancel(id) {
    const job = this.get(id);
    if (RUNNING.has(job.status) && job.status !== 'cancelling') {
      job.status = 'cancelling';
      if (job.session.sessionId) void job.session.cancel().catch(() => this.drop(job.session));
      else this.drop(job.session);
      job.cancelTimer = setTimeout(() => this.drop(job.session), this.cancelMs);
    }
    return this.snapshot(job);
  }

  drop(session) {
    clearTimeout(session.idleTimer);
    session.close();
    this.sessions.delete(session);
  }

  close() { for (const session of this.sessions) this.drop(session); }
}
