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
import {
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateFile
} from "./lib/state.mjs";
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Block (bounded) until every pid has exited, or capMs elapses. Workers install no
// SIGTERM handler so they normally die within a few ms; the cap prevents a hang.
function waitForExit(pids, capMs) {
  const deadline = Date.now() + capMs;
  let remaining = pids.slice();
  while (remaining.length > 0 && Date.now() < deadline) {
    remaining = remaining.filter(pidAlive);
    if (remaining.length > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot)) && !fs.existsSync(resolveJobsDir(workspaceRoot))) {
    return;
  }

  // Job state is one file per job with no shared lock, so cleanup needs no locked
  // read-modify-write. Terminate this session's live workers FIRST, wait briefly
  // for them to actually exit, THEN delete their records -- so a still-dying worker
  // cannot re-create a record we just removed.
  const isRunning = (job) => job.status === "queued" || job.status === "running";
  let jobs = [];
  try {
    jobs = listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId);
  } catch {
    return;
  }

  const pids = [];
  for (const job of jobs) {
    if (!isRunning(job)) continue;
    const pid = job.pid;
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    try {
      terminateProcessTree(pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }
  waitForExit(pids, 2000);
  // Escalate to SIGKILL for any worker that ignored SIGTERM, so it cannot survive
  // to re-create a record we are about to delete, then give it a moment to die.
  const survivors = pids.filter(pidAlive);
  for (const pid of survivors) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  if (survivors.length > 0) {
    waitForExit(survivors, 500);
  }

  for (const job of jobs) {
    if (typeof job.id !== "string") continue;
    try { fs.unlinkSync(resolveJobFile(workspaceRoot, job.id)); } catch {}
    // Remove the log at its recorded path (which need not be jobs/<id>.log) as
    // well as the conventional path, so no orphan log survives cleanup.
    if (typeof job.logFile === "string") {
      try { fs.unlinkSync(job.logFile); } catch {}
    }
    try { fs.unlinkSync(resolveJobLogFile(workspaceRoot, job.id)); } catch {}
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
