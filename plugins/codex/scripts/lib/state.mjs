import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const STATE_LOCK_DIR_NAME = ".state.lock";
const MAX_JOBS = 50;
const STATE_LOCK_STALE_MS = 30000;
const STATE_LOCK_TIMEOUT_MS = STATE_LOCK_STALE_MS + 5000;
const STATE_LOCK_RETRY_MS = 20;
const STATE_LOCK_TIMEOUT_ENV = "CODEX_COMPANION_STATE_LOCK_TIMEOUT_MS";
let currentProcessStartedAt = undefined;

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

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function resolveStateLockDir(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_DIR_NAME);
}

function getProcessStartedAt(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const platform = options.platform ?? process.platform;
  const result =
    platform === "win32"
      ? runCommandImpl(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CreationDate.ToUniversalTime().ToString("o") }`
          ],
          {
            cwd: options.cwd,
            env: options.env
          }
        )
      : runCommandImpl("ps", ["-p", String(pid), "-o", "lstart="], {
          cwd: options.cwd,
          env: options.env
        });

  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function getCurrentProcessStartedAt() {
  if (currentProcessStartedAt === undefined) {
    currentProcessStartedAt = getProcessStartedAt(process.pid);
  }
  return currentProcessStartedAt;
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner"), "utf8"));
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function isLockOwnerAlive(owner) {
  if (!processExists(owner?.pid)) {
    return false;
  }
  if (!owner?.startedAt) {
    return true;
  }
  const startedAt = getProcessStartedAt(owner.pid);
  return startedAt === null || startedAt === owner.startedAt;
}

function ownsLock(lockDir, token) {
  const owner = readLockOwner(lockDir);
  return owner?.token === token && owner?.pid === process.pid;
}

function removeStaleLock(lockDir) {
  try {
    const stats = fs.statSync(lockDir);
    const owner = readLockOwner(lockDir);
    if (Date.now() - stats.mtimeMs > STATE_LOCK_STALE_MS && !isLockOwnerAlive(owner)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Another process may have released the lock between attempts.
  }
}

function acquireStateLock(cwd, options = {}) {
  const lockDir = resolveStateLockDir(cwd);
  const configuredTimeoutMs = Number(process.env[STATE_LOCK_TIMEOUT_ENV]);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : STATE_LOCK_TIMEOUT_MS);
  const start = Date.now();
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(
        path.join(lockDir, "owner"),
        `${JSON.stringify({ pid: process.pid, startedAt: getCurrentProcessStartedAt(), token })}\n`,
        "utf8"
      );
      return () => {
        if (ownsLock(lockDir, token)) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      removeStaleLock(lockDir);
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out waiting for state lock: ${lockDir}`);
      }
      sleepSync(STATE_LOCK_RETRY_MS);
    }
  }
}

function withStateLock(cwd, fn) {
  const release = acquireStateLock(cwd);
  try {
    return fn();
  } finally {
    release();
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

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
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
