#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  deleteJobFiles,
  markJobCancelled,
  markSessionEnded,
  readAllJobsRaw,
  readJobPid
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

// A pid that is still RUNNABLE (can execute code), as opposed to a zombie/defunct that
// `kill(pid, 0)` still reports as existing but which can never resurrect a record. Used
// only to decide whether to DELETE a job's record. It must FAIL SAFE: any uncertainty
// returns true (keep the record+tombstone), because wrongly classifying a live worker as
// non-runnable would delete a tombstone the worker could still overwrite. Only a
// conclusive `ps` result reporting a zombie state returns false.
function pidRunnable(pid) {
  if (!pidAlive(pid)) return false; // ESRCH => definitely gone
  const out = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  // Treat launch failure / non-zero exit / no output / read error as UNCERTAIN -> runnable.
  if (out.error || out.status !== 0) return true;
  const state = (out.stdout ?? "").trim();
  if (state === "") return true; // ambiguous (some ps print nothing transiently) -> keep
  return state[0].toUpperCase() !== "Z"; // conclusive Z/Z+ zombie -> not runnable
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

export function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let sessionMarkerFailed = false;
  const jobMarkerFailed = new Set();

  // 1. Publish the session-ended marker FIRST -- before ANY existence check or scan.
  // A `!existsSync(state) return` optimization here would be a correctness hole: when
  // SessionEnd races the very FIRST background launch in a workspace, both paths can be
  // absent at that check, so cleanup would return without writing the marker and the
  // launcher's worker would then run after the session ended. Writing the marker first
  // (it ensures the state dir) closes that race and makes the scan below race-free: if a
  // worker slips past its own marker checks (reads them before this marker exists), it
  // must have published its pid before this marker -- hence before the scan -- so the
  // scan sees its record and kills it. Either the worker honors the marker, or we find
  // and kill it; it also refuses any later enqueue for this session. Load-bearing: if it
  // cannot be written (ENOSPC/EACCES), surface the failure loudly rather than silently
  // proceeding as if the session were cleanly closed; the per-job kill below still runs.
  try {
    markSessionEnded(workspaceRoot, sessionId);
  } catch (err) {
    sessionMarkerFailed = true;
    process.stderr.write(`codex: failed to publish session-ended marker for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // 2. Scan the RAW records (not the overlaid view -- the marker we just wrote would
  // otherwise hide this session's active jobs from us). A scan failure here (EACCES/EIO;
  // an absent dir returns [] rather than throwing) is load-bearing: we may be leaving a
  // live worker unscanned/unkilled, so fail LOUD rather than silently returning success.
  const isActive = (job) => job.status === "queued" || job.status === "running";
  let jobs;
  try {
    jobs = readAllJobsRaw(workspaceRoot).filter((job) => typeof job.id === "string" && job.sessionId === sessionId);
  } catch (err) {
    process.exitCode = 1;
    process.stderr.write(`codex: session cleanup for ${sessionId} could not scan jobs: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  const active = jobs.filter(isActive);

  // 3. Publish a per-job cancel marker for each active job BEFORE reading its pid, so a
  // worker that publishes its pid concurrently sees the marker on its post-pid re-check
  // and self-aborts (the pid-less startup window is safe: no pid to kill, marker stands).
  for (const job of active) {
    try { markJobCancelled(workspaceRoot, job.id, "Session ended."); } catch { jobMarkerFailed.add(job.id); }
  }

  // 4. Only NOW read each active job's pid (raw, AFTER its marker exists) and terminate
  // it, escalating to SIGKILL. Reading the pid after the marker is what makes the
  // handshake hold: a worker that publishes its pid after this read still sees the marker
  // on its own re-check and self-aborts.
  const pidByJob = new Map(active.map((job) => [job.id, readJobPid(workspaceRoot, job.id)]));
  const pids = [...pidByJob.values()].filter((pid) => pid != null);
  for (const pid of pids) {
    try {
      terminateProcessTree(pid);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }
  waitForExit(pids, 2000);
  const survivors = pids.filter(pidAlive);
  for (const pid of survivors) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  if (survivors.length > 0) {
    waitForExit(survivors, 500);
  }

  // 5. Delete records, EXCEPT those we cannot prove are worker-free: an active job for
  // which we found NO pid (a worker may still be booting), or one whose pid is STILL
  // alive after SIGKILL (an unkillable/stuck worker). Those are left as record + marker
  // (overlay => cancelled; prune GCs once the raw record ages out or turns terminal);
  // the booting worker honors the marker and aborts. Everything else -- a job we killed
  // and confirmed gone, or an already-finished job -- is safe to remove; deleteJobFiles
  // removes the record, its cancel marker, and its logs together.
  const stillRunnable = new Set(pids.filter(pidRunnable)); // excludes zombies (dead, unreaped)
  const keepMarker = new Set(
    active
      .filter((job) => pidByJob.get(job.id) == null || stillRunnable.has(pidByJob.get(job.id)))
      .map((job) => job.id)
  );
  for (const job of jobs) {
    if (keepMarker.has(job.id)) continue;
    deleteJobFiles(workspaceRoot, job);
  }

  // 6. Fail loud if a LOAD-BEARING marker could not be written. Best-effort scanning and
  // killing above still ran, but without the session-ended marker (or the cancel marker of
  // a job we KEPT because a worker may still be booting) we cannot claim the session was
  // cleanly closed: a task racing enqueue, or that kept booting worker, could still run.
  // A non-zero exit surfaces that to the hook runner rather than reporting success.
  const keptWithFailedMarker = [...keepMarker].some((id) => jobMarkerFailed.has(id));
  if (sessionMarkerFailed || keptWithFailedMarker) {
    process.exitCode = 1;
    process.stderr.write(`codex: session cleanup for ${sessionId} could not durably publish a required marker\n`);
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

// Only run the hook when executed directly (node session-lifecycle-hook.mjs <event>);
// importing the module (e.g. from tests) must not read stdin or run a lifecycle event.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
