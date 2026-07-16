import { terminateProcessTree } from "./process.mjs";
import { updateJobStores } from "./state.mjs";

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

function claimTaskWorker(workspaceRoot, jobId, workerPid, options = {}) {
  const transaction = updateJobStores(
    workspaceRoot,
    jobId,
    ({ stateJob, storedJob }) => {
      if (!stateJob || !storedJob) {
        return {
          value: {
            claimed: false,
            status: "missing",
            job: storedJob ?? stateJob
          }
        };
      }

      if (isTerminalJobRecord(stateJob, storedJob)) {
        const status = resolveLaunchStatus(stateJob, storedJob, "cancelled");
        const terminalJob = buildTerminalJob(stateJob, storedJob, status);
        return {
          stateJob: terminalJob,
          storedJob: terminalJob,
          value: {
            claimed: false,
            status,
            job: terminalJob
          }
        };
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

export async function runClaimedTaskWorker(workspaceRoot, jobId, workerPid, runner, options = {}) {
  const outcome = claimTaskWorker(workspaceRoot, jobId, workerPid, options);
  if (!outcome.claimed) {
    options.onSkip?.(outcome);
    return outcome;
  }

  const runnerResult = await runner(outcome.job);
  return { ...outcome, runnerResult };
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
