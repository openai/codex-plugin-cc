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

function workspaceStateDirName(cwd) {
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
  return `${slug}-${hash}`;
}

// CLAUDE_PLUGIN_DATA is only present when the current invocation runs as a
// plugin hook; a directly-invoked CLI call (or a hook whose env didn't
// propagate it) resolves to the tmpdir fallback instead. Since the state
// root is derived from ambient environment rather than anything persisted,
// two invocations for the *same* workspace can land on different roots --
// the primary root is still the write target for new/updated state, but
// reads check every candidate so state written under one root is never
// invisible to a later invocation that resolves to the other.
function stateRootCandidates() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir
    ? [path.join(pluginDataDir, "state"), FALLBACK_STATE_ROOT_DIR]
    : [FALLBACK_STATE_ROOT_DIR];
}

export function resolveStateDir(cwd) {
  const [primaryRoot] = stateRootCandidates();
  return path.join(primaryRoot, workspaceStateDirName(cwd));
}

/**
 * All directories that could hold this workspace's state, primary root
 * first. Use for reads that must not miss state written under a different
 * root than the current invocation resolves to.
 */
export function resolveStateDirCandidates(cwd) {
  const dirName = workspaceStateDirName(cwd);
  return stateRootCandidates().map((root) => path.join(root, dirName));
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

function readStateFileIfValid(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

// Unlike the broker session (at most one meaningful record per workspace,
// so "first candidate found" is a correct selection), jobs are a growing
// collection that can genuinely differ across roots -- a job started while
// CLAUDE_PLUGIN_DATA was set and another started while it was unset are
// both real and non-conflicting. Returning only the first candidate's job
// list would silently hide whichever root wasn't picked, leaving the exact
// cross-root invisibility this fix targets for status/result/cancel
// whenever *both* roots happen to have a state.json (a reachable legacy
// state after invocations alternated). So every candidate's jobs are
// merged instead, keeping the more recently updated copy if the same job
// id somehow appears in more than one.
export function loadState(cwd) {
  const parsedCandidates = resolveStateDirCandidates(cwd)
    .map((stateDir) => readStateFileIfValid(path.join(stateDir, STATE_FILE_NAME)))
    .filter((parsed) => parsed != null);

  if (parsedCandidates.length === 0) {
    return defaultState();
  }

  const jobsById = new Map();
  for (const parsed of parsedCandidates) {
    for (const job of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
      const existing = jobsById.get(job.id);
      if (!existing || String(job.updatedAt ?? "") > String(existing.updatedAt ?? "")) {
        jobsById.set(job.id, job);
      }
    }
  }

  // Like jobs, config can genuinely differ across roots depending on which
  // invocation wrote it -- e.g. `/codex:setup --enable-review-gate` running
  // without CLAUDE_PLUGIN_DATA writes stopReviewGate to the fallback root,
  // which a later invocation with CLAUDE_PLUGIN_DATA set would never see if
  // only the primary candidate's config were read. A boolean flag here is
  // an opt-in toward stricter/safer behavior, so any candidate setting it
  // true wins over a stale false elsewhere -- reconciling by "primary wins"
  // could silently downgrade an explicitly-enabled gate.
  const mergedConfig = { ...defaultState().config };
  for (const parsed of parsedCandidates) {
    for (const [key, value] of Object.entries(parsed.config ?? {})) {
      if (typeof value === "boolean") {
        mergedConfig[key] = mergedConfig[key] === true || value === true;
      } else if (mergedConfig[key] === undefined) {
        mergedConfig[key] = value;
      }
    }
  }

  const [primary] = parsedCandidates;
  return {
    ...defaultState(),
    ...primary,
    config: mergedConfig,
    jobs: [...jobsById.values()]
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
    for (const jobFile of resolveJobFileCandidates(cwd, job.id)) {
      removeJobFile(jobFile);
    }
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");

  // previousJobs is the merged view across every candidate root (see
  // loadState()), so a job dropped from state.jobs here may have
  // originated entirely in a root other than the one just written above.
  // Without this, that root's own state.json still holds its own
  // untouched copy, and the very next loadState() merges it right back in
  // -- deletions could never actually stick for a job that lives only in a
  // non-primary root. Prune every other candidate root's own file down to
  // the same retained set; new/updated jobs still only ever get written to
  // the primary root, above -- this only ever removes, never adds or
  // rewrites in place.
  const [, ...otherStateDirs] = resolveStateDirCandidates(cwd);
  for (const otherStateDir of otherStateDirs) {
    const otherStateFile = path.join(otherStateDir, STATE_FILE_NAME);
    const otherParsed = readStateFileIfValid(otherStateFile);
    const otherJobs = Array.isArray(otherParsed?.jobs) ? otherParsed.jobs : [];
    const prunedOtherJobs = otherJobs.filter((job) => retainedIds.has(job.id));
    if (prunedOtherJobs.length === otherJobs.length) {
      continue;
    }
    fs.writeFileSync(
      otherStateFile,
      `${JSON.stringify({ ...otherParsed, jobs: prunedOtherJobs }, null, 2)}\n`,
      "utf8"
    );
  }

  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
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

/**
 * Every path a job's detail file could be at, primary root first. A job
 * listed via loadState()/listJobs() (which already searches every
 * candidate root) may have had its detail file written under a different
 * root than resolveJobFile()'s current primary; read lookups should not
 * miss it just because it isn't in the root a fresh call resolves to.
 */
export function resolveJobFileCandidates(cwd, jobId) {
  return resolveStateDirCandidates(cwd).map((stateDir) => path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`));
}
