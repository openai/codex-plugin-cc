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
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const RETRY_DELAY_MS = 10;
  const CHUNK_SIZE = 4096;
  // Time-based deadline for the first byte to arrive. Hooks are always
  // invoked with stdin piped, so data *will* come — but the writer may be
  // delayed (e.g. the parent process hasn't flushed yet). 5 s is generous
  // enough to cover slow writers; the hook's own kill-timeout is the
  // ultimate backstop if stdin never materialises.
  const PRE_DATA_TIMEOUT_MS = 5_000;
  const canAtomicsSleep =
    typeof SharedArrayBuffer === "function" &&
    typeof Atomics !== "undefined" &&
    typeof Atomics.wait === "function";
  const sleepBuffer = canAtomicsSleep ? new Int32Array(new SharedArrayBuffer(4)) : null;

  function sleepSync(ms) {
    if (sleepBuffer) {
      Atomics.wait(sleepBuffer, 0, 0, ms);
    } else {
      const start = Date.now();
      while (Date.now() - start < ms) { /* busy-wait fallback */ }
    }
  }

  // Use low-level readSync to accumulate chunks across EAGAIN retries.
  // readFileSync can consume a prefix of stdin before throwing EAGAIN,
  // so retrying it would lose bytes already read.
  const chunks = [];
  const buf = Buffer.alloc(CHUNK_SIZE);
  const startTime = Date.now();

  // Loop until EOF (bytesRead === 0). Before any data arrives, a
  // time-based deadline prevents mistaking delayed stdin for empty input.
  // Once data has started, keep retrying indefinitely to avoid feeding
  // truncated JSON to JSON.parse.
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buf, 0, CHUNK_SIZE);
    } catch (err) {
      if (err?.code === "EAGAIN") {
        if (chunks.length === 0 && Date.now() - startTime >= PRE_DATA_TIMEOUT_MS) {
          break;
        }
        sleepSync(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }

    if (bytesRead === 0) {
      break;
    }

    // Copy the chunk — buf is reused across iterations, so subarray
    // would be a view into the same memory that gets overwritten.
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
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

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
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

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
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
