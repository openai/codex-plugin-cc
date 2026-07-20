#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  BROKER_CLEANUP_INCOMPLETE_CODE,
  LOG_FILE_ENV,
  PID_FILE_ENV,
  markBrokerSessionEnded,
  teardownBrokerForCwd,
  teardownBrokersForSession
} from "./lib/broker-lifecycle.mjs";
import { removeSessionJobs, resolveStateFile, resolveStateRoot } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// hooks.json gives the SessionEnd hook a 5s budget. Share a shorter deadline
// across cross-workspace job discovery/cleanup and session-keyed broker
// teardown so the cwd fallback retains time before the hook is killed.
const SESSION_END_CLEANUP_BUDGET_MS = 3000;
const SESSION_END_LOCK_TIMEOUT_MS = 750;
const MAX_SESSION_JOB_STATE_BYTES = 1024 * 1024;

function cleanupIncompleteError(reason) {
  return Object.assign(new Error(`Session cleanup stopped before scanning all job state: ${reason}.`), {
    code: BROKER_CLEANUP_INCOMPLETE_CODE,
    reason
  });
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupWorkspaceSessionJobs(workspaceRoot, sessionId, deadline) {
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return { brokerTeardownSafe: true, error: null };
  }
  if (!readSessionJobsFromStateFile(stateFile).complete) {
    return { brokerTeardownSafe: false, error: null };
  }

  let reachedTerminationPhase = false;
  try {
    removeSessionJobs(
      workspaceRoot,
      sessionId,
      {
        timeoutMs: Math.max(0, deadline - Date.now()),
        beforeRemove(jobs) {
          reachedTerminationPhase = true;
          for (const job of jobs) {
            const stillRunning = job.status === "queued" || job.status === "running";
            if (!stillRunning) {
              continue;
            }
            try {
              terminateProcessTree(job.pid ?? Number.NaN);
            } catch {
              // Ignore teardown failures during session shutdown.
            }
          }
        }
      }
    );
    return { brokerTeardownSafe: true, error: null };
  } catch (error) {
    return { brokerTeardownSafe: reachedTerminationPhase, error };
  }
}

