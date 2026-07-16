import { terminateProcessTree } from "./process.mjs";
import { updateJobStores } from "./state.mjs";

export const WORKER_TURN_STATES = Object.freeze({
  STARTING: "starting",
  STARTED: "started",
  SUPPRESSED: "suppressed",
  INTERRUPTING: "interrupting",
  INTERRUPTED: "interrupted",
  STOPPED: "stopped",
  INTERRUPT_FAILED: "interrupt-failed",
  START_REJECTED: "start-rejected",
  START_UNKNOWN: "start-unknown"
});

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function isTerminalJobRecord(stateJob, storedJob = null) {
  return !isActiveJobStatus(stateJob?.status) || Boolean(storedJob && !isActiveJobStatus(storedJob.status));
}

function resolveLaunchStatus(stateJob, storedJob = null, fallback = "queued") {
  if (stateJob?.status === "cancelled" || storedJob?.status === "cancelled") {
    return "cancelled";
  }
  for (const status of [stateJob?.status, storedJob?.status]) {
    if (status && !isActiveJobStatus(status)) {
      return status;
    }
  }
  return stateJob?.status ?? storedJob?.status ?? fallback;
}

function buildTerminalJob(stateJob, storedJob, status) {
  const terminalSource = stateJob.status === status ? stateJob : storedJob;
  return {
    ...stateJob,
    ...(storedJob ?? {}),
    ...(terminalSource ?? {}),
    status,
    pid: null
  };
}

function isClaimableByWorker(job, workerPid) {
  return job.status === "queued" || (job.status === "running" && Number(job.pid) === workerPid);
}

function buildMissingWorkerOutcome(stateJob, storedJob) {
  return {
    claimed: false,
    status: "missing",
    job: storedJob ?? stateJob
  };
}

function buildTerminalWorkerOutcome(stateJob, storedJob, options = {}) {
  const status = resolveLaunchStatus(stateJob, storedJob, "cancelled");
  const terminalJob = buildTerminalJob(stateJob, storedJob, status);
  const patchedJob = {
    ...terminalJob,
    ...(options.jobPatch ?? {})
  };
  const nextJob = options.turnLifecycle
    ? {
        ...patchedJob,
        turnLifecycle: {
          ...(patchedJob.turnLifecycle ?? {}),
          ...options.turnLifecycle
        }
      }
    : patchedJob;
  return {
    stateJob: nextJob,
    storedJob: nextJob,
    value: {
      claimed: false,
      proceed: false,
      status,
      job: nextJob
    }
  };
}

function claimTaskWorker(workspaceRoot, jobId, workerPid, options = {}) {
  const transaction = updateJobStores(
    workspaceRoot,
    jobId,
    ({ stateJob, storedJob }) => {
      if (!stateJob || !storedJob) {
        return {
          value: buildMissingWorkerOutcome(stateJob, storedJob)
        };
      }

      if (isTerminalJobRecord(stateJob, storedJob)) {
        return buildTerminalWorkerOutcome(stateJob, storedJob);
      }

      if (!isClaimableByWorker(stateJob, workerPid) || !isClaimableByWorker(storedJob, workerPid)) {
        const status = stateJob.status === "running" || storedJob.status === "running" ? "running" : "queued";
        return {
          value: {
            claimed: false,
            status,
            job: {
              ...storedJob,
              ...stateJob,
              status
            }
          }
        };
      }

      const claimedAt = new Date().toISOString();
      const claimedJob = {
        ...storedJob,
        ...stateJob,
        status: "running",
        phase: "starting",
        pid: workerPid,
        startedAt: stateJob.startedAt ?? storedJob.startedAt ?? claimedAt,
        updatedAt: claimedAt
      };
      return {
        stateJob: claimedJob,
        storedJob: claimedJob,
        value: {
          claimed: true,
          status: "running",
          job: claimedJob
        }
      };
    },
    { beforeCommit: options.beforeCommit }
  );
  return transaction.value;
}

