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
import { listJobs, resolveStateFile, SESSION_GENERATION_ENV, setSessionLifecycle, updateState } from "./lib/state.mjs";
import { markTrackedJobRemoved, readEffectiveStoredJob } from "./lib/tracked-jobs.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// SessionEnd runs under a bounded hook timeout, so cleanup fences and stops this
// session's workers before it ever waits on the shared state lock, and gives the
// lock a deadline short enough to leave room for the rest of the teardown.
export const SESSION_END_STATE_LOCK_WAIT_MS = 1000;

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

function warnSessionCleanup(what, error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Codex Companion session cleanup ${what}: ${detail}\n`);
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  try {
    setSessionLifecycle(workspaceRoot, sessionId, true);
  } catch (error) {
    warnSessionCleanup("could not fence its session", error);
  }
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const fenced = new Set();
  const fenceSessionJobs = (jobs) => {
    const pids = [];
    for (const job of jobs.filter((candidate) => candidate.sessionId === sessionId && !fenced.has(candidate.id))) {
      fenced.add(job.id);
      // The stored job carries the live pid, so it is read before the fence makes
      // it unreadable, but an unreadable job must still be fenced.
      let effectiveJob = job;
      try {
        effectiveJob = { ...job, ...(readEffectiveStoredJob(workspaceRoot, job.id) ?? {}) };
      } catch (error) {
        warnSessionCleanup(`could not read job ${job.id}`, error);
      }
      try {
        markTrackedJobRemoved(workspaceRoot, job.id);
      } catch (error) {
        warnSessionCleanup(`could not fence job ${job.id}`, error);
      }
      if (Number.isSafeInteger(effectiveJob.pid) && effectiveJob.pid > 0) {
        pids.push(effectiveJob.pid);
      }
    }
    return pids;
  };

  const stopWorkers = (pids) => {
    for (const pid of pids) {
      try {
        terminateProcessTree(pid);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
  };

  try {
    stopWorkers(fenceSessionJobs(listJobs(workspaceRoot)));
  } catch (error) {
    warnSessionCleanup("could not read its job list", error);
  }

  let latePids = [];
  try {
    updateState(
      workspaceRoot,
      (state) => {
        latePids = fenceSessionJobs(state.jobs);
        state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
      },
      { waitMs: SESSION_END_STATE_LOCK_WAIT_MS }
    );
  } catch (error) {
    warnSessionCleanup("could not prune its state", error);
  }
  stopWorkers(latePids);
}

function handleSessionStart(input) {
  if (input.session_id) {
    const generation = setSessionLifecycle(input.cwd || process.cwd(), input.session_id, false);
    appendEnvVar(SESSION_GENERATION_ENV, generation);
  }
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
