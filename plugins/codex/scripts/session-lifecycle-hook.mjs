#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { loadBrokerSession, reapBrokerSessions, waitForBrokerEndpoint } from "./lib/broker-lifecycle.mjs";
import { interruptAppServerTurn } from "./lib/codex.mjs";
import { loadState, readJobFile, resolveJobFile, resolveStateFile, saveState } from "./lib/state.mjs";
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

function readJobTurn(workspaceRoot, job) {
  let stored = {};
  try {
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (fs.existsSync(jobFile)) {
      stored = readJobFile(jobFile) ?? {};
    }
  } catch {
    // A corrupt or unreadable job file must not fail the whole hook; fall
    // back to the ids on the state entry.
  }
  return {
    threadId: stored.threadId ?? job.threadId ?? null,
    turnId: stored.turnId ?? job.turnId ?? null
  };
}

async function cleanupSessionJobs(cwd, sessionId) {
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

  const runningJobs = removedJobs.filter((job) => job.status === "queued" || job.status === "running");

  // A running job's Codex turn executes inside the shared app server, which
  // deliberately outlives this session. Interrupt each owned turn (as
  // handleCancel does), so killing the runner cannot leave a clientless turn
  // running in the broker until it completes or the broker idles out. The
  // interrupt is skipped when no live broker exists: the turn died with its
  // app server. Each runner is terminated immediately after its own
  // interrupt, not in a later pass, so a runner that exits in response to
  // the interrupt cannot have its PID reused (and the reused PID killed)
  // while other jobs' interrupts are still awaited.
  let brokerAlive = false;
  if (runningJobs.length > 0) {
    const brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
    brokerAlive = brokerEndpoint
      ? await waitForBrokerEndpoint(brokerEndpoint, 150).catch(() => false)
      : false;
  }

  for (const job of runningJobs) {
    if (brokerAlive) {
      const { threadId, turnId } = readJobTurn(workspaceRoot, job);
      if (threadId && turnId) {
        try {
          await interruptAppServerTurn(cwd, { threadId, turnId });
        } catch {
          // Ignore interrupt failures during session shutdown.
        }
      }
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  // Re-load before saving: the awaited interrupts above can take a while, and
  // saving the stale snapshot from the top of this function would clobber any
  // state written by a concurrent session in the meantime.
  const currentState = loadState(workspaceRoot);
  saveState(workspaceRoot, {
    ...currentState,
    jobs: currentState.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

async function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  // GC broker session dirs left behind by brokers that have already exited
  // (they self-shut-down when idle). Live brokers are never touched.
  await reapBrokerSessions();
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  // Do not shut down or kill this cwd's broker, and do not clear its state
  // record: both are shared with any concurrent session on the same cwd. The
  // broker exits itself once idle and removes its own record then
  // (app-server-broker.mjs), so a session ending leaves it entirely alone.
  // GC the directories of brokers that have already exited. A live broker,
  // including one a concurrent session is still using, is never touched.
  await reapBrokerSessions();
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    await handleSessionStart(input);
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