function prepareClaimedWorkerTurn(workspaceRoot, jobId, workerPid, { threadId } = {}) {
  const preparedAt = new Date().toISOString();
  // This transaction is the turn-handoff linearization point. Cancellation
  // either wins first and suppresses the request, or observes STARTING and waits
  // for the worker to publish a turn ID or a definitive no-start outcome.
  const transaction = updateJobStores(workspaceRoot, jobId, ({ stateJob, storedJob }) => {
    if (!stateJob || !storedJob) {
      return { value: { ...buildMissingWorkerOutcome(stateJob, storedJob), proceed: false } };
    }

    const turnLifecycle = {
      state: WORKER_TURN_STATES.SUPPRESSED,
      workerPid,
      threadId: threadId ?? stateJob.threadId ?? storedJob.threadId ?? null,
      turnId: null,
      updatedAt: preparedAt
    };
    if (isTerminalJobRecord(stateJob, storedJob)) {
      return buildTerminalWorkerOutcome(stateJob, storedJob, { turnLifecycle });
    }

    if (!isClaimableByWorker(stateJob, workerPid) || !isClaimableByWorker(storedJob, workerPid)) {
      const status = stateJob.status === "running" || storedJob.status === "running" ? "running" : "queued";
      return {
        value: {
          claimed: false,
          proceed: false,
          status,
          job: { ...storedJob, ...stateJob, status }
        }
      };
    }

    const preparedJob = {
      ...storedJob,
      ...stateJob,
      ...(threadId ? { threadId } : {}),
      turnLifecycle: {
        ...turnLifecycle,
        state: WORKER_TURN_STATES.STARTING
      },
      updatedAt: preparedAt
    };
    return {
      stateJob: preparedJob,
      storedJob: preparedJob,
      value: {
        claimed: true,
        proceed: true,
        status: preparedJob.status,
        job: preparedJob
      }
    };
  });
  return transaction.value;
}

function recordClaimedWorkerTurnStarted(workspaceRoot, jobId, workerPid, { threadId, turnId }) {
  const startedAt = new Date().toISOString();
  // Persist identifiers to both stores before the runner accepts later turn
  // events. A terminal record is preserved verbatim apart from the identifiers
  // and INTERRUPTING marker needed by /cancel's confirmation handshake.
  const transaction = updateJobStores(workspaceRoot, jobId, ({ stateJob, storedJob }) => {
    if (!stateJob || !storedJob) {
      return { value: { ...buildMissingWorkerOutcome(stateJob, storedJob), proceed: false } };
    }

    const turnLifecycle = {
      ...(storedJob.turnLifecycle ?? {}),
      ...(stateJob.turnLifecycle ?? {}),
      state: WORKER_TURN_STATES.INTERRUPTING,
      workerPid,
      threadId,
      turnId,
      updatedAt: startedAt
    };
    if (isTerminalJobRecord(stateJob, storedJob)) {
      return buildTerminalWorkerOutcome(stateJob, storedJob, {
        jobPatch: { threadId, turnId },
        turnLifecycle
      });
    }

    if (!isClaimableByWorker(stateJob, workerPid) || !isClaimableByWorker(storedJob, workerPid)) {
      const status = stateJob.status === "running" || storedJob.status === "running" ? "running" : "queued";
      return {
        value: {
          claimed: false,
          proceed: false,
          status,
          job: { ...storedJob, ...stateJob, status }
        }
      };
    }

    const startedJob = {
      ...storedJob,
      ...stateJob,
      threadId,
      turnId,
      turnLifecycle: {
        ...turnLifecycle,
        state: WORKER_TURN_STATES.STARTED
      },
      updatedAt: startedAt
    };
    return {
      stateJob: startedJob,
      storedJob: startedJob,
      value: {
        claimed: true,
        proceed: true,
        status: startedJob.status,
        job: startedJob
      }
    };
  });
  return transaction.value;
}

