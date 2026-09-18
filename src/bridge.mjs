import { randomUUID } from 'node:crypto';
import { CLOSE_MS, safeError, TERM_MS, workspace } from './grok.mjs';
import { providerFor, sessionKey, sessions } from './providers.mjs';
import { ToolHistory, HISTORY_PAGE } from './history.mjs';
import { Output } from './output.mjs';
import { isAlive, waitUntil } from './process.mjs';

const RUNNING = new Set(['starting', 'running', 'cancelling']);
const ACTIVE_TOOL = new Set(['pending', 'in_progress']);
const MAX_RECENT_TOOLS = 100;
const FAILURE_REASON_CHARS = 240;
const now = () => new Date().toISOString();
const clip = (value, max) => safeError(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const title = value => clip(value || 'tool', 200);

function failureExcerpt(content) {
  if (!Array.isArray(content)) return;
  const parts = [];
  for (const item of content) {
    const block = item?.type === 'content' ? item.content : undefined;
    if (block?.type === 'text' && block.text) parts.push(String(block.text));
  }
  if (!parts.length) return;
  const text = clip(parts.join(' '), FAILURE_REASON_CHARS).trim();
  return text || undefined;
}

function fingerprint(tool) {
  return JSON.stringify({ id: tool.id, title: tool.title, status: tool.status, kind: tool.kind ?? null,
    locations: tool.locations ?? null, reportedStatus: tool.reportedStatus ?? null, reason: tool.reason ?? null });
}

export class Bridge {
  constructor({ Session, idleMs = 300000, turnMs = 3600000, closeMs = CLOSE_MS, termMs = TERM_MS } = {}) {
    Object.assign(this, { Session, idleMs, turnMs, closeMs, termMs });
    // ponytail: leases are process-local; add disk leases before concurrent hosts may prompt the same session.
    this.sessions = new Set();
    this.jobs = new Map();
    this.retiring = new Set();
  }

  start(input) {
    const options = { ...input, provider: providerFor(input), cwd: workspace(input.cwd) };
    if (options.sessionId && (options.model || options.effort)) {
      throw new Error('model and effort apply only to a new session; omit them when continuing.');
    }
    if (options.sessionId && this.retiring.has(sessionKey(options.sessionId))) {
      throw new Error('This session already has an active turn. Wait or cancel it first.');
    }
    let session = [...this.sessions].find(s => options.sessionId && sessionKey(s.sessionId) === sessionKey(options.sessionId));
    if (session && !session.busy && session.connection?.signal.aborted) {
      this.drop(session);
      session = undefined;
    }
    if (session) {
      if (session.sessionId !== options.sessionId) throw new Error('Use the original sessionId, including its model settings.');
      if (session.busy) throw new Error('This session already has an active turn. Wait or cancel it first.');
      if (session.options.cwd !== options.cwd || session.options.write !== options.write) {
        throw new Error('A live session must keep the same cwd and write settings.');
      }
      clearTimeout(session.idleTimer);
    } else {
      if (this.sessions.size >= 4) {
        const idle = [...this.sessions].find(s => !s.busy);
        if (!idle) throw new Error('Four sessions are active. Wait or cancel one first.');
        this.drop(idle);
      }
      const Session = this.Session || sessions[options.provider];
      session = new Session(options, update => this.update(session, update));
      this.sessions.add(session);
    }
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < 100) break;
      if (!RUNNING.has(job.status)) { this.release(job); this.jobs.delete(id); }
    }
    const job = { requestId: randomUUID(), sessionId: session.sessionId || null, status: 'starting', provider: options.provider,
      output: new Output(), history: new ToolHistory(), tools: [], toolsById: new Map(), toolFingerprints: new Map(),
      toolTotals: { total: 0, failed: 0, unconfirmed: 0 }, latestFailure: null,
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
        if (job.status === 'cancelling' && job.sessionId) this.retiring.add(sessionKey(job.sessionId));
      }
      if (job.status === 'cancelling') {
        await job.cleanupDone;
        job.status = job.error ? 'failed' : 'cancelled';
        return;
      }
      job.status = 'running';
      this.touch(job);
      const result = await session.prompt(prompt);
      job.stopReason = result.stopReason;
      if (job.cleanupDone) {
        await job.cleanupDone;
        job.status = job.error ? 'failed' : 'cancelled';
        return;
      }
      if (result.stopReason === 'cancelled') {
        this.beginCleanup(job);
        await job.cleanupDone;
        job.status = job.error ? 'failed' : 'cancelled';
        return;
      }
      job.status = job.error ? 'failed' : result.stopReason === 'end_turn' ? 'completed' : 'incomplete';
    } catch (error) {
      if (job.cleanupDone) {
        await job.cleanupDone;
        job.status = job.error ? 'failed' : 'cancelled';
        return;
      }
      job.status = 'failed';
      job.error = safeError(error);
      this.drop(session);
    } finally {
      clearTimeout(timeout);
      if (job.status === 'cancelling' && job.cleanupDone) {
        await job.cleanupDone;
        if (job.status === 'cancelling') job.status = job.error ? 'failed' : 'cancelled';
      }
      if (job.sessionId) this.retiring.delete(sessionKey(job.sessionId));
      job.finishedAt = now();
      // A terminal prompt does not prove that a missing tool completion succeeded.
      const pending = [];
      for (const tool of job.tools) {
        if (!ACTIVE_TOOL.has(tool.status)) continue;
        tool.reportedStatus = tool.status;
        tool.status = 'unconfirmed';
        tool.revision = job.revision + 1;
        job.toolTotals.unconfirmed++;
        pending.push(tool);
      }
      for (const tool of pending) {
        try { this.recordHistory(job, tool); }
        catch (error) {
          job.status = 'failed';
          job.error ??= `Could not retain tool history: ${safeError(error)}`;
        }
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
        this.failRetain(job, 'complete output', error);
        return;
      }
      job.separateText = false;
      job.textRevision = job.revision + 1;
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      let tool = job.toolsById.get(update.toolCallId);
      if (!tool) {
        if (update.sessionUpdate !== 'tool_call') return;
        tool = { id: update.toolCallId, title: 'tool', status: 'pending', startedAt: now(), finishedAt: null };
        job.toolsById.set(tool.id, tool);
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
      if (tool.status !== 'failed') delete tool.reason;
      if (update.status === 'failed') {
        const reason = failureExcerpt(update.content);
        if (reason) tool.reason = reason;
        job.latestFailure = { id: tool.id, title: tool.title,
          ...(tool.reason ? { reason: tool.reason } : {}), recovery: 'unknown' };
      } else if (update.status === 'completed' && job.latestFailure?.id === tool.id) {
        job.latestFailure = { ...job.latestFailure, recovery: 'completed' };
      }
      tool.finishedAt = ACTIVE_TOOL.has(tool.status) ? null : tool.finishedAt || now();
      tool.revision = job.revision + 1;
      // Keep the most recently updated completed calls, plus every active call.
      const index = job.tools.indexOf(tool);
      if (index >= 0) job.tools.splice(index, 1);
      job.tools.push(tool);
      this.pruneTools(job);
      try { this.recordHistory(job, tool); }
      catch (error) {
        this.failRetain(job, 'tool history', error);
        return;
      }
    } else return;
    this.touch(job);
    // Thought streams and raw tool inputs/outputs are not part of the chat result.
  }

  recordHistory(job, tool) {
    const next = fingerprint(tool);
    if (job.toolFingerprints.get(tool.id) === next) return;
    job.history.append({
      record: job.history.totalRecords, id: tool.id, title: tool.title, status: tool.status,
      ...(tool.kind != null ? { kind: tool.kind } : {}),
      ...(tool.locations?.length ? { locations: tool.locations } : {}),
      ...(tool.reportedStatus ? { reportedStatus: tool.reportedStatus } : {}),
      startedAt: tool.startedAt, ...(tool.finishedAt ? { finishedAt: tool.finishedAt } : {}),
      ...(tool.reason ? { reason: tool.reason } : {}),
    });
    job.toolFingerprints.set(tool.id, next);
  }

  failRetain(job, what, error) {
    job.outputError = true;
    job.error = `Could not retain ${what}: ${safeError(error)}`;
    this.cancel(job.requestId);
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

  release(job) {
    job.output.close();
    job.history.close();
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown requestId. Use grok_status with cwd to find recent requests. After a bridge restart, continue with the saved sessionId and cwd.');
    return job;
  }

  list(cwd) {
    cwd = workspace(cwd);
    const jobs = [...this.jobs.values()].reverse().filter(job => job.cwd === cwd)
      .map(({ requestId, sessionId, provider, status, write, createdAt, finishedAt, lastProgressAt, revision }) =>
        ({ requestId, sessionId, provider, status, write, createdAt, finishedAt, lastProgressAt, revision }));
    return { cwd, active: jobs.filter(job => RUNNING.has(job.status)),
      recent: jobs.filter(job => !RUNNING.has(job.status)).slice(0, 10) };
  }

  snapshot(job, query = {}) {
    let { afterRevision, outputOffset, outputLimit, toolOffset, toolLimit, detail = 'full' } = query;
    if (outputLimit !== undefined && outputOffset === undefined) outputOffset = 0;
    if (toolLimit !== undefined && toolOffset === undefined) toolOffset = 0;
    const active = job.tools.filter(t => ACTIVE_TOOL.has(t.status));
    const unconfirmed = job.tools.filter(t => t.status === 'unconfirmed');
    const state = active.length ? 'active' : unconfirmed.length ? 'unconfirmed' : 'confirmed';
    const changed = afterRevision === undefined || job.revision > afterRevision;
    const compact = detail === 'compact';
    const outputPaging = outputOffset !== undefined;
    const toolPaging = toolOffset !== undefined;
    const paging = outputPaging || toolPaging;
    const data = { requestId: job.requestId, sessionId: job.sessionId, provider: job.provider, status: job.status,
      ...(job.session?.model ? { model: job.session.model, mode: job.session.mode } : {}),
      revision: job.revision, changed,
      ...(job.stopReason ? { stopReason: job.stopReason } : {}),
      ...(job.error ? { error: job.error } : {}) };
    if (job.cleanup && (!compact || changed) && !toolPaging) {
      data.cleanup = {
        state: job.cleanup.state, scope: job.cleanup.scope,
        ...(job.cleanup.reason ? { reason: job.cleanup.reason } : {}),
        ...(job.cleanup.remaining?.length ? { remaining: job.cleanup.remaining } : {}),
      };
    }
    if (toolPaging) return Object.assign(data, job.history.page(toolOffset, toolLimit ?? HISTORY_PAGE));
    const duration = started => Math.max(0, Date.parse(job.finishedAt || now()) - Date.parse(started));
    if (!compact) Object.assign(data, { cwd: job.cwd, write: job.write, createdAt: job.createdAt,
      finishedAt: job.finishedAt, lastProgressAt: job.lastProgressAt });
    if (!compact || (changed && !paging)) {
      data.toolSummary = { ...job.toolTotals, active: active.length,
        unfinished: active.length + job.toolTotals.unconfirmed, dropped: job.toolTotals.total - job.tools.length,
        state, historyRecords: job.history?.totalRecords ?? 0 };
      if (job.latestFailure) data.latestFailure = job.latestFailure;
    }
    if (compact && changed && !paging) {
      data.elapsedMs = duration(job.createdAt);
      data.lastProgressAt = job.lastProgressAt;
      if (job.finishedAt) data.finishedAt = job.finishedAt;
      if (active.length) data.currentTools = active.slice(0, 3).map(tool => ({ id: tool.id,
        title: tool.title, status: tool.status, durationMs: duration(tool.startedAt) }));
      if (!RUNNING.has(job.status) && unconfirmed.length) {
        data.unconfirmedTools = unconfirmed.slice(0, 3).map(tool => ({
          id: tool.id, title: tool.title, reportedStatus: tool.reportedStatus }));
      }
    } else if (!compact && changed) {
      data.tools = job.tools.filter(tool => afterRevision === undefined || tool.revision > afterRevision)
        .map(({ revision, ...tool }) => ({ ...tool,
          durationMs: tool.finishedAt ? Math.max(0, Date.parse(tool.finishedAt) - Date.parse(tool.startedAt)) : duration(tool.startedAt) }));
    }
    const includeText = outputPaging || ((!compact || !RUNNING.has(job.status))
      && (afterRevision === undefined || (compact ? changed : job.textRevision > afterRevision)));
    if (includeText) {
      Object.assign(data, job.output.page(outputOffset, outputLimit));
    } else if (!compact || changed) data.output = { totalBytes: job.output.totalBytes };
    return data;
  }

  async wait(job, seconds = 25, extra, cancelOnAbort = false, query = {}) {
    if (query.afterRevision > job.revision) throw new Error('afterRevision is newer than this request. Use its last returned revision.');
    let { outputOffset, outputLimit, toolOffset, toolLimit } = query;
    if (outputLimit !== undefined && outputOffset === undefined) outputOffset = 0;
    if (toolLimit !== undefined && toolOffset === undefined) toolOffset = 0;
    if (outputOffset > job.output.totalBytes) throw new Error('outputOffset must be between 0 and output.totalBytes.');
    if (toolOffset > (job.history?.totalRecords ?? 0)) throw new Error('toolOffset must be between 0 and toolHistory.totalRecords.');
    const outputReady = outputOffset !== undefined && (query.afterRevision === undefined
      || (query.afterRevision === job.revision && outputOffset < job.output.totalBytes));
    if (!RUNNING.has(job.status) || outputReady || toolOffset !== undefined) {
      return this.snapshot(job, { ...query, outputOffset, toolOffset });
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
        message: `${job.provider} ${job.status} · ${job.toolTotals.total} tools · ${job.output.totalBytes} bytes`
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
    if (RUNNING.has(job.status) && job.status !== 'cancelling') this.beginCleanup(job);
    return this.snapshot(job, query);
  }

  beginCleanup(job) {
    if (job.cleanupDone) return;
    job.status = 'cancelling';
    job.session.cancelling = true;
    job.cleanup = { state: 'pending', scope: 'observed-local' };
    if (job.session.sessionId) this.retiring.add(sessionKey(job.session.sessionId));
    this.touch(job, false);
    job.cleanupDone = this.retire(job);
  }

  async bound(promise, ms) {
    if (promise == null) return;
    let timer;
    try {
      await Promise.race([
        Promise.resolve(promise).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, ms); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async retire(job) {
    const session = job.session;
    const sessionId = session.sessionId || job.sessionId;
    if (sessionId) this.retiring.add(sessionKey(sessionId));
    try {
      session.snapshotOwned?.();
      if (session.sessionId) await this.bound(session.cancel?.(), this.closeMs);
      await this.bound(session.closeSession?.(), this.closeMs);
      session.snapshotOwned?.();
      clearTimeout(session.idleTimer);
      session.close();
      const leftover = await this.waitGone(session);
      this.sessions.delete(session);
      job.cleanup = this.cleanupResult(session, leftover);
    } catch (error) {
      this.drop(session);
      job.cleanup = { state: 'unconfirmed', scope: 'observed-local', reason: clip(safeError(error), 240) };
    }
    this.touch(job, false);
  }

  async waitGone(session) {
    const budget = this.termMs + TERM_MS;
    if (typeof session.remainingOwned !== 'function' && !session.child?.pid) return [];
    if (session.listUnknown || session.treeCleanup === false) {
      await waitUntil(() => !session.child?.pid || !isAlive(session.child.pid), budget);
      return [];
    }
    if (!session.child?.pid) return session.remainingOwned?.() ?? [];
    await waitUntil(() => session.remainingOwned().length === 0 && !isAlive(session.child?.pid), budget);
    return session.remainingOwned?.() ?? [];
  }

  cleanupResult(session, leftover) {
    if (session?.treeCleanup === false || process.platform === 'win32') {
      return { state: 'unconfirmed', scope: 'observed-local',
        reason: 'Process tree cleanup is not supported on this platform.' };
    }
    if (session?.listUnknown) {
      return { state: 'unconfirmed', scope: 'observed-local', reason: session.listUnknown };
    }
    if (leftover.length) {
      return { state: 'unconfirmed', scope: 'observed-local',
        remaining: leftover.slice(0, 8).map(item => ({ pid: item.pid, reason: item.reason || 'still running' })) };
    }
    return { state: 'confirmed', scope: 'observed-local' };
  }

  drop(session) {
    clearTimeout(session.idleTimer);
    session.close();
    this.sessions.delete(session);
  }

  close() {
    for (const session of this.sessions) this.drop(session);
    for (const job of this.jobs.values()) this.release(job);
  }
}
