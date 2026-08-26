import fs from "node:fs";
import process from "node:process";

import { isJobCancelled, isSessionEnded, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    // upsertJob merges the patch into the single per-job record atomically, so the
    // former re-read + full-snapshot writeJobFile is not only redundant now but
    // unsafe: passing a stale snapshot could resurrect a concurrently cancelled or
    // completed job back to "running".
    upsertJob(workspaceRoot, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  // Guarded read: the per-job file can be pruned or session-cleaned between an
  // existence check and the read, so treat any read/parse failure as "absent".
  try {
    return readJobFile(resolveJobFile(workspaceRoot, jobId));
  } catch {
    return null;
  }
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  // Cancel handshake (the linearizable half). We PUBLISH our pid first, THEN re-check
  // the cancel marker. Cancellation does the mirror: create the marker first, THEN read
  // the pid. Because each side writes its flag before reading the other's, at least one
  // side always observes the other -- so either the canceller finds our pid and kills
  // us, or we find the marker here and abort. No orphan worker, no lost cancellation.
  upsertJob(job.workspaceRoot, runningRecord);
  if (isJobCancelled(job.workspaceRoot, job.id) || isSessionEnded(job.workspaceRoot, job.sessionId)) {
    appendLogLine(options.logFile ?? job.logFile ?? null, "Job cancelled before start; not starting.");
    upsertJob(job.workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt: nowIso() });
    return { aborted: true, status: "cancelled" };
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    upsertJob(job.workspaceRoot, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    // Guard the final log append: the terminal record is already published, so a logging
    // failure must NOT fall into the catch below and write a second (failed) lifecycle
    // record over it. The terminal upsertJob above is the worker's last record write.
    try {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    } catch {
      // logging is best-effort; never revert a published terminal state
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    upsertJob(job.workspaceRoot, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    throw error;
  }
}
