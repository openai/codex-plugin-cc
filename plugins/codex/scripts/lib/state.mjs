import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_FILE_NAME = ".state.lock";
const STATE_LOCK_WAIT_MS = 5000;
const STATE_LOCK_RETRY_MS = 20;
const JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const SAFE_JOB_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateState(parsed) {
  if (!isObject(parsed) || parsed.version !== STATE_VERSION || !isObject(parsed.config) || typeof parsed.config.stopReviewGate !== "boolean" || !Array.isArray(parsed.jobs)) {
    throw new Error("invalid state schema");
  }
  for (const job of parsed.jobs) {
    if (!isObject(job) || typeof job.id !== "string" || !SAFE_JOB_ID.test(job.id) || !JOB_STATUSES.has(job.status)) {
      throw new Error("invalid job schema");
    }
  }
}

export function loadState(cwd) {
  const stateFile = path.resolve(resolveStateFile(cwd));
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    validateState(parsed);
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return defaultState();
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Codex Companion state at ${stateFile}: ${detail}`, { cause: error });
  }
}

function pauseForStateLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATE_LOCK_RETRY_MS);
}

function readStateLockOwner(lockFile) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw error;
    }
    throw new Error(`Codex Companion state lock at ${path.resolve(lockFile)} has an invalid owner.`, { cause: error });
  }
  if (!isObject(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !owner.token || typeof owner.createdAt !== "string") {
    throw new Error(`Codex Companion state lock at ${path.resolve(lockFile)} has an invalid owner.`);
  }
  return owner;
}

function tryCreateStateLock(filePath, payload) {
  const temporaryFile = `${filePath}.${process.pid}.${payload.token}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(payload)}\n`, "utf8");
    fs.linkSync(temporaryFile, filePath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    removeFileIfExists(temporaryFile);
  }
}

function releaseStateLock(lockFile, token) {
  try {
    if (readStateLockOwner(lockFile).token === token) {
      fs.unlinkSync(lockFile);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function reapDeadStateLock(lockFile, owner) {
  const reapFile = `${lockFile}.reap`;
  const token = randomUUID();
  if (!tryCreateStateLock(reapFile, { pid: process.pid, token, createdAt: nowIso() })) {
    return false;
  }
  try {
    const current = readStateLockOwner(lockFile);
    if (current.token === owner.token && current.pid === owner.pid && !isProcessAlive(current.pid)) {
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  } finally {
    releaseStateLock(reapFile, token);
  }
  return false;
}

function withStateLock(cwd, action, { waitMs = STATE_LOCK_WAIT_MS } = {}) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  while (true) {
    if (tryCreateStateLock(lockFile, { pid: process.pid, token, createdAt: nowIso() })) {
      try {
        return action();
      } finally {
        releaseStateLock(lockFile, token);
      }
    }
    try {
      const owner = readStateLockOwner(lockFile);
      if (!isProcessAlive(owner.pid)) {
        if (reapDeadStateLock(lockFile, owner)) {
          continue;
        }
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Codex Companion state lock at ${path.resolve(lockFile)}.`);
    }
    pauseForStateLock();
  }
}

function writeAtomicJson(filePath, value) {
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(temporaryFile, content, "utf8");
    fs.renameSync(temporaryFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const active = sorted.filter((job) => job.status === "queued" || job.status === "running");
  const terminal = sorted.filter((job) => job.status !== "queued" && job.status !== "running");
  return [...active, ...terminal.slice(0, Math.max(0, MAX_JOBS - active.length))]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function resolveJobSidecarFile(cwd, jobId, suffix) {
  return path.join(resolveJobsDir(cwd), `${jobId}${suffix}`);
}

function markJobRemoved(cwd, jobId) {
  try {
    fs.closeSync(fs.openSync(resolveJobSidecarFile(cwd, jobId, ".removed"), "wx"));
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

function removeJobSidecars(cwd, jobId) {
  for (const suffix of [".started.json", ".admission.json", ".terminal.json"]) {
    removeFileIfExists(resolveJobSidecarFile(cwd, jobId, suffix));
  }
}

function saveStateLocked(cwd, state) {
  const candidate = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: state.jobs ?? []
  };
  validateState(candidate);
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const requestedJobs = candidate.jobs;
  const nextJobs = pruneJobs(requestedJobs.filter((job) => !fs.existsSync(resolveJobSidecarFile(cwd, job.id, ".removed"))));
  const nextState = {
    version: STATE_VERSION,
    config: candidate.config,
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  const knownJobs = new Map(previousJobs.map((job) => [job.id, job]));
  for (const job of requestedJobs) {
    knownJobs.set(job.id, { ...knownJobs.get(job.id), ...job });
  }
  for (const job of knownJobs.values()) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    markJobRemoved(cwd, job.id);
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(resolveJobLogFile(cwd, job.id));
    removeJobSidecars(cwd, job.id);
  }

  writeAtomicJson(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state));
}

export function updateState(cwd, mutate, options) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  }, options);
}

export function isJobRemovedLocked(cwd, jobId) {
  return withStateLock(cwd, () => fs.existsSync(resolveJobSidecarFile(cwd, jobId, ".removed")));
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
  writeAtomicJson(jobFile, payload);
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
