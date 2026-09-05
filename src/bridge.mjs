import { randomUUID } from 'node:crypto';
import { GrokSession, safeError, workspace } from './grok.mjs';
import { Output } from './output.mjs';

const RUNNING = new Set(['starting', 'running', 'cancelling']);
const ACTIVE_TOOL = new Set(['pending', 'in_progress']);
const MAX_RECENT_TOOLS = 100;
const now = () => new Date().toISOString();
const title = value => safeError(String(value || 'tool')).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);

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
      if (session.options.cwd !== options.cwd || session.options.write !== options.write) {
        throw new Error('A live session must keep the same cwd and write settings.');
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
      if (!RUNNING.has(job.status)) { job.output.close(); this.jobs.delete(id); }
    }
    const job = { requestId: randomUUID(), sessionId: session.sessionId || null, status: 'starting',
      output: new Output(), tools: [], toolTotals: { total: 0, failed: 0, unconfirmed: 0 },
      revision: 1, textRevision: 0, waiters: new Set(), session, cwd: options.cwd, write: options.write,
      createdAt: now(), finishedAt: null, lastProgressAt: now() };
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
      this.touch(job);
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
      job.finishedAt = now();
      // A terminal prompt does not prove that a missing tool completion succeeded.
      for (const tool of job.tools) {
        if (!ACTIVE_TOOL.has(tool.status)) continue;
        tool.reportedStatus = tool.status;
        tool.status = 'unconfirmed';
        tool.revision = job.revision + 1;
        job.toolTotals.unconfirmed++;
      }
      this.pruneTools(job);
      this.touch(job, false);
      // Order finished requests by completion, including long turns that started earlier.
      this.jobs.delete(job.requestId);
      this.jobs.set(job.requestId, job);
      session.busy = null;
      if (this.sessions.has(session)) {
        session.idleTimer = setTimeout(() => this.drop(session), this.idleMs);
        session.idleTimer.unref();
      }
    }
  }

  update(session, update) {
    const job = session.busy;
    if (!job || !RUNNING.has(job.status) || job.outputError) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
      const separator = job.separateText && job.output.totalBytes && job.output.ending !== '\n\n' ? '\n\n' : '';
      try { job.output.append(separator + update.content.text); }
      catch (error) {
        job.outputError = true;
        job.error = `Could not retain complete output: ${safeError(error)}`;
        this.cancel(job.requestId);
        return;
      }
      job.separateText = false;
      job.textRevision = job.revision + 1;
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      let tool = job.tools.find(t => t.id === update.toolCallId);
      if (!tool) {
        if (update.sessionUpdate !== 'tool_call') return;
        tool = { id: update.toolCallId, title: 'tool', status: 'pending', startedAt: now(), finishedAt: null };
        job.tools.push(tool);
        job.toolTotals.total++;
      }
      job.separateText = true;
      if (tool.status === 'failed') job.toolTotals.failed--;
      if (update.title != null) tool.title = title(update.title);
      if (update.kind != null) tool.kind = update.kind;
      if (update.locations != null) tool.locations = update.locations.slice(0, 10).map(({ path, line }) =>
        ({ path: title(path), ...(line != null ? { line } : {}) }));
      if (update.status != null) tool.status = update.status;
      if (tool.status === 'failed') job.toolTotals.failed++;
      tool.finishedAt = ACTIVE_TOOL.has(tool.status) ? null : tool.finishedAt || now();
      tool.revision = job.revision + 1;
      // Keep the most recently updated completed calls, plus every active call.
      job.tools.splice(job.tools.indexOf(tool), 1);
      job.tools.push(tool);
      this.pruneTools(job);
    } else return;
    this.touch(job);
    // Thought streams and raw tool inputs/outputs are not part of the chat result.
  }

  pruneTools(job) {
    const finished = tool => tool.status === 'completed' || tool.status === 'failed';
    let excess = job.tools.filter(finished).length - MAX_RECENT_TOOLS;
    job.tools = job.tools.filter(t => !finished(t) || excess-- <= 0);
  }

  touch(job, progress = true) {
    job.revision++;
    if (progress) job.lastProgressAt = now();
    for (const wake of job.waiters) wake();
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown requestId. Use grok_status with cwd to find recent requests. After a bridge restart, continue with the saved sessionId and cwd.');
    return job;
  }

  list(cwd) {
    cwd = workspace(cwd);
    const jobs = [...this.jobs.values()].reverse().filter(job => job.cwd === cwd)
      .map(({ requestId, sessionId, status, write, createdAt, finishedAt, lastProgressAt, revision }) =>
        ({ requestId, sessionId, status, write, createdAt, finishedAt, lastProgressAt, revision }));
    return { cwd, active: jobs.filter(job => RUNNING.has(job.status)),
      recent: jobs.filter(job => !RUNNING.has(job.status)).slice(0, 10) };
  }

  snapshot(job, { afterRevision, outputOffset, outputLimit, detail = 'full' } = {}) {
    const active = job.tools.filter(t => ACTIVE_TOOL.has(t.status));
    const changed = afterRevision === undefined || job.revision > afterRevision;
    const compact = detail === 'compact';
    const paging = outputOffset !== undefined;
    const data = { requestId: job.requestId, sessionId: job.sessionId, status: job.status,
      revision: job.revision, changed,
      ...(job.stopReason ? { stopReason: job.stopReason } : {}),
      ...(job.error ? { error: job.error } : {}) };
    const duration = started => Math.max(0, Date.parse(job.finishedAt || now()) - Date.parse(started));
    if (!compact) Object.assign(data, { cwd: job.cwd, write: job.write, createdAt: job.createdAt,
      finishedAt: job.finishedAt, lastProgressAt: job.lastProgressAt });
    if (!compact || (changed && !paging)) {
      data.toolSummary = { ...job.toolTotals, active: active.length,
        unfinished: active.length + job.toolTotals.unconfirmed, dropped: job.toolTotals.total - job.tools.length };
    }
    if (compact && changed && !paging) {
      data.elapsedMs = duration(job.createdAt);
      data.lastProgressAt = job.lastProgressAt;
      if (job.finishedAt) data.finishedAt = job.finishedAt;
      if (active.length) data.currentTools = active.slice(0, 3).map(tool => ({ id: tool.id,
        title: tool.title, status: tool.status, durationMs: duration(tool.startedAt) }));
    } else if (!compact && changed) {
      data.tools = job.tools.filter(tool => afterRevision === undefined || tool.revision > afterRevision)
        .map(({ revision, ...tool }) => ({ ...tool,
          durationMs: tool.finishedAt ? Math.max(0, Date.parse(tool.finishedAt) - Date.parse(tool.startedAt)) : duration(tool.startedAt) }));
    }
    const includeText = paging || ((!compact || !RUNNING.has(job.status))
      && (afterRevision === undefined || (compact ? changed : job.textRevision > afterRevision)));
    if (includeText) {
      Object.assign(data, job.output.page(outputOffset, outputLimit));
    } else if (!compact || changed) data.output = { totalBytes: job.output.totalBytes };
    return data;
  }

  async wait(job, seconds = 25, extra, cancelOnAbort = false, query = {}) {
    if (query.afterRevision > job.revision) throw new Error('afterRevision is newer than this request. Use its last returned revision.');
    if (query.outputOffset > job.output.totalBytes) throw new Error('outputOffset must be between 0 and output.totalBytes.');
    if (!RUNNING.has(job.status)
      || (query.outputOffset !== undefined && (query.afterRevision === undefined
        || (query.afterRevision === job.revision && query.outputOffset < job.output.totalBytes)))) {
      return this.snapshot(job, query);
    }
    let timer;
    let changeTimer;
    let finishWait;
    const deadline = new Promise(resolve => {
      finishWait = resolve;
      timer = setTimeout(resolve, seconds * 1000);
    });
    const abort = () => {
      if (cancelOnAbort) this.cancel(job.requestId);
      finishWait();
    };
    // Grok can stream a few bytes per event. Batch short bursts instead of one MCP reply per token.
    const onChange = () => {
      if (!RUNNING.has(job.status) || job.status === 'cancelling') finishWait();
      else changeTimer ??= setTimeout(finishWait, 200);
    };
    if (query.afterRevision !== undefined) {
      job.waiters.add(onChange);
      if (job.revision > query.afterRevision) onChange();
    }
    extra?.signal?.addEventListener('abort', abort, { once: true });
    if (extra?.signal?.aborted) abort();
    let progress = 0;
    const token = extra?._meta?.progressToken;
    const progressTimer = token === undefined ? null : setInterval(() => {
      const current = job.tools.find(t => ACTIVE_TOOL.has(t.status));
      void extra.sendNotification({ method: 'notifications/progress', params: {
        progressToken: token, progress: ++progress,
        message: `Grok ${job.status} · ${job.toolTotals.total} tools · ${job.output.totalBytes} bytes`
          + (current ? ` · ${current.title} (${Math.max(0, Math.floor((Date.now() - Date.parse(current.startedAt)) / 1000))}s)` : ''),
      } }).catch(() => {});
    }, 1000);
    try {
      await Promise.race([job.done, deadline]);
      return this.snapshot(job, query);
    } finally {
      clearTimeout(timer);
      clearTimeout(changeTimer);
      clearInterval(progressTimer);
      job.waiters.delete(onChange);
      extra?.signal?.removeEventListener('abort', abort);
    }
  }

  cancel(id, query) {
    const job = this.get(id);
    if (RUNNING.has(job.status) && job.status !== 'cancelling') {
      job.status = 'cancelling';
      this.touch(job, false);
      if (job.session.sessionId) void job.session.cancel().catch(() => this.drop(job.session));
      else this.drop(job.session);
      job.cancelTimer = setTimeout(() => this.drop(job.session), this.cancelMs);
    }
    return this.snapshot(job, query);
  }

  drop(session) {
    clearTimeout(session.idleTimer);
    session.close();
    this.sessions.delete(session);
  }

  close() {
    for (const session of this.sessions) this.drop(session);
    for (const job of this.jobs.values()) job.output.close();
  }
}