function recordClaimedWorkerTurnInterrupt(workspaceRoot, jobId, workerPid, result) {
  const interruptedAt = new Date().toISOString();
  const transaction = updateJobStores(workspaceRoot, jobId, ({ stateJob, storedJob }) => {
    if (!stateJob || !storedJob) {
      return { value: buildMissingWorkerOutcome(stateJob, storedJob) };
    }

    const currentJob = { ...storedJob, ...stateJob };
    const lifecycleState = result.confirmed
      ? result.interrupted
        ? WORKER_TURN_STATES.INTERRUPTED
        : WORKER_TURN_STATES.STOPPED
      : WORKER_TURN_STATES.INTERRUPT_FAILED;
    const nextJob = {
      ...currentJob,
      turnLifecycle: {
        ...(storedJob.turnLifecycle ?? {}),
        ...(stateJob.turnLifecycle ?? {}),
        state: lifecycleState,
        workerPid,
        interrupted: Boolean(result.interrupted),
        confirmed: Boolean(result.confirmed),
        detail: result.detail ?? null,
        updatedAt: interruptedAt
      },
      updatedAt: currentJob.status === "cancelled" ? currentJob.updatedAt : interruptedAt
    };
    return {
      stateJob: nextJob,
      storedJob: nextJob,
      value: {
        cancelled: nextJob.status === "cancelled",
        turnLifecycle: nextJob.turnLifecycle
      }
    };
  });
  return transaction.value;
}

function recordClaimedWorkerTurnCompleted(workspaceRoot, jobId, workerPid, details) {
  const completedAt = new Date().toISOString();
  const transaction = updateJobStores(workspaceRoot, jobId, ({ stateJob, storedJob }) => {
    if (!stateJob || !storedJob) {
      return { value: { cancelled: false, ...buildMissingWorkerOutcome(stateJob, storedJob) } };
    }

    const cancellationWon = stateJob.status === "cancelled" || storedJob.status === "cancelled";
    const cancelledSource = stateJob.status === "cancelled" ? stateJob : storedJob;
    const currentJob = cancellationWon
      ? { ...storedJob, ...stateJob, ...cancelledSource, status: "cancelled", pid: null }
      : { ...storedJob, ...stateJob };
    if (!cancellationWon) {
      return { value: { cancelled: false, job: currentJob } };
    }

    const interrupted = details.status === "interrupted";
    const nextJob = {
      ...currentJob,
      threadId: details.threadId ?? currentJob.threadId ?? null,
      turnId: details.turnId ?? currentJob.turnId ?? null,
      turnLifecycle: {
        ...(storedJob.turnLifecycle ?? {}),
        ...(stateJob.turnLifecycle ?? {}),
        state: interrupted ? WORKER_TURN_STATES.INTERRUPTED : WORKER_TURN_STATES.STOPPED,
        workerPid,
        interrupted,
        confirmed: true,
        detail: `Turn completed with status ${details.status}.`,
        updatedAt: completedAt
      }
    };
    return {
      stateJob: nextJob,
      storedJob: nextJob,
      value: {
        cancelled: true,
        turnLifecycle: nextJob.turnLifecycle
      }
    };
  });
  return transaction.value;
}

function recordClaimedWorkerTurnStartFailure(workspaceRoot, jobId, workerPid, error) {
  const failedAt = new Date().toISOString();
  const detail = error instanceof Error ? error.message : String(error);
  // A JSON-RPC rejection proves the server declined the request. Transport
  // failures are ambiguous because the daemon may have accepted the request
  // before the connection failed, so cancellation must not call those safe.
  const lifecycleState = Number.isInteger(error?.rpcCode)
    ? WORKER_TURN_STATES.START_REJECTED
    : WORKER_TURN_STATES.START_UNKNOWN;
  const transaction = updateJobStores(workspaceRoot, jobId, ({ stateJob, storedJob }) => {
    if (!stateJob || !storedJob) {
      return { value: buildMissingWorkerOutcome(stateJob, storedJob) };
    }

    const currentJob = { ...storedJob, ...stateJob };
    const nextJob = {
      ...currentJob,
      turnLifecycle: {
        ...(storedJob.turnLifecycle ?? {}),
        ...(stateJob.turnLifecycle ?? {}),
        state: lifecycleState,
        workerPid,
        detail,
        updatedAt: failedAt
      },
      updatedAt: currentJob.status === "cancelled" ? currentJob.updatedAt : failedAt
    };
    return {
      stateJob: nextJob,
      storedJob: nextJob,
      value: nextJob.turnLifecycle
    };
  });
  return transaction.value;
}

