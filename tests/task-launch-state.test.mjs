import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  saveState,
  updateJobStores,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import * as taskLaunchState from "../plugins/codex/scripts/lib/task-launch-state.mjs";

const { commitSpawnedTaskWorker } = taskLaunchState;

function seedTaskJob(workspace, jobId, overrides = {}) {
  const job = {
    id: jobId,
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    status: "queued",
    phase: "queued",
    pid: null,
    request: { prompt: "Fix the failing test." },
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    ...overrides
  };
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [job]
  });
  writeJobFile(workspace, jobId, job);
  return job;
}

function cancelTaskJob(workspace, jobId) {
  return updateJobStores(workspace, jobId, ({ stateJob, storedJob }) => {
    const cancelledAt = "2026-07-16T12:00:01.000Z";
    const cancelledJob = {
      ...storedJob,
      ...stateJob,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt: cancelledAt,
      updatedAt: cancelledAt,
      errorMessage: "Cancelled by deterministic interleaving test."
    };
    return {
      stateJob: cancelledJob,
      storedJob: { ...cancelledJob, cancelledAt }
    };
  });
}

test("PID commit preserves concurrent cancellation in both stores and kills the spawned worker", () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-during-pid-commit";
  const childPid = 424242;
  const queuedJob = {
    id: jobId,
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    status: "queued",
    phase: "queued",
    pid: null,
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z"
  };
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [queuedJob]
  });
  writeJobFile(workspace, jobId, queuedJob);

  const killedPids = [];
  let injected = false;
  const outcome = commitSpawnedTaskWorker(workspace, jobId, childPid, {
    beforeCommit() {
      assert.equal(injected, false, "pre-commit hook must run exactly once");
      injected = true;
      updateJobStores(workspace, jobId, ({ stateJob, storedJob }) => {
        const cancelledAt = "2026-07-16T12:00:01.000Z";
        const cancelledJob = {
          ...storedJob,
          ...stateJob,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          completedAt: cancelledAt,
          updatedAt: cancelledAt,
          errorMessage: "Cancelled by deterministic interleaving test."
        };
        return {
          stateJob: cancelledJob,
          storedJob: { ...cancelledJob, cancelledAt }
        };
      });
    },
    killProcess(pid) {
      killedPids.push(pid);
      return { attempted: true, delivered: true, method: "test" };
    }
  });

  assert.equal(outcome.shouldKillWorker, true);
  assert.equal(outcome.launchStatus, "cancelled");
  assert.deepEqual(killedPids, [childPid]);

  const stateJob = listJobs(workspace).find((job) => job.id === jobId);
  const storedJob = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(stateJob.status, "cancelled");
  assert.equal(stateJob.pid, null);
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.pid, null);

  // A worker that was already running can still reach its persistence code
  // after cancellation. Both lower-level write paths must preserve cancellation.
  writeJobFile(workspace, jobId, {
    ...storedJob,
    status: "completed",
    phase: "done",
    pid: null
  });
  upsertJob(workspace, {
    id: jobId,
    status: "completed",
    phase: "done",
    pid: null
  });

  assert.equal(listJobs(workspace).find((job) => job.id === jobId).status, "cancelled");
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "cancelled");
});

test("PID commit repairs a cancellation persisted to only one job store", () => {
  const workspace = makeTempDir();
  const jobId = "task-partial-cancellation";
  const queuedJob = {
    id: jobId,
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    status: "queued",
    phase: "queued",
    pid: null,
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z"
  };
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [queuedJob]
  });
  writeJobFile(workspace, jobId, {
    ...queuedJob,
    status: "cancelled",
    phase: "cancelled",
    completedAt: "2026-07-16T12:00:01.000Z",
    updatedAt: "2026-07-16T12:00:01.000Z"
  });

  const killedPids = [];
  const outcome = commitSpawnedTaskWorker(workspace, jobId, 424243, {
    killProcess(pid) {
      killedPids.push(pid);
    }
  });

  assert.equal(outcome.shouldKillWorker, true);
  assert.deepEqual(killedPids, [424243]);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId).status, "cancelled");
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "cancelled");
});

