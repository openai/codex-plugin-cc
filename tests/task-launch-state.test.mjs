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
import { commitSpawnedTaskWorker } from "../plugins/codex/scripts/lib/task-launch-state.mjs";

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
