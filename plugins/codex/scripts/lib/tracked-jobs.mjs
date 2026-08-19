import fs from "node:fs";
import process from "node:process";

import { isProcessAlive } from "./process.mjs";
import { isJobRemovedLocked, listJobs, readJobFile, resolveJobFile, resolveJobLogFile, updateState, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const GATE_KEY_ENV = "CODEX_COMPANION_GATE_KEY";

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
  let created = false;
  try {
    fs.closeSync(fs.openSync(logFile, "wx"));
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  if (created && title) {
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
    if (isJobRemoved(workspaceRoot, jobId) || readTerminalFence(workspaceRoot, jobId) || !fs.existsSync(jobFile)) {
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

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function resolveTerminalFenceFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".terminal.json");
}

function resolveInitialClaimFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".started.json");
}

function resolveRemovedFenceFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".removed");
}

function resolveAdmissionFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".admission.json");
}

function isJobRemoved(workspaceRoot, jobId) {
  return fs.existsSync(resolveRemovedFenceFile(workspaceRoot, jobId));
}

export function markTrackedJobRemoved(workspaceRoot, jobId) {
  claimFile(resolveRemovedFenceFile(workspaceRoot, jobId), "");
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
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
      removed: parsed.removed === true
    };
  } catch {
    return { status: "failed", completedAt: null, corrupt: true };
  }
}

function readInitialClaim(workspaceRoot, jobId) {
  const claimFile = resolveInitialClaimFile(workspaceRoot, jobId);
  if (!fs.existsSync(claimFile)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(claimFile, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid initial claim");
    }
    if (parsed.status === "running" && Number.isFinite(parsed.pid) && typeof parsed.startedAt === "string") {
      return { status: "running", pid: parsed.pid, startedAt: parsed.startedAt };
    }
    if (TERMINAL_STATUSES.has(parsed.status)) {
      return {
        status: parsed.status,
        completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
        removed: parsed.removed === true
      };
    }
    throw new Error("invalid initial claim status");
  } catch {
    return { status: "failed", completedAt: null, corrupt: true };
  }
}

