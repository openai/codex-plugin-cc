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

const MANAGED_ENV_VARS = [SESSION_ID_ENV, TRANSCRIPT_PATH_ENV, PLUGIN_DATA_ENV];

function isManagedExport(line) {
  return MANAGED_ENV_VARS.some((name) => line.startsWith(`export ${name}=`));
}

// Rewrite this plugin's exports instead of appending them. SessionStart fires on
// startup, on resume and on every compaction, so appending grew CLAUDE_ENV_FILE by
// three lines every time and nothing ever pruned it. Only the last assignment of a
// name takes effect, so every earlier copy did nothing but grow the file. Claude Code
// inlines the whole file into the single `bash -c <script>` argument, so a long-running
// session eventually pushed that argument past the operating system's limit on the
// length of one argument, and no shell could be started at all.
function writeManagedEnvVars(entries) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return;
  }

  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  // Keep every line another plugin wrote, verbatim; drop only our own.
  const lines = existing.split(/\r?\n/).filter((line) => line !== "" && !isManagedExport(line));
  for (const [name, value] of entries) {
    if (value != null && value !== "") {
      lines.push(`export ${name}=${shellEscape(value)}`);
    }
  }

  const next = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (next === existing) {
    return;
  }

  // Write and rename, so that a reader never sees a half-written file.
  const tmpFile = `${envFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, next, "utf8");
  fs.renameSync(tmpFile, envFile);
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
  writeManagedEnvVars([
    [SESSION_ID_ENV, input.session_id],
    [TRANSCRIPT_PATH_ENV, input.transcript_path],
    [PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]]
  ]);
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
