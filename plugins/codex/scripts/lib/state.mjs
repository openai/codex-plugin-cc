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
const STATE_LOCK_TIMEOUT_MS = 5000;
const STATE_LOCK_TIMEOUT_CODE = "ESTATELOCKTIMEOUT";

let stateWriteSequence = 0;

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

function waitSynchronously(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isLockOwnerAlive(token) {
  const pid = Number.parseInt(token?.split("-", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function reclaimBarrierPrefix(lockDir) {
  return `${path.basename(lockDir)}.reclaim-`;
}

function recoverStateReclaimBarriers(lockDir) {
  const parent = path.dirname(lockDir);
  const prefix = reclaimBarrierPrefix(lockDir);
  let blocked = false;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const barrier = path.join(parent, entry.name);
    const reclaimerPid = Number.parseInt(entry.name.slice(prefix.length).split("-", 1)[0], 10);
    if (isLockOwnerAlive(`${reclaimerPid}-reclaimer`)) {
      blocked = true;
      continue;
    }
    const movedLock = path.join(barrier, "lock");
    if (fs.existsSync(movedLock)) {
      let ownerToken = null;
      try {
        ownerToken = fs.readFileSync(path.join(movedLock, "owner"), "utf8");
      } catch {
        // An unreadable moved lock is preserved conservatively.
      }
      if (!ownerToken || isLockOwnerAlive(ownerToken)) {
        if (!fs.existsSync(lockDir)) {
          try {
            fs.renameSync(movedLock, lockDir);
            fs.rmSync(barrier, { recursive: true, force: true });
            continue;
          } catch {
            // Another process restored or published the canonical lock.
          }
        }
        blocked = true;
        continue;
      }
    }
    fs.rmSync(barrier, { recursive: true, force: true });
  }
  return blocked;
}

function releaseOwnedStateLock(lockDir, token) {
  const tokenFile = path.join(lockDir, "owner");
  try {
    if (fs.readFileSync(tokenFile, "utf8") === token) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return;
    }
  } catch {
    // A reclaimer may have moved the lock behind a visible barrier.
  }
  const parent = path.dirname(lockDir);
  const prefix = reclaimBarrierPrefix(lockDir);
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const barrier = path.join(parent, entry.name);
    const movedLock = path.join(barrier, "lock");
    try {
      if (fs.readFileSync(path.join(movedLock, "owner"), "utf8") === token) {
        fs.rmSync(movedLock, { recursive: true, force: true });
        fs.rmSync(barrier, { recursive: true, force: true });
        break;
      }
    } catch {
      // This barrier belongs to another lock generation.
    }
  }
  // Orphan recovery may have restored this generation between the moved-token
  // check and removal. Recheck the canonical path before returning so a
  // completed owner cannot be stranded as a live-looking lock.
  try {
    if (fs.readFileSync(tokenFile, "utf8") === token) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // This owner no longer has a published lock generation.
  }
}

function withStateFileLock(cwd, fn, { timeoutMs = STATE_LOCK_TIMEOUT_MS } = {}) {
  const stateFile = resolveStateFile(cwd);
  const lockDir = `${stateFile}.lock`;
  const tokenFile = path.join(lockDir, "owner");
  const token = `${process.pid}-${stateWriteSequence += 1}`;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  while (true) {
    if (recoverStateReclaimBarriers(lockDir)) {
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Timed out waiting for state lock: ${stateFile}`), {
          code: STATE_LOCK_TIMEOUT_CODE
        });
      }
      waitSynchronously(25);
      continue;
    }
    let candidate = null;
    try {
      if (fs.existsSync(lockDir)) {
        throw Object.assign(new Error(`State lock exists: ${stateFile}`), { code: "EEXIST" });
      }
      candidate = fs.mkdtempSync(`${lockDir}.candidate-${process.pid}-`);
      fs.writeFileSync(path.join(candidate, "owner"), token, { encoding: "utf8", flag: "wx" });
      // Publishing a non-empty, pre-stamped directory is atomic. A live holder
      // can therefore never expose an unowned canonical lock path.
      fs.renameSync(candidate, lockDir);
      candidate = null;
      if (recoverStateReclaimBarriers(lockDir)) {
        if (fs.readFileSync(tokenFile, "utf8") === token) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
        waitSynchronously(25);
        continue;
      }
      break;
    } catch (error) {
      if (candidate) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
      if (!fs.existsSync(lockDir)) {
        if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
          if (Date.now() >= deadline) {
            throw Object.assign(new Error(`Timed out waiting for state lock: ${stateFile}`), {
              code: STATE_LOCK_TIMEOUT_CODE
            });
          }
          waitSynchronously(25);
          continue;
        }
        throw error;
      }
      let stat = null;
      try {
        stat = fs.lstatSync(lockDir);
      } catch {
        // Retry below; the lock may have disappeared after mkdirSync failed.
      }
      if (stat && !stat.isDirectory()) {
        try {
          fs.unlinkSync(lockDir);
          continue;
        } catch {
          stat = null;
        }
      }
      if (stat) {
        let ownerToken = null;
        try {
          ownerToken = fs.readFileSync(tokenFile, "utf8");
        } catch {
          // Every canonical lock is published with a token. Treat an unreadable
          // token conservatively as live instead of risking overlapping writers.
        }
        if (ownerToken && !isLockOwnerAlive(ownerToken)) {
          const barrier = fs.mkdtempSync(`${lockDir}.reclaim-${process.pid}-`);
          const claimed = path.join(barrier, "lock");
          let reclaimed = false;
          try {
            const currentToken = fs.readFileSync(tokenFile, "utf8");
            if (currentToken !== ownerToken) {
              continue;
            }
            fs.renameSync(lockDir, claimed);
            if (fs.readFileSync(path.join(claimed, "owner"), "utf8") === ownerToken &&
                !isLockOwnerAlive(ownerToken)) {
              fs.rmSync(claimed, { recursive: true, force: true });
              reclaimed = true;
            } else {
              while (fs.existsSync(lockDir) && Date.now() < deadline) {
                waitSynchronously(25);
              }
              if (!fs.existsSync(lockDir)) {
                fs.renameSync(claimed, lockDir);
              }
            }
          } catch {
            // The barrier stays visible until the moved lock is restored or a
            // later process recovers it after this reclaimer exits.
          } finally {
            if (!fs.existsSync(claimed)) {
              fs.rmSync(barrier, { recursive: true, force: true });
            }
          }
          if (reclaimed) {
            continue;
          }
        }
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Timed out waiting for state lock: ${stateFile}`), {
          code: STATE_LOCK_TIMEOUT_CODE
        });
      }
      waitSynchronously(25);
    }
  }

  try {
    return fn();
  } finally {
    releaseOwnedStateLock(lockDir, token);
  }
}

export function resolveStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
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
  const stateRoot = resolveStateRoot();
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

  const stateFile = resolveStateFile(cwd);
  const temporaryStateFile = `${stateFile}.tmp-${process.pid}-${stateWriteSequence += 1}`;
  try {
    fs.writeFileSync(temporaryStateFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryStateFile, stateFile);
  } finally {
    fs.rmSync(temporaryStateFile, { force: true });
  }
  return nextState;
}

export function saveState(cwd, state) {
  return withStateFileLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateFileLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function removeSessionJobs(cwd, sessionId, options = {}) {
  const { beforeRemove = () => {}, ...lockOptions } = options;
  return withStateFileLock(cwd, () => {
    const state = loadState(cwd);
    const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    if (removedJobs.length === 0) {
      return [];
    }
    beforeRemove(removedJobs);
    saveStateUnlocked(cwd, {
      ...state,
      jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
    });
    return removedJobs;
  }, lockOptions);
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
