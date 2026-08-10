import fs from "node:fs";
import process from "node:process";

import { isPidAlive } from "./process.mjs";
import { loadState, readJobFile, resolveJobClaimFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
    const storedJob = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
    // A cancel can land while the turn is still streaming notifications;
    // a terminal record must not regain a live phase or a fresher updatedAt.
    // The claim file appears before the terminal record is written, so it
    // covers the window in which the cancelled record itself is not yet
    // visible. The turn identity is the exception: cancel and session-end
    // can only interrupt the server-side turn with threadId/turnId, and
    // this updater may hold the only copy — persist those fields alone.
    if ((storedJob && TERMINAL_JOB_STATUSES.has(storedJob.status)) || terminalClaimTaken(workspaceRoot, jobId)) {
      const identityPatch = {};
      if (patch.threadId && !storedJob?.threadId) {
        identityPatch.threadId = patch.threadId;
      }
      if (patch.turnId && !storedJob?.turnId) {
        identityPatch.turnId = patch.turnId;
      }
      if (Object.keys(identityPatch).length > 0) {
        upsertJob(workspaceRoot, { id: jobId, ...identityPatch });
        // Merge onto a fresh read, not the earlier snapshot: the claimant's
        // terminal record may have landed in between, and re-writing the
        // stale snapshot would revert it to running.
        const freshJob = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
        if (freshJob) {
          writeJobFile(workspaceRoot, jobId, { ...freshJob, ...identityPatch });
        }
        // Converge if the write above still raced the claimant.
        if (terminalClaimTaken(workspaceRoot, jobId)) {
          reassertTerminalClaim(workspaceRoot, jobId, freshJob);
        }
      }
      return;
    }

    upsertJob(workspaceRoot, patch);

    if (storedJob) {
      writeJobFile(workspaceRoot, jobId, {
        ...storedJob,
        ...patch
      });
    }

    // A cancel may have claimed the terminal status while the writes above
    // were in flight, in which case the stale progress write just reverted
    // its record; converge back to terminal rather than leaving the stale
    // write as the last word.
    if (terminalClaimTaken(workspaceRoot, jobId)) {
      reassertTerminalClaim(workspaceRoot, jobId, storedJob);
    }
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

function isJobCancelled(workspaceRoot, jobId) {
  return readStoredJobOrNull(workspaceRoot, jobId)?.status === "cancelled";
}

export function terminalClaimTaken(workspaceRoot, jobId) {
  return fs.existsSync(resolveJobClaimFile(workspaceRoot, jobId));
}

// A cancellation can land before the worker persisted the turn identity;
// the updater still records threadId/turnId after the claim (job file and
// state index receive it through separate writes), so wait for it — while
// the worker is alive to produce it, and bounded by the caller's deadline —
// rather than skipping the interrupt and orphaning the turn.
export async function waitForTurnIdentity(workspaceRoot, jobId, { threadId = null, turnId = null, deadline, workerPid = null } = {}) {
  // The caller's snapshot can predate the worker: with record-before-spawn
  // the initial record has pid null, so the pid itself must be refreshed
  // from the stores alongside the identity — gating on the stale NaN would
  // end the wait after one read while the worker (and its turn) live on.
  let pid = workerPid;
  const refresh = () => {
    const stored = readStoredJobOrNull(workspaceRoot, jobId);
    threadId = stored?.threadId ?? threadId;
    turnId = stored?.turnId ?? turnId;
    pid = stored?.pid ?? pid;
    if (!threadId || !turnId || pid == null) {
      const indexed = loadState(workspaceRoot).jobs.find((candidate) => candidate.id === jobId);
      threadId = indexed?.threadId ?? threadId;
      turnId = indexed?.turnId ?? turnId;
      pid = pid ?? indexed?.pid ?? null;
    }
  };
  // Always read once up front: the worker may have persisted the identity
  // and then exited — a dead worker must not mean the ids are unread.
  refresh();
  while ((!threadId || !turnId) && Date.now() < deadline) {
    if (Number.isFinite(pid) && !isPidAlive(pid)) {
      // A known-dead worker will never publish more; an unknown pid keeps
      // polling — the record may still gain it (bounded by the deadline).
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    refresh();
  }
  return { threadId, turnId, workerPid: Number.isFinite(pid) ? pid : null };
}

export function readTerminalClaim(workspaceRoot, jobId) {
  try {
    const raw = fs.readFileSync(resolveJobClaimFile(workspaceRoot, jobId), "utf8");
    const [pidToken, intentToken] = raw.trim().split(/\s+/);
    const pid = Number.parseInt(pidToken ?? "", 10);
    return {
      pid: Number.isFinite(pid) ? pid : null,
      intent: intentToken ?? "cancel"
    };
  } catch {
    return null;
  }
}

// A taken claim whose terminal record has not landed yet (or was overwritten
// by a racing non-terminal write) is repaired here: converge the stored
// records back to cancelled. Any racing writer that owns the claim writes its
// own terminal record after claiming, so the later write wins either way and
// both orders end terminal.
export function reassertTerminalClaim(workspaceRoot, jobId, fallbackRecord = null, { force = false } = {}) {
  const stored = readStoredJobOrNull(workspaceRoot, jobId) ?? fallbackRecord;
  if (stored && TERMINAL_JOB_STATUSES.has(stored.status)) {
    // The job file is already terminal, but a racing non-terminal upsert
    // (e.g. the worker's running record landing after the cancel's write)
    // may have reverted the state.json index; synchronize it.
    upsertJob(workspaceRoot, {
      id: jobId,
      status: stored.status,
      phase: stored.phase ?? stored.status,
      pid: null,
      ...(stored.completedAt ? { completedAt: stored.completedAt } : {}),
      ...(stored.errorMessage ? { errorMessage: stored.errorMessage } : {})
    });
    return;
  }
  const claim = readTerminalClaim(workspaceRoot, jobId);
  if (!force && claim?.intent === "worker" && claim.pid != null && isPidAlive(claim.pid)) {
    // A live worker is finalizing its own outcome right now; don't preempt
    // its completed/failed write with a repair record. Callers that just
    // force-killed the claimant pass force: the pid can linger as a zombie
    // and would otherwise read as alive.
    return;
  }
  // The claim records who took it: a claim taken for the worker's own
  // terminal write (or by the reaper for a dead worker) means the job
  // actually ran and its outcome was lost — that is a failure, not a
  // cancellation.
  const intent = claim?.intent ?? "cancel";
  const terminalStatus = intent === "worker" || intent === "reaper" ? "failed" : "cancelled";
  const patch = {
    status: terminalStatus,
    phase: terminalStatus,
    pid: null,
    completedAt: nowIso(),
    ...(stored?.errorMessage
      ? {}
      : {
          errorMessage:
            terminalStatus === "failed"
              ? "Failed: the worker died before recording its outcome."
              : "Cancelled: a cancellation was recorded while the job was starting or running."
        })
  };
  try {
    writeJobFile(workspaceRoot, jobId, { ...(stored ?? { id: jobId }), ...patch });
  } catch {
    // Best-effort: the state.json record below is the canonical outcome.
  }
  upsertJob(workspaceRoot, { id: jobId, ...patch });
}

export function claimTerminalStatus(workspaceRoot, jobId, intent = "cancel") {
  // First writer wins: creating the claim file atomically decides whether the
  // worker's completed/failed write or a cancellation owns the job's terminal
  // status. Checking the stored record alone is not enough — a cancellation
  // can land between that check and the terminal write. The recorded intent
  // lets an orphaned claim be repaired to the right terminal status.
  try {
    fs.writeFileSync(resolveJobClaimFile(workspaceRoot, jobId), `${process.pid} ${intent}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    // If the claim file cannot be created at all, fall back to the previous
    // last-writer-wins behavior rather than blocking the terminal write.
    return true;
  }
}

export async function runTrackedJob(job, runner, options = {}) {
  // A cancellation may have been recorded before the worker got this far
  // (e.g. cancel raced worker startup); never resurrect a cancelled job. A
  // taken claim without a cancelled record (the claimant died or its record
  // write hasn't landed) counts the same and is repaired to cancelled.
  if (isJobCancelled(job.workspaceRoot, job.id)) {
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }
  if (terminalClaimTaken(job.workspaceRoot, job.id)) {
    reassertTerminalClaim(job.workspaceRoot, job.id, job);
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }

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
  // A cancel may have claimed the terminal status between the checks above
  // and the running writes, which would have just overwritten its cancelled
  // record. Re-check after writing: a claim that lands after this point is
  // followed by the claimant's own record writes, which land after ours.
  if (terminalClaimTaken(job.workspaceRoot, job.id)) {
    reassertTerminalClaim(job.workspaceRoot, job.id, runningRecord);
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }

  try {
    const execution = await runner();
    // Cancellation is terminal: if it was recorded while the turn was
    // finishing (cancel awaits turn/interrupt before killing the worker, so
    // the turn can complete during that window), keep the cancelled record
    // instead of overwriting it with completed/failed. The terminal claim
    // closes the remaining gap where the cancel lands after this check but
    // before the write below.
    if (isJobCancelled(job.workspaceRoot, job.id) || !claimTerminalStatus(job.workspaceRoot, job.id, "worker")) {
      // The cancellation owns the terminal status — but if the claimant
      // crashed before its record writes landed, backing off here would
      // leave both stores at running/stale-pid forever; converge them.
      reassertTerminalClaim(job.workspaceRoot, job.id, runningRecord);
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (after cancellation)", execution.rendered);
      return execution;
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
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    if (existing.status === "cancelled" || !claimTerminalStatus(job.workspaceRoot, job.id, "worker")) {
      // Same convergence as the success path: a claim whose record writes
      // never landed must not leave running/stale-pid records behind.
      reassertTerminalClaim(job.workspaceRoot, job.id, existing);
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
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