function readSessionJobsFromStateFile(stateFile) {
  let descriptor = null;
  try {
    const before = fs.lstatSync(stateFile);
    if (!before.isFile() || before.size > MAX_SESSION_JOB_STATE_BYTES) {
      return { jobs: [], complete: false };
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlock = fs.constants.O_NONBLOCK ?? 0;
    descriptor = fs.openSync(stateFile, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_SESSION_JOB_STATE_BYTES ||
        opened.dev !== before.dev || opened.ino !== before.ino) {
      return { jobs: [], complete: false };
    }
    const state = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    return { jobs: Array.isArray(state.jobs) ? state.jobs : [], complete: true };
  } catch (error) {
    return { jobs: [], complete: error?.code === "ENOENT" };
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

function findSessionJobWorkspaces(cwd, sessionId, deadline) {
  const workspaceRoots = new Set([resolveWorkspaceRoot(cwd)]);
  const stateRoot = resolveStateRoot();
  if (!fs.existsSync(stateRoot)) {
    return { workspaceRoots, complete: true };
  }

  const stateDirectory = fs.opendirSync(stateRoot);
  let complete = true;
  let exhausted = false;
  try {
    while (Date.now() < deadline) {
      const entry = stateDirectory.readSync();
      if (!entry) {
        exhausted = true;
        break;
      }
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      const stateFile = path.join(stateRoot, entry.name, "state.json");
      const state = readSessionJobsFromStateFile(stateFile);
      complete &&= state.complete;
      for (const job of state.jobs) {
        if (job.sessionId === sessionId && typeof job.workspaceRoot === "string" && job.workspaceRoot) {
          workspaceRoots.add(job.workspaceRoot);
        }
      }
    }
    if (!exhausted) {
      complete = false;
    }
  } finally {
    stateDirectory.closeSync();
  }
  return { workspaceRoots, complete };
}

function cleanupSessionJobs(cwd, sessionId, deadline) {
  if (!cwd || !sessionId) {
    return { discoveryComplete: true, cwdBrokerTeardownSafe: true, error: null };
  }

  let cleanupError = null;
  let jobCleanupComplete = true;
  let cwdBrokerTeardownSafe = true;
  let workspaceIndex = 0;
  const discovery = findSessionJobWorkspaces(cwd, sessionId, deadline);
  if (!discovery.complete) {
    cleanupError = cleanupIncompleteError("job-discovery-incomplete");
  }
  for (const workspaceRoot of discovery.workspaceRoots) {
    // Always clean the hook cwd first. Bound additional workspace cleanup by
    // the shared SessionEnd deadline so broker cleanup and the cwd fallback
    // retain time inside the hook's 5-second limit.
    if (workspaceIndex > 0 && Date.now() >= deadline) {
      jobCleanupComplete = false;
      cleanupError ??= cleanupIncompleteError("job-cleanup-deadline");
      break;
    }
    workspaceIndex += 1;
    try {
      const cleanup = cleanupWorkspaceSessionJobs(workspaceRoot, sessionId, deadline);
      cleanupError ??= cleanup.error;
      if (!cleanup.brokerTeardownSafe) {
        jobCleanupComplete = false;
        cleanupError ??= cleanupIncompleteError("job-state-incomplete");
        if (workspaceIndex === 1) {
          cwdBrokerTeardownSafe = false;
        }
      }
    } catch (error) {
      cleanupError ??= error;
      jobCleanupComplete = false;
      if (workspaceIndex === 1) {
        cwdBrokerTeardownSafe = false;
      }
    }
  }
  return {
    discoveryComplete: discovery.complete && jobCleanupComplete,
    cwdBrokerTeardownSafe,
    error: cleanupError
  };
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

export async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const cleanupDeadline = Date.now() + SESSION_END_CLEANUP_BUDGET_MS;
  let cleanupError = null;
  try {
    markBrokerSessionEnded(sessionId);
  } catch (error) {
    cleanupError = error;
  }
  let jobDiscoveryComplete = true;
  let cwdBrokerTeardownSafe = true;
  try {
    const cleanup = cleanupSessionJobs(cwd, sessionId, cleanupDeadline);
    cleanupError ??= cleanup.error;
    jobDiscoveryComplete = cleanup.discoveryComplete;
    cwdBrokerTeardownSafe = cleanup.cwdBrokerTeardownSafe;
  } catch (error) {
    cleanupError ??= error;
    jobDiscoveryComplete = false;
    cwdBrokerTeardownSafe = false;
  }

  if (sessionId && jobDiscoveryComplete) {
    try {
      await teardownBrokersForSession(sessionId, {
        killProcess: terminateProcessTree,
        lockTimeoutMs: SESSION_END_LOCK_TIMEOUT_MS,
        budgetMs: Math.max(0, cleanupDeadline - Date.now()),
        excludeCwd: cwd
      });
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (cwdBrokerTeardownSafe) {
    try {
      await teardownBrokerForCwd(cwd, sessionId, {
        fallbackSession: process.env[BROKER_ENDPOINT_ENV]
          ? {
              endpoint: process.env[BROKER_ENDPOINT_ENV],
              pidFile: process.env[PID_FILE_ENV] ?? null,
              logFile: process.env[LOG_FILE_ENV] ?? null
            }
          : null,
        killProcess: terminateProcessTree,
        lockTimeoutMs: SESSION_END_LOCK_TIMEOUT_MS
      });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

function isExecutedDirectly() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    // argv[1] may not resolve to a real path (deleted file, loader indirection);
    // importing must never crash at module load.
    return false;
  }
}

// Only run main() when executed directly (not when imported by tests).
const isMain = isExecutedDirectly();
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
