import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const JOB_LOCK_WAIT_MS = 5;
const JOB_LOCK_TIMEOUT_MS = 1000;
const JOB_LOCK_STALE_MS = 10000;
const jobLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

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

    withJobLock(workspaceRoot, jobId, () => {
      const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
      if (!storedJob || ["cancelled", "completed", "failed"].includes(storedJob.status)) {
        return;
      }
      writeJobFile(workspaceRoot, jobId, {
        ...storedJob,
        ...patch
      });
      upsertJob(workspaceRoot, {
        ...patch,
        status: storedJob.status
      });
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

function withJobLock(workspaceRoot, jobId, operation) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const lockFile = `${jobFile}.lock`;
  const deadline = Date.now() + JOB_LOCK_TIMEOUT_MS;
  let descriptor;

  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > JOB_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") {
          throw statError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for job ${jobId} state transition.`);
      }
      Atomics.wait(jobLockWaitArray, 0, 0, JOB_LOCK_WAIT_MS);
    }
  }

  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockFile);
  }
}

function writeRunningJob(job, options) {
  return withJobLock(job.workspaceRoot, job.id, () => {
    const storedJob = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (storedJob?.status === "cancelled") {
      return null;
    }
    const runningRecord = {
      ...job,
      ...storedJob,
      status: "running",
      startedAt: nowIso(),
      phase: "starting",
      pid: process.pid,
      logFile: options.logFile ?? storedJob?.logFile ?? job.logFile ?? null
    };
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
    return runningRecord;
  });
}

export function cancelTrackedJob(workspaceRoot, jobId, patch) {
  return withJobLock(workspaceRoot, jobId, () => {
    const storedJob = readStoredJobOrNull(workspaceRoot, jobId) ?? patch;
    if (!["queued", "running"].includes(storedJob.status)) {
      return null;
    }
    const cancelledJob = {
      ...storedJob,
      ...patch,
      status: "cancelled",
      phase: "cancelled",
      pid: null
    };
    writeJobFile(workspaceRoot, jobId, cancelledJob);
    upsertJob(workspaceRoot, {
      id: jobId,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      errorMessage: cancelledJob.errorMessage ?? null,
      completedAt: cancelledJob.completedAt ?? null
    });
    return { previous: storedJob, job: cancelledJob };
  });
}

export function recordQueuedJobPid(workspaceRoot, jobId, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return withJobLock(workspaceRoot, jobId, () => {
    const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
    if (storedJob?.status === "running") {
      return storedJob.pid === pid;
    }
    if (storedJob?.status !== "queued") {
      return false;
    }
    const queuedJob = { ...storedJob, pid };
    writeJobFile(workspaceRoot, jobId, queuedJob);
    upsertJob(workspaceRoot, { id: jobId, status: "queued", pid });
    return true;
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = writeRunningJob(job, options);
  if (!runningRecord) {
    return null;
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const recorded = withJobLock(job.workspaceRoot, job.id, () => {
      const storedJob = readStoredJobOrNull(job.workspaceRoot, job.id);
      if (storedJob?.status === "cancelled") {
        return false;
      }
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        ...storedJob,
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
      return true;
    });
    if (recorded) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const recorded = withJobLock(job.workspaceRoot, job.id, () => {
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
      if (existing.status === "cancelled") {
        return false;
      }
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
      return true;
    });
    if (!recorded) {
      return null;
    }
    throw error;
  }
}
