import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  const stateFile = resolveStateFile(cwd);
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  fs.renameSync(tmpFile, stateFile); // atomic replace; readers never see a partial file
  return nextState;
}

// Blocking sleep for a sync context (no busy-wait) via Atomics.wait.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Absolute-backstop timeout. A lock is normally reclaimed the instant its owner's
// PID is dead; this only forces reclaim of a lock whose PID still looks alive, to
// preserve liveness in the rare case a dead owner's PID was recycled by an
// unrelated live process. It is deliberately far longer than any real critical
// section (a state.json read-modify-write is milliseconds), so a genuinely live
// holder is never reclaimed by it -- only one wedged/suspended past 10 minutes,
// which is indistinguishable from dead.
const LOCK_BACKSTOP_MS = 600000;

// Lock files live under a per-workspace OS temp dir (see resolveStateDir), i.e. a
// single host, so a PID read from a lock refers to a process on this machine and
// process.kill(pid, 0) is a valid liveness probe.
function ownerAlive(id) {
  const pid = Number.parseInt(String(id).split(".")[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return false; // empty/garbled => not a live owner
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not ours (still alive); ESRCH => dead
  }
}

function isAbandoned(id, mtimeMs) {
  if (!ownerAlive(id)) return true;                    // dead owner -> reclaimable
  return Date.now() - mtimeMs > LOCK_BACKSTOP_MS;      // else only the far backstop
}

// Publish a lock atomically: write the owner id into a unique temp file, then
// hard-link it onto the fixed path. linkSync is atomic and fails EEXIST if the
// path is already held, exactly like O_EXCL -- but unlike open()+write() the file
// has its full content the instant it appears at the path, so a concurrent reader
// can never observe an empty lock and mistake a just-created live lock for an
// abandoned one. Returns true if claimed, false if already held.
function claimLock(lockFile, ownerId) {
  const tmp = `${lockFile}.tmp.${ownerId}`;
  fs.writeFileSync(tmp, ownerId);
  try {
    fs.linkSync(tmp, lockFile);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Reclaim a lock only when its owner is gone, never a live one.
//
// Gated on PID liveness: a live owner -- even one working slowly or briefly
// frozen -- keeps a live PID and is never reclaimed, so this can only ever remove
// a lock whose owner is truly dead. A dead owner can neither release nor recreate
// its lock, and no other process can claim the path while it still exists, so
// removing it here cannot race a freshly acquired lock. (The earlier mtime-only
// reclaim was unsafe precisely because it could fire against a live owner and
// unlink a lock another process had recreated in the meantime.)
//
// Removal is serialized through a second reclaim lock so two reclaimers can't
// both act; that lock is atomically published, PID-stamped, only cleared when its
// holder is dead, and released only by its own owner.
function reclaimIfAbandoned(lockFile, reclaimFile, selfId) {
  let content, st;
  try {
    content = fs.readFileSync(lockFile, "utf8");
    st = fs.statSync(lockFile);
  } catch {
    return; // already gone
  }
  if (!isAbandoned(content, st.mtimeMs)) return; // live owner -> wait, don't touch
  if (!claimLock(reclaimFile, selfId)) {
    try {
      // A reclaim lock whose own holder died is safe to drop; a live one is left
      // alone (its PID is alive, so this never removes a reclaim in progress).
      const rc = fs.readFileSync(reclaimFile, "utf8");
      const rst = fs.statSync(reclaimFile);
      if (isAbandoned(rc, rst.mtimeMs)) fs.unlinkSync(reclaimFile);
    } catch {}
    return;
  }
  try {
    // Re-verify under the reclaim lock. The owner is still gone (a dead PID cannot
    // come back), and the path can't have been re-claimed while it exists, so
    // unlinking here cannot delete a live lock.
    const c2 = fs.readFileSync(lockFile, "utf8");
    const s2 = fs.statSync(lockFile);
    if (isAbandoned(c2, s2.mtimeMs)) fs.unlinkSync(lockFile);
  } catch {
    // lock vanished between checks -- fine, nothing to reclaim
  } finally {
    // Release the reclaim lock only if it is still ours.
    try {
      if (fs.readFileSync(reclaimFile, "utf8") === selfId) fs.unlinkSync(reclaimFile);
    } catch {}
  }
}

// Cross-process lock around the state.json read-modify-write. Without it,
// concurrent `task --background` launches each read the same base state, add
// only their own job, and clobber siblings on write (and saveState's prune
// then deletes the "orphan" job files). Serializing the RMW fixes both.
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), "state.lock");
  const reclaimFile = `${lockFile}.reclaim`;
  // "<pid>.<time>.<rand>": the PID lets other processes probe our liveness; the
  // full string is stamped into the lock so only the true owner removes it.
  const ownerId = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (claimLock(lockFile, ownerId)) break;
    reclaimIfAbandoned(lockFile, reclaimFile, ownerId);
    if (Date.now() > deadline) throw new Error("Timed out acquiring Codex state lock");
    sleepSync(20 + Math.floor(Math.random() * 30)); // jittered backoff
  }
  try {
    return fn();
  } finally {
    // Only remove the lock if we still own it: if we were ever reclaimed (e.g.
    // frozen past the fallback timeout), the contents no longer match ownerId and
    // we must not delete the lock another process now holds.
    try {
      if (fs.readFileSync(lockFile, "utf8") === ownerId) fs.unlinkSync(lockFile);
    } catch {}
  }
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
