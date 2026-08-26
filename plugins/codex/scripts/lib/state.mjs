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
const QUEUED_GRACE_MS = 60000; // a pid-less queued record stuck longer than this is a crashed enqueuer
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
// Legacy migration: older installs kept a jobs[] index array in state.json, with
// some fields (startedAt, completedAt, summary, ...) living only in that index
// and others only in the jobs/<id>.json payload. Fold each index entry INTO its
// per-job file so the single record has both, then rewrite state.json config-only.
// The merge is additive: an existing payload wins on conflicting keys (it is the
// authoritative/newer record) and the index only fills in keys the payload lacks.
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
    const existing = readJobRecord(cwd, job.id);
    atomicWriteJson(resolveJobFile(cwd, job.id), { ...job, ...(existing ?? {}) });
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

// Read every job record. Robust to concurrent create/delete/rename: a name that
// vanished mid-scan (ENOENT) or a record captured mid-write (never happens with
// atomic rename, but parse-guarded anyway) is simply skipped.
function readAllJobs(cwd) {
  let names;
  try {
    names = fs.readdirSync(resolveJobsDir(cwd));
  } catch {
    return []; // jobs dir not created yet
  }
  const jobs = [];
  const dir = resolveJobsDir(cwd);
  for (const name of names) {
    if (!isJobFileName(name)) continue;
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {
      // deleted mid-scan or unparseable -> skip
    }
  }
  return jobs;
}

// A record is reclaimable only if it is terminal, or a non-terminal job whose
// owner is provably gone. A just-queued job (no pid yet) is PENDING, not dead, so
// it must not be evicted -- except as a liveness backstop if it has been stuck far
// longer than a normal queue->spawn transition (a crashed enqueuer).
function isEvictable(job) {
  if (typeof job.id !== "string") return false;
  if (TERMINAL_STATUSES.has(job.status)) return true;
  if (Number.isInteger(job.pid) && job.pid > 0) return !pidAlive(job.pid);
  return Date.now() - Date.parse(job.updatedAt ?? "") > QUEUED_GRACE_MS;
}

// Keep the newest MAX_JOBS records; evict the oldest reclaimable ones so a live
// queued/running job is never made undiscoverable (which would break
// status/cancel/session cleanup). Deletes the payload, its recorded log, and the
// conventional log. Idempotent under concurrency; re-checks each candidate right
// before deleting so a job that transitioned to live since the scan is spared.
function pruneJobs(cwd) {
  const jobs = readAllJobs(cwd);
  const overflow = jobs.length - MAX_JOBS;
  if (overflow <= 0) return;
  const evictable = jobs
    .filter(isEvictable)
    .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
  let removed = 0;
  for (const job of evictable) {
    if (removed >= overflow) break;
    const current = readJobRecord(cwd, job.id);
    if (current && !isEvictable(current)) continue; // became live/pending since scan
    let gone = false;
    try {
      fs.unlinkSync(resolveJobFile(cwd, job.id));
      gone = true;
    } catch (err) {
      gone = err.code === "ENOENT"; // already removed by another pruner -> counts
    }
    if (!gone) continue; // couldn't remove (e.g. EACCES) -> don't count against overflow
    if (typeof job.logFile === "string") { try { fs.unlinkSync(job.logFile); } catch {} }
    try { fs.unlinkSync(resolveJobLogFile(cwd, job.id)); } catch {}
    removed += 1;
  }
}

// Merge `patch` into job <id>'s record and publish it atomically. This is the
// single write path for both a full record and an incremental patch; merging
// (rather than overwriting) means a field written by one call site is never lost
// by a later call that omits it (e.g. a `summary` added after the payload write).
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
