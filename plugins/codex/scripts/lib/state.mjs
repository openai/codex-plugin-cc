import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_DIR_NAME = ".state.lock";
const STATE_LOCK_OWNER_PREFIX = "owner-";
const STATE_LOCK_OWNER_SUFFIX = ".json";
const DEFAULT_STATE_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STATE_LOCK_POLL_MS = 10;
const INVALID_STATE_LOCK_STALE_MS = 30000;
const STATE_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const STATE_LOCK_CONTENTION_CODES = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]);
const heldStateLocks = new Map();

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

function isMissingPathError(error) {
  return error?.code === "ENOENT";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function waitForStateLock(ms) {
  if (ms > 0) {
    Atomics.wait(STATE_LOCK_WAIT_BUFFER, 0, 0, ms);
  }
}

function cleanupPathAfterError(targetPath, originalError, options = {}) {
  try {
    if (options.recursive) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
  } catch (cleanupError) {
    if (!isMissingPathError(cleanupError)) {
      throw new AggregateError(
        [originalError, cleanupError],
        `Operation failed and cleanup also failed for ${targetPath}.`
      );
    }
  }
  throw originalError;
}

function writeTextFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    cleanupPathAfterError(temporaryPath, error);
  }
}

function stateLockOwnerName(token) {
  return `${STATE_LOCK_OWNER_PREFIX}${token}${STATE_LOCK_OWNER_SUFFIX}`;
}

function resolveStateLockDir(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_DIR_NAME);
}