function readAdmissionClaim(workspaceRoot, jobId) {
  const admissionFile = resolveAdmissionFile(workspaceRoot, jobId);
  if (!fs.existsSync(admissionFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(admissionFile, "utf8"));
    if (parsed?.status === "admitted") {
      return { status: "admitted" };
    }
    if (TERMINAL_STATUSES.has(parsed?.status)) {
      return { status: parsed.status, completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null };
    }
    throw new Error("invalid admission claim");
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

function removedLifecycleRecord(job) {
  return { ...job, status: "cancelled", phase: "cancelled", pid: null, removed: true };
}

function missingTrackedJobRecord(job) {
  return { ...job, status: "failed", phase: "failed", pid: null, errorMessage: "Tracked job record is missing." };
}

function applyInitialClaim(job, claim) {
  if (!claim) {
    return job;
  }
  if (claim.status === "running") {
    return { ...job, status: "running", phase: job.phase === "queued" ? "starting" : job.phase, pid: claim.pid, startedAt: claim.startedAt };
  }
  return applyTerminalFence(job, claim);
}

function claimFile(file, payload) {
  try {
    const descriptor = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function claimTerminalFence(workspaceRoot, jobId, status, completedAt, removed = false) {
  const fenceFile = resolveTerminalFenceFile(workspaceRoot, jobId);
  if (claimFile(fenceFile, { status, completedAt, ...(removed ? { removed: true } : {}) })) {
    return { fence: { status, completedAt, removed }, claimed: true };
  }
  return { fence: readTerminalFence(workspaceRoot, jobId), claimed: false };
}

export function readEffectiveStoredJob(workspaceRoot, jobId) {
  if (isJobRemoved(workspaceRoot, jobId)) {
    return null;
  }
  const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
  if (!storedJob) {
    return null;
  }
  const initial = readInitialClaim(workspaceRoot, jobId);
  const admission = initial?.status === "running" ? readAdmissionClaim(workspaceRoot, jobId) : null;
  if (admission && admission.status !== "admitted") {
    return applyTerminalFence(applyInitialClaim(storedJob, initial), admission);
  }
  const fence = initial?.status === "running" ? readTerminalFence(workspaceRoot, jobId) : null;
  return applyTerminalFence(applyInitialClaim(storedJob, initial), fence);
}

export function terminalizeTrackedJob(workspaceRoot, job, terminal) {
  if (isJobRemoved(workspaceRoot, job.id)) {
    return { job: removedLifecycleRecord(job), claimed: false };
  }
  const completedAt = terminal.completedAt ?? nowIso();
  let initial = readInitialClaim(workspaceRoot, job.id);
  if (!initial) {
    const claimed = claimFile(resolveInitialClaimFile(workspaceRoot, job.id), {
      status: terminal.status,
      completedAt
    });
    const winner = claimed ? { status: terminal.status, completedAt } : readInitialClaim(workspaceRoot, job.id);
    const storedJob = readStoredJobOrNull(workspaceRoot, job.id);
    if (!claimed && winner?.status !== "running") {
      return { job: applyTerminalFence(storedJob ?? job, winner), claimed };
    }
    if (claimed) {
      const effectiveJob = applyTerminalFence({ ...(storedJob ?? job), ...terminal }, winner);
      writeJobFile(workspaceRoot, job.id, effectiveJob);
      upsertJob(workspaceRoot, effectiveJob);
      return { job: effectiveJob, claimed };
    }
    initial = winner;
  }
  if (initial.status !== "running") {
    return { job: applyTerminalFence(readStoredJobOrNull(workspaceRoot, job.id) ?? job, initial), claimed: false };
  }
  const admission = readAdmissionClaim(workspaceRoot, job.id);
  if (!admission) {
    const claimed = claimFile(resolveAdmissionFile(workspaceRoot, job.id), { status: terminal.status, completedAt });
    const winner = claimed ? { status: terminal.status, completedAt } : readAdmissionClaim(workspaceRoot, job.id);
    if (winner?.status !== "admitted") {
      return { job: applyTerminalFence(readStoredJobOrNull(workspaceRoot, job.id) ?? job, winner), claimed };
    }
  } else if (admission.status !== "admitted") {
    return { job: applyTerminalFence(readStoredJobOrNull(workspaceRoot, job.id) ?? job, admission), claimed: false };
  }
  const { fence, claimed } = claimTerminalFence(workspaceRoot, job.id, terminal.status, completedAt, terminal.removed);
  const storedJob = readStoredJobOrNull(workspaceRoot, job.id);
  const effectiveJob = applyTerminalFence({ ...(storedJob ?? job), ...terminal }, fence);

  if (!claimed) {
    return { job: applyTerminalFence(storedJob ?? job, fence), claimed };
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
    if (isJobRemoved(workspaceRoot, job.id)) {
      return [];
    }
    const storedJob = readStoredJobOrNull(workspaceRoot, job.id);
    if (storedJob) {
      job = { ...job, ...storedJob };
    }
    const initial = readInitialClaim(workspaceRoot, job.id);
    if (initial && initial.status !== "running") {
      return fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? [applyTerminalFence(job, initial)] : [];
    }
    const admission = initial?.status === "running" ? readAdmissionClaim(workspaceRoot, job.id) : null;
    if (admission && admission.status !== "admitted") {
      return fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? [applyTerminalFence(job, admission)] : [];
    }
    const fence = readTerminalFence(workspaceRoot, job.id);
    if (fence) {
      return fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? [applyTerminalFence(job, fence)] : [];
    }
    job = applyInitialClaim(job, initial);
    if (job.status !== "queued" && job.status !== "running") {
      return [job];
    }

    if (job.status === "running" && (!Number.isSafeInteger(job.pid) || job.pid <= 0)) {
      const failedJob = failTrackedJob(workspaceRoot, job, "Tracked running job has an invalid process id.");
      return failedJob ? [failedJob] : [];
    }

    const ageMs = now - Date.parse(job.createdAt ?? "");
    if (job.status === "queued" && !Number.isFinite(ageMs)) {
      const failedJob = failTrackedJob(workspaceRoot, job, "Tracked queued job has an invalid creation time.");
      return failedJob ? [failedJob] : [];
    }
    if (job.status === "queued" && !Number.isFinite(job.pid) && ageMs >= 5000) {
      const failedJob = failTrackedJob(workspaceRoot, job, "Background worker did not start within 5 seconds.");
      return failedJob ? [failedJob] : [];
    }
    if (Number.isFinite(job.pid) && !isProcessAlive(job.pid, { killImpl: options.killImpl })) {
      const failedJob = failTrackedJob(workspaceRoot, job, "Background worker exited before completing the job.");
      return failedJob ? [failedJob] : [];
    }

    return [job];
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  if (isJobRemoved(job.workspaceRoot, job.id)) {
    return removedLifecycleRecord(job);
  }
  const storedJob = readStoredJobOrNull(job.workspaceRoot, job.id);
  const initial = readInitialClaim(job.workspaceRoot, job.id);
  if (initial && initial.status !== "running") {
    return applyTerminalFence(storedJob ?? job, initial);
  }
  if (initial?.status === "running") {
    if (job.gateKey && !storedJob && !isProcessAlive(initial.pid)) {
      return terminalizeTrackedJob(job.workspaceRoot, job, {
        status: "failed",
        phase: "failed",
        errorMessage: "Stop-gate worker exited before publishing its job record.",
        pid: null,
        completedAt: nowIso()
      }).job;
    }
    const terminal = readTerminalFence(job.workspaceRoot, job.id);
    if (terminal) {
      return applyTerminalFence(storedJob ?? job, terminal);
    }
    const admission = readAdmissionClaim(job.workspaceRoot, job.id);
    if (admission?.status !== "admitted") {
      return applyTerminalFence(storedJob ?? job, admission);
    }
    return applyInitialClaim(storedJob ?? job, initial);
  }
  const fence = readTerminalFence(job.workspaceRoot, job.id);
  if (fence) {
    return applyTerminalFence(storedJob ?? job, fence);
  }
  if (storedJob && storedJob.status !== "queued") {
    return storedJob;
  }
  if (!storedJob && job.request) {
    return missingTrackedJobRecord(job);
  }

  const startedAt = nowIso();
  const runningClaim = { status: "running", pid: process.pid, startedAt };
  if (!claimFile(resolveInitialClaimFile(job.workspaceRoot, job.id), runningClaim)) {
    const winner = readInitialClaim(job.workspaceRoot, job.id);
    return applyInitialClaim(storedJob ?? job, winner);
  }
  const runningRecord = {
    ...(storedJob ?? job),
    status: "running",
    startedAt,
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);
  if (isJobRemoved(job.workspaceRoot, job.id)) {
    return removedLifecycleRecord(runningRecord);
  }
  const terminalAfterStart = readTerminalFence(job.workspaceRoot, job.id);
  if (terminalAfterStart) {
    return applyTerminalFence(runningRecord, terminalAfterStart);
  }
  let admitted = false;
  updateState(job.workspaceRoot, () => {
    if (!isJobRemoved(job.workspaceRoot, job.id)) {
      admitted = claimFile(resolveAdmissionFile(job.workspaceRoot, job.id), { status: "admitted" });
    }
  });
  if (!admitted) {
    if (isJobRemoved(job.workspaceRoot, job.id)) {
      return removedLifecycleRecord(runningRecord);
    }
    return applyTerminalFence(runningRecord, readAdmissionClaim(job.workspaceRoot, job.id));
  }

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
      if (isJobRemovedLocked(job.workspaceRoot, job.id)) {
        return removedLifecycleRecord(runningRecord);
      }
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
      return execution;
    }
    return terminal.job;
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