test("task worker claims an active job and runs before launcher PID persistence", async () => {
  const workspace = makeTempDir();
  const jobId = "task-worker-claims-first";
  const workerPid = 424244;
  seedTaskJob(workspace, jobId);

  let runnerCalls = 0;
  const claim = await taskLaunchState.runClaimedTaskWorker(
    workspace,
    jobId,
    workerPid,
    async (job) => {
      runnerCalls += 1;
      assert.equal(job.status, "running");
      assert.equal(job.pid, workerPid);
      return "runner-result";
    }
  );

  assert.equal(claim.claimed, true);
  assert.equal(claim.status, "running");
  assert.equal(claim.runnerResult, "runner-result");
  assert.equal(runnerCalls, 1);

  const killedPids = [];
  const launch = commitSpawnedTaskWorker(workspace, jobId, workerPid, {
    killProcess(pid) {
      killedPids.push(pid);
    }
  });
  assert.equal(launch.shouldKillWorker, false);
  assert.equal(launch.launchStatus, "running");
  assert.deepEqual(killedPids, []);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId).status, "running");
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "running");
});

test("task worker claims an active job and runs after launcher PID persistence", async () => {
  const workspace = makeTempDir();
  const jobId = "task-launcher-persists-first";
  const workerPid = 424245;
  seedTaskJob(workspace, jobId);

  const launch = commitSpawnedTaskWorker(workspace, jobId, workerPid);
  assert.equal(launch.shouldKillWorker, false);
  assert.equal(launch.launchStatus, "queued");

  let runnerCalls = 0;
  const claim = await taskLaunchState.runClaimedTaskWorker(
    workspace,
    jobId,
    workerPid,
    async () => {
      runnerCalls += 1;
    }
  );

  assert.equal(claim.claimed, true);
  assert.equal(claim.status, "running");
  assert.equal(runnerCalls, 1);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId).pid, workerPid);
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).pid, workerPid);
});

test("task worker skips a cancelled job without entering the runner", async () => {
  const workspace = makeTempDir();
  const jobId = "task-worker-sees-cancelled";
  const cancelledJob = seedTaskJob(workspace, jobId, {
    status: "cancelled",
    phase: "cancelled",
    completedAt: "2026-07-16T12:00:01.000Z",
    cancelledAt: "2026-07-16T12:00:01.000Z",
    errorMessage: "Cancelled by user."
  });

  let runnerCalls = 0;
  const skippedStatuses = [];
  const claim = await taskLaunchState.runClaimedTaskWorker(
    workspace,
    jobId,
    424246,
    async () => {
      runnerCalls += 1;
    },
    {
      onSkip(outcome) {
        skippedStatuses.push(outcome.status);
      }
    }
  );

  assert.equal(claim.claimed, false);
  assert.equal(claim.status, "cancelled");
  assert.equal(runnerCalls, 0);
  assert.deepEqual(skippedStatuses, ["cancelled"]);
  assert.deepEqual(listJobs(workspace).find((job) => job.id === jobId), cancelledJob);
  assert.deepEqual(readJobFile(resolveJobFile(workspace, jobId)), cancelledJob);
});

test("cancellation between worker read and claim skips the runner before launcher kill", async () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-during-worker-claim";
  const workerPid = 424247;
  seedTaskJob(workspace, jobId);

  // This is the launcher's pre-spawn read from the reviewed interleaving.
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "queued");

  let cancellationInjected = false;
  let runnerCalls = 0;
  const claim = await taskLaunchState.runClaimedTaskWorker(
    workspace,
    jobId,
    workerPid,
    async () => {
      runnerCalls += 1;
    },
    {
      beforeCommit() {
        assert.equal(cancellationInjected, false);
        cancellationInjected = true;
        cancelTaskJob(workspace, jobId);
      }
    }
  );

  assert.equal(claim.claimed, false);
  assert.equal(claim.status, "cancelled");
  assert.equal(runnerCalls, 0);

  const killedPids = [];
  const launch = commitSpawnedTaskWorker(workspace, jobId, workerPid, {
    killProcess(pid) {
      killedPids.push(pid);
    }
  });
  assert.equal(launch.shouldKillWorker, true);
  assert.equal(launch.launchStatus, "cancelled");
  assert.deepEqual(killedPids, [workerPid]);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId).status, "cancelled");
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "cancelled");
});
