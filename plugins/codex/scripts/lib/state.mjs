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
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// A job id becomes a filename, so reject anything that could escape the jobs dir.
function isValidJobId(id) {
  return typeof id === "string" && id.length > 0 && !id.includes("/") && !id.includes("\\") && id !== "." && id !== "..";
}

// Job state is stored one file per job under <stateDir>/jobs/<id>.json, and the
// job list is derived by scanning that directory. There is deliberately NO shared
// index and therefore NO cross-process lock: concurrent `task --background`
// launches (and session cleanup) operate on DIFFERENT files and cannot clobber
// each other, so the "a stale snapshot of a shared array overwrites a sibling
// job" corruption is impossible by construction rather than merely serialized.
// A rename publishes a whole record atomically, so a reader never observes a
// torn/partial file. Only `config` (rarely written, by /setup) lives in
// state.json. See PR openai/codex-plugin-cc#689 for the history behind this.

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

// Cancellation is expressed as a SEPARATE, immutable marker file, never by mutating
// the worker-owned record. `<id>.cancelled` is created atomically (O_EXCL) and never
// overwritten, so a cancellation can never be lost to a racing record write. Readers
// overlay it (a record with a live marker reads as cancelled) and the worker honors
// it. This is the compare-and-swap primitive the mutable-record design lacked.
export function resolveJobCancelFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.cancelled`);
}

// A per-session "ended" marker (also immutable, atomic-create). It closes the window
// where a task is enqueued AFTER session cleanup's one-shot directory scan: enqueue
// refuses, and a worker started in that window aborts, because both consult it.
// Hash (not sanitize) the session id into the marker filename, so distinct ids like
// "a/b" and "a-b" cannot collide onto the same marker.
function sessionEndedBasename(sessionId) {
  const hash = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return `session-${hash}.ended`;
}

export function resolveSessionEndedFile(cwd, sessionId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), sessionEndedBasename(sessionId));
}

// Create `file` atomically iff absent (wx). Returns true if we created it, false if it
// already existed. Any other error propagates. Used for the immutable markers.
function createMarkerFile(file, payload) {
  try {
    fs.writeFileSync(file, `${JSON.stringify({ ...payload, at: nowIso() }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false; // already marked; idempotent
    throw err;
  }
}

export function markJobCancelled(cwd, jobId, reason) {
  if (!isValidJobId(jobId)) return false;
  return createMarkerFile(resolveJobCancelFile(cwd, jobId), { reason: reason ?? "Cancelled." });
}

export function isJobCancelled(cwd, jobId) {
  if (!isValidJobId(jobId)) return false;
  return fs.existsSync(resolveJobCancelFile(cwd, jobId));
}

export function markSessionEnded(cwd, sessionId) {
  if (!sessionId) return false;
  return createMarkerFile(resolveSessionEndedFile(cwd, sessionId), { sessionId: String(sessionId) });
}

