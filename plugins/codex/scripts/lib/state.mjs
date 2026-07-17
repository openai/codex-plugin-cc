import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_DIR_NAME = "state.lock";
const STATE_LOCK_OWNER_FILE_NAME = "owner";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 30000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

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

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, STATE_LOCK_OWNER_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
}

function staleLockDescription(lockDir) {
  try {
    const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (ageMs < STALE_LOCK_MS) return null;
    const owner = readLockOwner(lockDir);
    if (owner && processExists(owner.pid)) return null;
    return owner?.pid ? `owner PID ${owner.pid} is not running` : "owner metadata is missing or invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function tryPublishStateLock(lockDir, owner) {
  const candidateDir = `${lockDir}.candidate-${owner.token}`;
  fs.mkdirSync(candidateDir);
  fs.writeFileSync(
    path.join(candidateDir, STATE_LOCK_OWNER_FILE_NAME),
    `${JSON.stringify(owner)}\n`,
    "utf8"
  );
  try {
    fs.renameSync(candidateDir, lockDir);
    return true;
  } catch (error) {
    fs.rmSync(candidateDir, { recursive: true, force: true });
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
    throw error;
  }
}

function releaseStateLock(lockDir, ownerToken) {
  const owner = readLockOwner(lockDir);
  if (owner?.token !== ownerToken) {
    throw new Error(`Codex companion state lock ownership changed before release: ${lockDir}`);
  }
  const releaseDir = `${lockDir}.release-${ownerToken}`;
  fs.renameSync(lockDir, releaseDir);
  fs.rmSync(releaseDir, { recursive: true, force: true });
}

function withStateLock(cwd, operation) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), STATE_LOCK_DIR_NAME);
  const start = Date.now();
  const owner = { pid: process.pid, token: randomUUID(), createdAt: nowIso() };

  while (!tryPublishStateLock(lockDir, owner)) {
    const staleDescription = staleLockDescription(lockDir);
    if (staleDescription) {
      throw new Error(
        `Stale Codex companion state lock requires verified manual removal (${staleDescription}): ${lockDir}`
      );
    }
    if (Date.now() - start >= LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Codex companion state lock: ${lockDir}`);
    }
    Atomics.wait(sleepBuffer, 0, 0, 10);
  }

  try {
    return operation();
  } finally {
    releaseStateLock(lockDir, owner.token);
  }
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

function saveStateUnlocked(cwd, state) {
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

  const stateFile = resolveStateFile(cwd);
  const temporaryFile = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryFile, stateFile);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) continue;
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
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