function createClaimedWorkerTurnLifecycle(workspaceRoot, jobId, workerPid) {
  return {
    beforeTurnStart(details) {
      return prepareClaimedWorkerTurn(workspaceRoot, jobId, workerPid, details);
    },
    onTurnStarted(details) {
      return recordClaimedWorkerTurnStarted(workspaceRoot, jobId, workerPid, details);
    },
    onTurnInterrupt(result) {
      return recordClaimedWorkerTurnInterrupt(workspaceRoot, jobId, workerPid, result);
    },
    onTurnCompleted(details) {
      return recordClaimedWorkerTurnCompleted(workspaceRoot, jobId, workerPid, details);
    },
    onTurnStartFailed(error) {
      return recordClaimedWorkerTurnStartFailure(workspaceRoot, jobId, workerPid, error);
    }
  };
}

export async function runClaimedTaskWorker(workspaceRoot, jobId, workerPid, runner, options = {}) {
  const outcome = claimTaskWorker(workspaceRoot, jobId, workerPid, options);
  if (!outcome.claimed) {
    options.onSkip?.(outcome);
    return outcome;
  }

  await options.beforeRunner?.(outcome);
  // Claiming and entering the runner are separate scheduling points. Re-run the
  // same locked claim transaction so cancellation in that gap remains terminal.
  const revalidated = claimTaskWorker(workspaceRoot, jobId, workerPid, {
    beforeCommit: options.beforeRunnerCommit
  });
  if (!revalidated.claimed) {
    options.onSkip?.(revalidated);
    return revalidated;
  }

  const turnLifecycle = createClaimedWorkerTurnLifecycle(workspaceRoot, jobId, workerPid);
  const runnerResult = await runner(revalidated.job, turnLifecycle);
  return { ...revalidated, runnerResult };
}

export function commitSpawnedTaskWorker(workspaceRoot, jobId, childPid, options = {}) {
  const transaction = updateJobStores(
    workspaceRoot,
    jobId,
    ({ stateJob, storedJob }) => {
      if (!stateJob) {
        return {
          value: {
            shouldKillWorker: true,
            launchStatus: "cancelled",
            job: storedJob
          }
        };
      }

      if (isTerminalJobRecord(stateJob, storedJob)) {
        const launchStatus = resolveLaunchStatus(stateJob, storedJob, "cancelled");
        // A process can exit between the two atomic file replacements. Repair
        // the non-terminal side from whichever store already won, while the
        // lock prevents a concurrent launcher or cancellation from intervening.
        const terminalJob = buildTerminalJob(stateJob, storedJob, launchStatus);
        return {
          stateJob: terminalJob,
          storedJob: terminalJob,
          value: {
            shouldKillWorker: true,
            launchStatus,
            job: terminalJob
          }
        };
      }

      const updatedAt = new Date().toISOString();
      const updatedJob = {
        ...(storedJob ?? {}),
        ...stateJob,
        pid: childPid,
        updatedAt
      };
      return {
        stateJob: updatedJob,
        storedJob: updatedJob,
        value: {
          shouldKillWorker: false,
          launchStatus: updatedJob.status,
          job: updatedJob
        }
      };
    },
    { beforeCommit: options.beforeCommit }
  );

  const outcome = transaction.value;
  if (outcome.shouldKillWorker) {
    (options.killProcess ?? terminateProcessTree)(childPid);
  }
  return outcome;
}
