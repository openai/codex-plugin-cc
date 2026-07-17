import fs from "node:fs";
import process from "node:process";

import { processHasLaunchToken, terminateProcessTree, waitForProcessExit } from "./process.mjs";
import { loadState, readJobFile, resolveJobFile, resolveJobLogFile, updateState, upsertJob, writeJobFile } from "./state.mjs";

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

export async function waitForWorkerJob(workspaceRoot, jobId, workerToken, workerPid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 25;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (fs.existsSync(jobFile)) {
      const storedJob = readJobFile(jobFile);
      if (storedJob.workerToken !== workerToken) {
        throw new Error(`Stored job ${jobId} worker identity does not match this process.`);
      }
      const indexedJob = loadState(workspaceRoot).jobs.find((job) => job.id === jobId);
      if (
        storedJob.pid === workerPid &&
        indexedJob?.pid === workerPid &&
        indexedJob.workerToken === workerToken
      ) {
        return storedJob;
      }
      if (storedJob.pid !== null && storedJob.pid !== undefined && storedJob.pid !== workerPid) {
        throw new Error(`Stored job ${jobId} belongs to worker process ${storedJob.pid}, not ${workerPid}.`);
      }
      if (
        indexedJob?.pid !== null &&
        indexedJob?.pid !== undefined &&
        indexedJob.pid !== workerPid
      ) {
        throw new Error(`Indexed job ${jobId} belongs to worker process ${indexedJob.pid}, not ${workerPid}.`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for stored job ${jobId} to register worker process ${workerPid}.`);
}

export async function cleanupSessionJobs(workspaceRoot, sessionId, options = {}) {
  if (!sessionId && !options.all) {
    return { removed: [], retained: [] };
  }

  const state = loadState(workspaceRoot);
  const removedJobs = [];
  const retainedJobs = [];
  const failures = [];

  for (const job of state.jobs) {
    const belongsToSession = options.all || job.sessionId === sessionId;
    if (!belongsToSession) {
      continue;
    }

    const isActive = job.status === "queued" || job.status === "running";
    if (isActive) {
      try {
        const ownsProcess = options.verifyProcess
          ? options.verifyProcess(job.pid, job.workerToken)
          : processHasLaunchToken(job.pid, job.workerToken, {
              platform: options.platform,
              timeoutMs: options.timeoutMs,
              runCommandImpl: options.runCommandImpl
            });
        if (!ownsProcess) {
          throw new Error(
            `Cannot verify that process ${job.pid ?? "unknown"} owns Codex job ${job.id}; state was preserved.`
          );
        }
        terminateProcessTree(job.pid, {
          platform: options.platform,
          timeoutMs: options.timeoutMs,
          runCommandImpl: options.runCommandImpl,
          killImpl: options.killImpl
        });
        const exited = await waitForProcessExit(job.pid, {
          platform: options.platform,
          timeoutMs: options.timeoutMs,
          intervalMs: options.intervalMs,
          killImpl: options.killImpl
        });
        if (!exited) {
          throw new Error(`Codex job ${job.id} process ${job.pid ?? "unknown"} did not exit.`);
        }
      } catch (error) {
        retainedJobs.push(job);
        failures.push(error);
        continue;
      }
    }

    removedJobs.push(job);
  }

  const removedIds = new Set(removedJobs.map((job) => job.id));
  updateState(workspaceRoot, (freshState) => {
    freshState.jobs = freshState.jobs.filter((job) => !removedIds.has(job.id));
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to stop all Codex session jobs.");
  }
  return {
    removed: removedJobs.map((job) => job.id),
    retained: retainedJobs.map((job) => job.id)
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
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
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
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
