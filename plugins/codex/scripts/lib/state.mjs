import { spawnSync } from "node:child_process";
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

// A per-process, restart-stable token identifying a specific process *instance*
// (not just its PID), so PID reuse can be told apart from the original owner.
// Lock files live under a per-workspace OS temp dir (see resolveStateDir), i.e. a
// single host, so the PID refers to a process on this machine.
//
// The source is chosen by platform and never mixed: two renderings of the same
// live process must compare equal, so we must not stamp with one source and check
// with another. Returns null when the process is gone or its start time can't be
// read (callers treat null conservatively -- never as "different instance").
//   - Linux: /proc/<pid>/stat field 22 is the process start time (clock ticks
//     since boot); read directly, no subprocess.
//   - else (macOS/BSD): `ps -o lstart` is the start timestamp, stable for the
//     process lifetime. The env is pinned (TZ/locale) because lstart is rendered
//     with strftime and would otherwise differ between a stamper and a checker
//     running under different TZ/LC settings. spawnSync is only reached on the
//     (rare) reclaim path, never on the uncontended fast path.
function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm (field 2) may contain spaces/parens; the numeric fields start after
      // the last ')'. starttime is field 22 => index 19 of that remainder.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      if (rest[19]) return `L:${rest[19]}`;
    } catch {}
    return null; // no cross-source fallback -- see note above
  }
  try {
    const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC0", LC_ALL: "C", LANG: "C" },
    });
    if (r.status === 0) {
      const s = (r.stdout || "").trim();
      if (s) return `P:${s}`;
    }
  } catch {}
  return null;
}

// A process that has exited but not yet been reaped by its parent is a zombie:
// process.kill(pid, 0) still succeeds and its start token is unchanged, so it
// would otherwise look like a live owner forever. Detect it so its lock is
// reclaimed instead of blocking every writer until the parent reaps it.
function isZombie(pid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // state (field 3) is the first token after the last ')'.
      return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] === "Z";
    } catch {
      return false;
    }
  }
  try {
    const r = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    return r.status === 0 && (r.stdout || "").trim().startsWith("Z");
  } catch {
    return false;
  }
}

// The lock owner is identified as "<pid>.<startTokenHex>.<time>.<rand>". Compute
// the current process's identity once per acquisition.
function selfOwnerId() {
  const tok = processStartToken(process.pid);
  const tag = tok ? Buffer.from(tok).toString("hex") : "0";
  return `${process.pid}.${tag}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

// True only when the exact process instance that wrote `id` is gone -- never for
// a live owner, no matter how long it has been holding the lock. This is what
// lets reclaim run without any time-based expiry: a suspended-but-alive holder is
// never reclaimed, and a dead owner whose PID was recycled is detected because
// the recycled process reports a different start token.
function isAbandoned(id) {
  const parts = String(id).split(".");
  const pid = Number.parseInt(parts[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return true; // empty/garbled -> not a live owner
  let alive;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === "EPERM"; // exists but not ours (still alive); ESRCH => dead
  }
  if (!alive) return true; // owner process is gone
  if (isZombie(pid)) return true; // exited but unreaped -> effectively gone
  // PID is alive. Only declare it abandoned if we can PROVE it is a different
  // instance. If the owner's stamp is unverifiable ("0"), or we can't read the
  // current start token, treat the live PID as the same instance and do NOT
  // reclaim -- otherwise a checker that *can* probe would delete a live owner's
  // lock whose owner merely failed to self-probe at stamp time. (pid-death
  // reclaim above still applies, so this never causes a permanent deadlock.)
  if (!parts[1] || parts[1] === "0") return false;
  const cur = processStartToken(pid);
  if (cur === null) return false;
  return Buffer.from(cur).toString("hex") !== parts[1]; // different instance => PID reuse => owner gone
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

// Reclaim a lock only when its owner instance is gone, never a live one.
//
// isAbandoned is true only for a dead owner (or a PID recycled by a different
// instance), so this never fires against the live owner. Removal is atomic via
// capture-by-rename: renameSync of the fixed path has exactly-one-winner
// semantics, so when several launches race to reclaim the same lock only one
// captures it and the losers get ENOENT and fall back to re-contending. The
// captor then confirms the file it captured is byte-for-byte the id it judged
// abandoned (the id embeds time+rand, so this is unique); if instead it captured
// a lock that had been recreated in the meantime -- i.e. possibly a live one --
// it restores it rather than deleting it. This needs no second lock, so there is
// no reclaim-lock to itself go stale and be cleaned up unsafely.
//
// Residual (fundamental to pure-fs locking): between the re-read and the rename
// below the lock could be reclaimed by someone else and freshly re-claimed by a
// live owner; renaming then captures that live lock, and if a third process
// claims the momentarily-absent path the restore relink loses (EEXIST) and the
// captured lock is dropped. The pre-rename re-read shrinks that window to ~2
// adjacent syscalls with no subprocess in it; isAbandoned (which may spawn `ps`)
// runs only *before* the re-read. Closing it completely needs an atomic
// conditional-delete / OS advisory lock (flock), which Node's fs builtins do not
// expose. Within that ~2-syscall window the worst case is a brief overlap (two
// writers) or a losing contender that errors out at the 15s acquire deadline;
// never a permanent deadlock, since a dead owner is always reclaimable next pass.
function reclaimIfAbandoned(lockFile, selfId) {
  let seen;
  try {
    seen = fs.readFileSync(lockFile, "utf8");
  } catch {
    return; // already gone
  }
  if (!isAbandoned(seen)) return; // live owner -> wait, don't touch
  const tomb = `${lockFile}.rip.${selfId}`;
  // Re-read immediately before capturing so isAbandoned's (possibly subprocess-
  // backed) probe is not inside the capture window: only proceed if the lock is
  // still the exact abandoned instance we judged.
  try {
    if (fs.readFileSync(lockFile, "utf8") !== seen) return;
  } catch {
    return; // vanished -- re-contend
  }
  try {
    fs.renameSync(lockFile, tomb); // atomic: exactly one reclaimer captures the path
  } catch {
    return; // lost the race (ENOENT) -- another reclaimer took it; re-contend
  }
  try {
    if (fs.readFileSync(tomb, "utf8") === seen) {
      fs.unlinkSync(tomb); // captured the exact abandoned instance we judged -> drop it
    } else {
      // Captured a lock recreated after our read -> may be live; put it back.
      try { fs.linkSync(tomb, lockFile); } catch {}
      fs.unlinkSync(tomb);
    }
  } catch {
    try { fs.unlinkSync(tomb); } catch {}
  }
}

// Cross-process lock around the state.json read-modify-write. Without it,
// concurrent `task --background` launches each read the same base state, add
// only their own job, and clobber siblings on write (and saveState's prune
// then deletes the "orphan" job files). Serializing the RMW fixes both.
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), "state.lock");
  // Identifies this exact process instance (pid + start-time), so others can tell
  // a live owner from a recycled PID; the full string is stamped into the lock so
  // only the true owner removes it on release.
  const ownerId = selfOwnerId();
  const deadline = Date.now() + 15000;
  for (;;) {
    if (claimLock(lockFile, ownerId)) break;
    reclaimIfAbandoned(lockFile, ownerId);
    if (Date.now() > deadline) throw new Error("Timed out acquiring Codex state lock");
    sleepSync(20 + Math.floor(Math.random() * 30)); // jittered backoff
  }
  try {
    return fn();
  } finally {
    // Only remove the lock if we still own it: if we were ever reclaimed, the
    // contents no longer match ownerId and we must not delete the lock another
    // process now holds.
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