export function isSessionEnded(cwd, sessionId) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(resolveSessionEndedFile(cwd, sessionId));
  } catch {
    return false;
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

function uniqueTmp(file) {
  return `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
}

// Publish `value` at `file` atomically. The temp lives in the same directory (so
// rename is a same-filesystem atomic replace) and its name carries `.tmp.` so it
// is never mistaken for a job file by listJobs.
function atomicWriteJson(file, value) {
  const tmp = uniqueTmp(file);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // never leave a partial temp behind
    throw err;
  }
}

// Atomically create `file` iff it does not already exist, and return true; return false
// if it exists. Uses temp + hardlink (link fails with EEXIST if the target exists) so the
// published file is never torn. This is the single-writer CLAIM primitive: the first
// caller to create a job record owns it; a second caller (a duplicate id, a double worker
// launch, a racing migrator) gets false and must not proceed as owner.
function createJsonExclusive(file, value) {
  const tmp = uniqueTmp(file);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Claim job <id>'s record for the first time. Returns true on success, false if the
// record already exists (another enqueuer/worker owns it -- caller must not proceed).
export function claimJobRecord(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const now = nowIso();
  return createJsonExclusive(resolveJobFile(cwd, jobId), {
    ...payload,
    id: jobId,
    createdAt: payload.createdAt ?? now,
    updatedAt: now
  });
}

// ---------------------------------------------------------------------------
// Liveness (used only to keep pruning from evicting a live job)
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not ours (still alive); ESRCH => dead
  }
}

// ---------------------------------------------------------------------------
// Legacy migration: older installs kept a jobs[] index array in state.json, with some
// fields (startedAt, completedAt, summary, threadId, ...) living only in that index.
// Materialize each index entry as its per-job file, then rewrite state.json config-only.
// - No per-job file yet: create it exclusively (claim).
// - A per-job file exists AND has no live worker (isEvictable: terminal, or dead pid):
//   fold the index-only fields IN (payload wins on conflicts), so a finished job keeps
//   its summary/threadId/duration. This is safe precisely because no worker can be
//   writing that record.
// - A per-job file exists for a LIVE/booting job (queued pid-less, or running with a
//   live pid): leave it untouched -- a worker owns it, and legacy index metadata for an
//   active job is stale/minimal anyway. This is what keeps migration from racing a
//   worker (it now runs in the session hook too).
// Idempotent; after the first run state.json has no jobs array and this no-ops.
// ---------------------------------------------------------------------------

function migrateLegacyState(cwd) {
  const stateFile = resolveStateFile(cwd);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return; // no state.json (or unreadable) -> nothing to migrate
  }
  if (!parsed || !Array.isArray(parsed.jobs) || parsed.jobs.length === 0) {
    return;
  }
  ensureStateDir(cwd);
  for (const job of parsed.jobs) {
    if (!job || !isValidJobId(job.id)) continue;
    // `readJobRecord` is the RAW on-disk payload (NOT the cancel/session overlay), so
    // isEvictable() classifies the record by its true status: a marked-but-still-running
    // record still reads `running` here and is correctly treated as owned, not terminal.
    // The evictable set (raw terminal, or raw running with an ESRCH-dead pid) has no
    // process that can still write it -- there is no reclaimer of a dead-pid job in this
    // design -- so folding index metadata in cannot lose a live/booting worker's write.
    const existing = readJobRecord(cwd, job.id);
    if (existing == null) {
      createJsonExclusive(resolveJobFile(cwd, job.id), job);
    } else if (isEvictable(existing)) {
      atomicWriteJson(resolveJobFile(cwd, job.id), { ...job, ...existing }); // add index-only fields; payload wins
    }
    // else: a live/booting worker owns the record -> leave it alone
  }
  try {
    atomicWriteJson(stateFile, {
      version: STATE_VERSION,
      config: { stopReviewGate: false, ...(parsed.config ?? {}) }
    });
  } catch {
    // A concurrent migrator may have already rewritten it; harmless.
  }
}

// ---------------------------------------------------------------------------
// Config (state.json holds config only)
// ---------------------------------------------------------------------------

function readConfig(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
    return { stopReviewGate: false, ...(parsed?.config ?? {}) };
  } catch {
    return { stopReviewGate: false };
  }
}

export function getConfig(cwd) {
  migrateLegacyState(cwd);
  return readConfig(cwd);
}

export function setConfig(cwd, key, value) {
  ensureStateDir(cwd);
  migrateLegacyState(cwd);
  const config = { ...readConfig(cwd), [key]: value };
  atomicWriteJson(resolveStateFile(cwd), { version: STATE_VERSION, config });
  return config;
}

// ---------------------------------------------------------------------------
// Job records
// ---------------------------------------------------------------------------

function isJobFileName(name) {
  return name.endsWith(".json") && !name.includes(".tmp.");
}

function readJobRecord(cwd, jobId) {
  try {
    return JSON.parse(fs.readFileSync(resolveJobFile(cwd, jobId), "utf8"));
  } catch {
    return null;
  }
}

// The RAW (non-overlaid) pid currently on the record, or null. A canceller reads this
// AFTER creating the cancel marker (never before), so the marker/pid handshake holds:
// if the worker had already published its pid, we see it here and kill it; if not, the
// worker will see our marker on its post-pid re-check and self-abort.
export function readJobPid(cwd, jobId) {
  const pid = readJobRecord(cwd, jobId)?.pid;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Overlay the immutable markers onto a record so a caller observes a cancellation
// atomically with the record and can never see a cancelled job as live:
//  - a `<id>.cancelled` marker forces cancelled, authoritatively ("marked => cancelled,
//    full stop", overriding even a raced completion);
//  - a `session-<hash>.ended` marker forces cancelled for that session's still-LIVE
//    (queued/running) jobs -- a genuinely finished job keeps its terminal outcome.
// Completion payload (result/rendered) is dropped so a cancelled job never exposes a
// half-result. Side-effect free.
function overlayJob(job, cancelledMeta, endedNames) {
  if (!job || typeof job.id !== "string" || job.status === "cancelled") return job;
  const byCancel = cancelledMeta.has(job.id);
  const bySession =
    !byCancel && job.sessionId != null &&
    endedNames.has(sessionEndedBasename(job.sessionId)) &&
    !TERMINAL_STATUSES.has(job.status);
  if (!byCancel && !bySession) return job;
  // Surface the marker's own metadata (best-effort; marker EXISTENCE is authoritative
  // even if its JSON was unreadable) so a cancel that killed the worker before it could
  // publish a terminal record still shows a reason and timestamps.
  const meta = (byCancel ? cancelledMeta.get(job.id) : null) ?? {};
  const at = typeof meta.at === "string" ? meta.at : null;
  const { result, rendered, ...rest } = job;
  return {
    ...rest,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: rest.errorMessage ?? (typeof meta.reason === "string" ? meta.reason : rest.errorMessage),
    cancelledAt: rest.cancelledAt ?? at ?? undefined,
    completedAt: rest.completedAt ?? at ?? undefined
  };
}

// Scan the jobs dir ONCE: return the raw records plus the marker sets. Robust to
// concurrent create/delete/rename: a name that vanished mid-scan (ENOENT) or a record
// captured mid-write (parse-guarded) is skipped. `cancelledIds` is a Map id -> marker
// metadata ({reason, at}, or {} if the marker existed but was unparseable).
function scanJobsDir(cwd) {
  const dir = resolveJobsDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { jobs: [], cancelledIds: new Map(), endedNames: new Set() };
  }
  const cancelledIds = new Map();
  const endedNames = new Set();
  for (const name of names) {
    if (name.endsWith(".cancelled")) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch {}
      cancelledIds.set(name.slice(0, -".cancelled".length), meta);
    } else if (name.startsWith("session-") && name.endsWith(".ended")) {
      endedNames.add(name);
    }
  }
  const jobs = [];
  for (const name of names) {
    if (!isJobFileName(name)) continue;
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {
      // deleted mid-scan or unparseable -> skip
    }
  }
  return { jobs, cancelledIds, endedNames };
}

// The marker-overlaid view -- what every consumer (status/cancel/result/session cleanup)
// should see.
function readAllJobs(cwd) {
  const { jobs, cancelledIds, endedNames } = scanJobsDir(cwd);
  return jobs.map((job) => overlayJob(job, cancelledIds, endedNames));
}

// A record is reclaimable ONLY if it is terminal, or a running job whose owner pid is
// provably dead. A pid-less non-terminal job (queued, no pid published yet) is NEVER
// age-evicted: a worker could still be booting -- even paused for a long time by machine
// sleep, load, or a debugger -- and prune's re-check + unlink is a non-atomic
// check-then-act, so age-evicting such a record races the worker's `running` publish and
// (worse) can strand its cancel tombstone. Leaving an abandoned queued record until it
// turns terminal or its worker publishes+dies is the safe choice (a rare, bounded leak).
function isEvictable(job) {
  if (typeof job.id !== "string") return false;
  if (TERMINAL_STATUSES.has(job.status)) return true;
  if (Number.isInteger(job.pid) && job.pid > 0) return !pidAlive(job.pid);
  return false; // pid-less non-terminal -> a worker may still be booting; never age-evict
}

// Remove a job's record, its cancel marker, and both its recorded and conventional
// logs. Returns true if the record was removed (or was already gone).
export function deleteJobFiles(cwd, job) {
  let gone = false;
  try {
    fs.unlinkSync(resolveJobFile(cwd, job.id));
    gone = true;
  } catch (err) {
    gone = err.code === "ENOENT"; // already removed by another actor -> counts
  }
  if (!gone) return false; // couldn't remove (e.g. EACCES)
  try { fs.unlinkSync(resolveJobCancelFile(cwd, job.id)); } catch {}
  if (typeof job.logFile === "string") { try { fs.unlinkSync(job.logFile); } catch {} }
  try { fs.unlinkSync(resolveJobLogFile(cwd, job.id)); } catch {}
  return true;
}

// Keep the newest MAX_JOBS records; evict the oldest reclaimable ones so a live
// queued/running job is never made undiscoverable (which would break
// status/cancel/session cleanup). Eviction is decided on the RAW record, NOT the cancel
// overlay: a job that merely carries a cancel marker but whose raw record is still
// queued/running is NOT evictable while a worker could still be booting (a pid-less
// queued record only ages out after QUEUED_GRACE_MS; a booting worker boots in seconds
// and honors the marker long before then). Deleting the record+marker of such a job
// would let the booting worker re-create it unmarked -- the resurrection this avoids.
// Session-ended markers are intentionally NOT GC'd here: a safe generation-aware sweep
// is out of scope, and one tiny empty file per session is a negligible, race-free leak.
function pruneJobs(cwd) {
  const jobs = scanJobsDir(cwd).jobs; // RAW records
  const overflow = jobs.length - MAX_JOBS;
  if (overflow <= 0) return;
  const evictable = jobs
    .filter(isEvictable)
    .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
  let removed = 0;
  for (const job of evictable) {
    if (removed >= overflow) break;
    const current = readJobRecord(cwd, job.id); // RAW re-check
    if (current && !isEvictable(current)) continue; // became live/pending since scan -> spare
    if (deleteJobFiles(cwd, job)) removed += 1;
  }
}

// Merge `patch` into job <id>'s record and publish it atomically. This is the
// single write path for both a full record and an incremental patch; merging
// (rather than overwriting) means a field written by one call site is never lost
// by a later call that omits it (e.g. a `summary` added after the payload write).
//
// The record has a SINGLE writer -- the worker owns queued->running->terminal (the
// enqueue's pre-spawn queued write happens-before the worker exists). Cancellation
// does NOT write here; it uses the immutable `<id>.cancelled` marker instead. So there
// is no concurrent read-modify-write on this file and a plain additive merge is safe:
// no cross-process lost update is possible. Returns the published record.
function mergeJobRecord(cwd, jobId, patch) {
  ensureStateDir(cwd);
  const existing = readJobRecord(cwd, jobId) ?? {};
  const now = nowIso();
  const record = {
    ...existing,
    ...patch,
    id: jobId,
    createdAt: existing.createdAt ?? patch.createdAt ?? now,
    updatedAt: now
  };
  atomicWriteJson(resolveJobFile(cwd, jobId), record);
  pruneJobs(cwd);
  return record;
}

export function upsertJob(cwd, patch) {
  return mergeJobRecord(cwd, patch.id, patch);
}

export function writeJobFile(cwd, jobId, payload) {
  mergeJobRecord(cwd, jobId, payload);
  return resolveJobFile(cwd, jobId);
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function listJobs(cwd) {
  migrateLegacyState(cwd);
  return readAllJobs(cwd);
}

// The RAW records (no marker overlay), but still migrated from any legacy state.json
// jobs[] index so a fresh install and an upgraded one look the same. Session cleanup
// needs this: having just written the session-ended marker, the overlaid view would
// hide the very jobs it must kill.
export function readAllJobsRaw(cwd) {
  migrateLegacyState(cwd);
  return scanJobsDir(cwd).jobs;
}
