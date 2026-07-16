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
        const terminalSource = stateJob.status === launchStatus ? stateJob : storedJob;
        // A process can exit between the two atomic file replacements. Repair
        // the non-terminal side from whichever store already won, while the
        // lock prevents a concurrent launcher or cancellation from intervening.
        const terminalJob = {
          ...stateJob,
          ...(storedJob ?? {}),
          ...(terminalSource ?? {}),
          status: launchStatus,
          pid: null
        };
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
