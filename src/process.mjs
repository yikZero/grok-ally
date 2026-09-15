import { execFileSync } from 'node:child_process';

// One-shot POSIX process identity. No retries, no command/cwd matching, no Windows tree claims.

export function hostGuard() {
  const listed = listProcesses();
  const self = listed.processes.get(process.pid);
  return {
    pids: new Set([process.pid, process.ppid].filter(n => Number.isInteger(n) && n > 0)),
    pgids: new Set([self?.pgid, process.pid, process.ppid].filter(n => Number.isInteger(n) && n > 1)),
  };
}

export function listProcesses() {
  if (process.platform === 'win32') {
    return { ok: false, reason: 'Process tree cleanup is not supported on this platform.', processes: new Map() };
  }
  try {
    const stdout = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 2_000_000,
    });
    return { ok: true, processes: parsePs(stdout) };
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'ps is unavailable.' : 'Could not list local processes.';
    return { ok: false, reason, processes: new Map() };
  }
}

export function parsePs(stdout) {
  const processes = new Map();
  for (const line of String(stdout).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]), ppid = Number(match[2]), pgid = Number(match[3]);
    const start = match[4].trim();
    if (pid > 0) processes.set(pid, { pid, ppid, pgid, start });
  }
  return processes;
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export function sameIdentity(recorded, live) {
  return Boolean(live && recorded
    && recorded.pid === live.pid
    && recorded.pgid === live.pgid
    && recorded.start != null && recorded.start === live.start);
}

export function descendants(rootPid, processes) {
  const kids = new Map();
  for (const proc of processes.values()) {
    const list = kids.get(proc.ppid);
    if (list) list.push(proc);
    else kids.set(proc.ppid, [proc]);
  }
  const found = [];
  const stack = [rootPid];
  const seen = new Set([rootPid]);
  while (stack.length) {
    const pid = stack.pop();
    for (const child of kids.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      stack.push(child.pid);
    }
  }
  return found;
}

export function collectOwned(rootPid, { processes, recorded = [], guard } = {}) {
  const forbidden = guard?.pids || new Set();
  const hostPgids = guard?.pgids || new Set();
  const recordedRoot = recorded.find(rec => rec.pid === rootPid);
  const liveRoot = processes.get(rootPid);
  const rootTrusted = recordedRoot ? sameIdentity(recordedRoot, liveRoot) : Boolean(liveRoot);
  const tree = rootTrusted && rootPid ? descendants(rootPid, processes) : [];
  const treePids = rootTrusted
    ? new Set([rootPid, ...tree.map(p => p.pid)].filter(n => Number.isInteger(n)))
    : new Set();
  const groups = new Set();
  const adopt = pgid => {
    if (!Number.isInteger(pgid) || pgid <= 1) return;
    if (hostPgids.has(pgid) || forbidden.has(pgid)) return;
    if (pgid === process.pid || pgid === process.ppid) return;
    groups.add(pgid);
  };
  const root = rootTrusted ? liveRoot : undefined;
  // Live tree: only a group whose leader is still in this tree.
  if (root && treePids.has(root.pgid)) adopt(root.pgid);
  for (const proc of tree) {
    if (treePids.has(proc.pgid)) adopt(proc.pgid);
  }
  const matched = [];
  for (const rec of recorded) {
    const live = processes.get(rec.pid);
    if (!sameIdentity(rec, live)) continue;
    matched.push(live);
    // A still-matching member/leader is the only valid group anchor after reparent.
    adopt(live.pgid);
  }
  const result = new Map();
  const add = proc => {
    if (!proc || proc.pid <= 1) return;
    if (forbidden.has(proc.pid) || proc.pid === process.pid || proc.pid === process.ppid) return;
    result.set(proc.pid, proc);
  };
  if (root) add(root);
  for (const proc of tree) add(proc);
  for (const proc of processes.values()) {
    if (groups.has(proc.pgid)) add(proc);
  }
  for (const live of matched) add(live);
  return { processes: [...result.values()], groups };
}

export function isOwnedBy(proc, rootPid, { processes, recorded = [], guard } = {}) {
  if (!proc || proc.pid <= 1) return false;
  if (guard?.pids.has(proc.pid) || proc.pid === process.pid || proc.pid === process.ppid) return false;
  if (proc.pid === rootPid) return true;
  let current = proc;
  for (let i = 0; i < 32 && current; i++) {
    if (current.ppid === rootPid) return true;
    if (current.ppid <= 1 || guard?.pids.has(current.ppid) || current.ppid === process.pid) return false;
    current = processes.get(current.ppid);
  }
  return collectOwned(rootPid, { processes, recorded, guard }).processes.some(p => p.pid === proc.pid);
}

export function signalPid(pid, sig, guard) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (guard?.pids.has(pid) || pid === process.pid || pid === process.ppid) return false;
  try { process.kill(pid, sig); return true; }
  catch { return false; }
}

export function signalGroup(pgid, sig, guard) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (guard?.pgids.has(pgid) || guard?.pids.has(pgid)) return false;
  if (pgid === process.pid || pgid === process.ppid) return false;
  try { process.kill(-pgid, sig); return true; }
  catch { return false; }
}

export async function waitUntil(pred, ms, step = 40) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(resolve => setTimeout(resolve, step));
  }
  return pred();
}