function createStateLockCandidate(lockDir, token) {
  const candidateDir = `${lockDir}.candidate-${token}`;
  const ownerName = stateLockOwnerName(token);
  try {
    fs.mkdirSync(candidateDir);
    fs.writeFileSync(
      path.join(candidateDir, ownerName),
      `${JSON.stringify({ pid: process.pid, token, createdAt: nowIso() }, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    cleanupPathAfterError(candidateDir, error, { recursive: true });
  }
  return { candidateDir, ownerName };
}

function lockDirectoryAgeMs(lockDir) {
  return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
}

function removeOwnedLockDirectory(lockDir, ownerName) {
  const ownerPath = path.join(lockDir, ownerName);
  try {
    fs.unlinkSync(ownerPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }

  try {
    fs.rmdirSync(lockDir);
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
      // On POSIX, another contender can atomically replace the briefly empty
      // directory with its populated candidate. Its distinct owner file proves
      // this caller must leave the successor lock intact.
      return false;
    }
    throw error;
  }
  return true;
}

function recoverAbandonedStateLock(lockDir, options = {}) {
  let entries;
  try {
    entries = fs.readdirSync(lockDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    throw error;
  }

  if (entries.length === 0) {
    try {
      fs.rmdirSync(lockDir);
      return true;
    } catch (error) {
      if (isMissingPathError(error) || error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  const ownerEntries = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith(STATE_LOCK_OWNER_PREFIX) &&
      entry.name.endsWith(STATE_LOCK_OWNER_SUFFIX)
  );
  if (ownerEntries.length !== 1 || entries.length !== 1) {
    return false;
  }

  const ownerEntry = ownerEntries[0];
  const ownerPath = path.join(lockDir, ownerEntry.name);
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    if (lockDirectoryAgeMs(lockDir) < (options.invalidLockStaleMs ?? INVALID_STATE_LOCK_STALE_MS)) {
      return false;
    }
    return removeOwnedLockDirectory(lockDir, ownerEntry.name);
  }

  const ownerNameMatchesToken = ownerEntry.name === stateLockOwnerName(owner?.token);
  if (ownerNameMatchesToken && (options.isProcessAlive ?? isProcessAlive)(Number(owner?.pid))) {
    return false;
  }
  return removeOwnedLockDirectory(lockDir, ownerEntry.name);
}

function releaseStateLock(lockDir, token) {
  const held = heldStateLocks.get(lockDir);
  if (!held || held.token !== token) {
    return;
  }

  held.depth -= 1;
  if (held.depth > 0) {
    return;
  }
  heldStateLocks.delete(lockDir);
  removeOwnedLockDirectory(lockDir, stateLockOwnerName(token));
}

export function acquireStateLock(cwd, options = {}) {
  ensureStateDir(cwd);
  const lockDir = resolveStateLockDir(cwd);
  const held = heldStateLocks.get(lockDir);
  if (held) {
    held.depth += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        releaseStateLock(lockDir, held.token);
      }
    };
  }

  const token = randomUUID();
  // Populate a private candidate before the atomic rename. A crash therefore
  // cannot publish a lock without the PID/token metadata needed for recovery.
  const { candidateDir } = createStateLockCandidate(lockDir, token);
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? DEFAULT_STATE_LOCK_TIMEOUT_MS));
  const pollMs = Math.max(1, Number(options.pollMs ?? DEFAULT_STATE_LOCK_POLL_MS));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.renameSync(candidateDir, lockDir);
      heldStateLocks.set(lockDir, { token, depth: 1 });
      let released = false;
      return () => {
        if (!released) {
          released = true;
          releaseStateLock(lockDir, token);
        }
      };
    } catch (error) {
      if (!STATE_LOCK_CONTENTION_CODES.has(error?.code)) {
        cleanupPathAfterError(candidateDir, error, { recursive: true });
      }
    }

    if (recoverAbandonedStateLock(lockDir, options)) {
      continue;
    }
    if (Date.now() >= deadline) {
      const timeoutError = new Error(`Timed out acquiring Codex companion state lock: ${lockDir}`);
      cleanupPathAfterError(candidateDir, timeoutError, { recursive: true });
    }
    waitForStateLock(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function withStateLock(cwd, callback, options = {}) {
  const release = acquireStateLock(cwd, options);
  try {
    return callback();
  } finally {
    release();
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  let rawState;
  try {
    rawState = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return defaultState();
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawState);
  } catch (error) {
    throw new Error(`Could not parse Codex companion state: ${stateFile}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Could not parse Codex companion state: ${stateFile}`);
  }

  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
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

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeTextFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
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
    if (state.jobs[existingIndex].status === "cancelled" && jobPatch.status !== "cancelled") {
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

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  if (fs.existsSync(jobFile)) {
    const existing = readJobFile(jobFile);
    if (existing.status === "cancelled" && payload.status !== "cancelled") {
      return jobFile;
    }
  }
  writeTextFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function writeJobFile(cwd, jobId, payload) {
  return withStateLock(cwd, () => writeJobFileUnlocked(cwd, jobId, payload));
}

function readJobStoresUnlocked(cwd, jobId) {
  const state = loadState(cwd);
  const stateIndex = state.jobs.findIndex((job) => job.id === jobId);
  const jobFile = resolveJobFile(cwd, jobId);
  return {
    state,
    stateIndex,
    stateJob: stateIndex === -1 ? null : state.jobs[stateIndex],
    storedJob: fs.existsSync(jobFile) ? readJobFile(jobFile) : null
  };
}

function jobStoresSignature(snapshot) {
  return JSON.stringify([snapshot.stateJob, snapshot.storedJob]);
}

export function updateJobStores(cwd, jobId, mutate, options = {}) {
  return withStateLock(cwd, () => {
    let snapshot = readJobStoresUnlocked(cwd, jobId);
    let proposal = mutate({ stateJob: snapshot.stateJob, storedJob: snapshot.storedJob });

    if (options.beforeCommit) {
      options.beforeCommit({ stateJob: snapshot.stateJob, storedJob: snapshot.storedJob });
      const latestSnapshot = readJobStoresUnlocked(cwd, jobId);
      if (jobStoresSignature(latestSnapshot) !== jobStoresSignature(snapshot)) {
        snapshot = latestSnapshot;
        proposal = mutate({ stateJob: snapshot.stateJob, storedJob: snapshot.storedJob });
      }
    }

    if (!proposal || (proposal.stateJob === undefined && proposal.storedJob === undefined)) {
      return {
        stateJob: snapshot.stateJob,
        storedJob: snapshot.storedJob,
        value: proposal?.value,
        updated: false
      };
    }

    const cancellationAlreadyWon =
      snapshot.stateJob?.status === "cancelled" || snapshot.storedJob?.status === "cancelled";
    const proposalPreservesCancellation =
      proposal.stateJob?.status === "cancelled" && proposal.storedJob?.status === "cancelled";
    if (cancellationAlreadyWon && !proposalPreservesCancellation) {
      return {
        stateJob: snapshot.stateJob,
        storedJob: snapshot.storedJob,
        value: proposal.value,
        updated: false
      };
    }

    if (proposal.storedJob !== undefined) {
      writeJobFileUnlocked(cwd, jobId, proposal.storedJob);
    }
    if (proposal.stateJob !== undefined) {
      if (snapshot.stateIndex === -1) {
        snapshot.state.jobs.unshift(proposal.stateJob);
      } else {
        snapshot.state.jobs[snapshot.stateIndex] = proposal.stateJob;
      }
      saveStateUnlocked(cwd, snapshot.state);
    }

    return {
      stateJob: proposal.stateJob ?? snapshot.stateJob,
      storedJob: proposal.storedJob ?? snapshot.storedJob,
      value: proposal.value,
      updated: true
    };
  });
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
