import fs from "node:fs";
import process from "node:process";

import { isJobCancellationRequested, isJobRemovalRequested, readJobFile, removeJobFromState, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

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
    if (isJobRemovalRequested(workspaceRoot, jobId)) {
      return;
    }
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

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
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
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function removedExecution(job) {
  return {
    exitStatus: 0,
    payload: { jobId: job.id, status: "removed" },
    rendered: "",
    summary: "Session ended.",
    threadId: null,
    turnId: null
  };
}

export function failTrackedJobLaunch(job, error) {
  if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
    return { ...job, status: "removed", phase: "removed", pid: null };
  }
  const currentJob = readStoredJobOrNull(job.workspaceRoot, job.id) ?? job;
  if (isJobCancellationRequested(job.workspaceRoot, job.id) || currentJob.status !== "queued") {
    return currentJob;
  }
  const completedAt = nowIso();
  const errorMessage = `Background worker failed to start: ${error instanceof Error ? error.message : String(error)}`;
  const failedRecord = { ...currentJob, status: "failed", phase: "failed", pid: null, completedAt, errorMessage };
  writeJobFile(job.workspaceRoot, job.id, failedRecord);
  upsertJob(job.workspaceRoot, failedRecord);

  if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
    const jobFile = resolveJobFile(job.workspaceRoot, job.id);
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
    removeJobFromState(job.workspaceRoot, job.id);
    return { ...currentJob, status: "removed", phase: "removed", pid: null };
  }

  if (isJobCancellationRequested(job.workspaceRoot, job.id)) {
    const cancelledAt = nowIso();
    const cancelledRecord = {
      ...currentJob,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt: cancelledAt,
      cancelledAt,
      errorMessage: "Cancelled by user."
    };
    writeJobFile(job.workspaceRoot, job.id, cancelledRecord);
    upsertJob(job.workspaceRoot, cancelledRecord);
    return cancelledRecord;
  }

  appendLogLine(currentJob.logFile ?? null, errorMessage);
  return failedRecord;
}

export async function runTrackedJob(job, runner, options = {}) {
  if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
    return removedExecution(job);
  }
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  try {
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
      const jobFile = resolveJobFile(job.workspaceRoot, job.id);
      if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
      return removedExecution(job);
    }
    upsertJob(job.workspaceRoot, runningRecord);
    if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
      removeJobFromState(job.workspaceRoot, job.id);
      return removedExecution(job);
    }
    if (isJobCancellationRequested(job.workspaceRoot, job.id)) {
      const completedAt = nowIso();
      const cancelledRecord = {
        ...runningRecord,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt,
        cancelledAt: completedAt,
        errorMessage: "Cancelled by user."
      };
      writeJobFile(job.workspaceRoot, job.id, cancelledRecord);
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt,
        cancelledAt: completedAt,
        errorMessage: "Cancelled by user."
      });
      if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
        const jobFile = resolveJobFile(job.workspaceRoot, job.id);
        if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
        removeJobFromState(job.workspaceRoot, job.id);
        return removedExecution(job);
      }
      appendLogLine(options.logFile ?? job.logFile ?? null, "Cancelled before task execution.");
      return {
        exitStatus: 0,
        payload: { jobId: job.id, status: "cancelled" },
        rendered: "Cancelled by user.\n",
        summary: "Cancelled by user.",
        threadId: null,
        turnId: null
      };
    }
    const execution = await runner();
    if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
      removeJobFromState(job.workspaceRoot, job.id);
      return removedExecution(job);
    }
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    if (isJobRemovalRequested(job.workspaceRoot, job.id)) {
      removeJobFromState(job.workspaceRoot, job.id);
      return removedExecution(job);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
