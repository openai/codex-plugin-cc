import fs from "node:fs";
import process from "node:process";

import { isProcessAlive } from "./process.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

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

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (readTerminalFence(workspaceRoot, jobId) || !fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
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
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function resolveTerminalFenceFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".terminal.json");
}

function terminalPhase(status) {
  return status === "completed" ? "done" : status;
}

export function readTerminalFence(workspaceRoot, jobId) {
  const fenceFile = resolveTerminalFenceFile(workspaceRoot, jobId);
  if (!fs.existsSync(fenceFile)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(fenceFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || !TERMINAL_STATUSES.has(parsed.status)) {
      throw new Error("invalid terminal status");
    }
    return {
      status: parsed.status,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null
    };
  } catch {
    return { status: "failed", completedAt: null, corrupt: true };
  }
}

function applyTerminalFence(job, fence) {
  if (!fence) {
    return job;
  }
  return {
    ...job,
    status: fence.status,
    phase: terminalPhase(fence.status),
    pid: null,
    completedAt: fence.completedAt ?? job.completedAt ?? null,
    ...(fence.corrupt ? { errorMessage: "Terminal job fence is corrupt." } : {})
  };
}

function claimTerminalFence(workspaceRoot, jobId, status, completedAt) {
  const fenceFile = resolveTerminalFenceFile(workspaceRoot, jobId);
  try {
    const descriptor = fs.openSync(fenceFile, "wx");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ status, completedAt })}\n`, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    return { fence: { status, completedAt }, claimed: true };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    return { fence: readTerminalFence(workspaceRoot, jobId), claimed: false };
  }
}

export function readEffectiveStoredJob(workspaceRoot, jobId) {
  const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
  return storedJob ? applyTerminalFence(storedJob, readTerminalFence(workspaceRoot, jobId)) : null;
}

export function terminalizeTrackedJob(workspaceRoot, job, terminal) {
  const completedAt = terminal.completedAt ?? nowIso();
  const { fence, claimed } = claimTerminalFence(workspaceRoot, job.id, terminal.status, completedAt);
  const storedJob = readStoredJobOrNull(workspaceRoot, job.id);
  const effectiveJob = applyTerminalFence({ ...(storedJob ?? job), ...terminal }, fence);

  if (!claimed) {
    return { job: storedJob ? applyTerminalFence(storedJob, fence) : null, claimed };
  }

  writeJobFile(workspaceRoot, job.id, effectiveJob);
  upsertJob(workspaceRoot, effectiveJob);
  return { job: effectiveJob, claimed };
}

function failTrackedJob(workspaceRoot, job, errorMessage) {
  return terminalizeTrackedJob(workspaceRoot, job, {
    status: "failed",
    phase: "failed",
    errorMessage,
    pid: null,
    completedAt: nowIso()
  }).job;
}

export function reconcileTrackedJobs(workspaceRoot, options = {}) {
  const now = options.now ?? Date.now();

  return listJobs(workspaceRoot).flatMap((job) => {
    const fence = readTerminalFence(workspaceRoot, job.id);
    if (fence) {
      return fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? [applyTerminalFence(job, fence)] : [];
    }
    if (job.status !== "queued" && job.status !== "running") {
      return [job];
    }

    const ageMs = now - Date.parse(job.createdAt ?? "");
    if (job.status === "queued" && !Number.isFinite(job.pid) && Number.isFinite(ageMs) && ageMs >= 5000) {
      return [failTrackedJob(workspaceRoot, job, "Background worker did not start within 5 seconds.")];
    }
    if (Number.isFinite(job.pid) && !isProcessAlive(job.pid, { killImpl: options.killImpl })) {
      return [failTrackedJob(workspaceRoot, job, "Background worker exited before completing the job.")];
    }

    return [job];
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  const storedJob = readStoredJobOrNull(job.workspaceRoot, job.id);
  const fence = readTerminalFence(job.workspaceRoot, job.id);
  if (fence) {
    return storedJob ? applyTerminalFence(storedJob, fence) : null;
  }
  if (storedJob && storedJob.status !== "queued") {
    return storedJob;
  }
  if (!storedJob && job.request) {
    return null;
  }

  const runningRecord = {
    ...(storedJob ?? job),
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const terminal = terminalizeTrackedJob(job.workspaceRoot, runningRecord, {
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
    if (terminal.claimed) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    terminalizeTrackedJob(job.workspaceRoot, runningRecord, {
      ...runningRecord,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? runningRecord.logFile ?? null
    });
    throw error;
  }
}
