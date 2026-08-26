#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, updateState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

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

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // Drop this session's jobs through the locked read-modify-write so a concurrent
  // upsertJob (task launch) can't be clobbered by a stale snapshot, and capture
  // which running jobs to terminate. Process teardown runs in `finally`, after the
  // lock is released, so a failed state write (e.g. the 15s lock-acquire timeout)
  // can never leak this session's processes, and never aborts the rest of session
  // shutdown (broker teardown) -- session cleanup is best-effort.
  const isRunning = (job) => job.status === "queued" || job.status === "running";
  const toTerminate = [];
  try {
    updateState(workspaceRoot, (state) => {
      for (const job of state.jobs) {
        if (job.sessionId === sessionId && isRunning(job)) {
          toTerminate.push(job.pid ?? Number.NaN);
        }
      }
      state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
    });
  } catch {
    // The locked update failed (e.g. lock-acquire timeout). Still identify this
    // session's processes so we can tear them down -- via a best-effort unlocked
    // read only. We deliberately do NOT write state here: an unlocked save is the
    // very clobber this lock prevents; the stale records are removed on a later
    // locked pass.
    if (toTerminate.length === 0) {
      try {
        for (const job of loadState(workspaceRoot).jobs) {
          if (job.sessionId === sessionId && isRunning(job)) {
            toTerminate.push(job.pid ?? Number.NaN);
          }
        }
      } catch {
        // Nothing more we can do; fall through to whatever we collected.
      }
    }
  } finally {
    for (const pid of toTerminate) {
      try {
        terminateProcessTree(pid);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
