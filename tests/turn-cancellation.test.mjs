import test from "node:test";
import assert from "node:assert/strict";

import { captureAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  saveState,
  updateJobStores,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { runClaimedTaskWorker } from "../plugins/codex/scripts/lib/task-launch-state.mjs";
import { makeTempDir } from "./helpers.mjs";

function seedTaskJob(workspace, jobId) {
  const job = {
    id: jobId,
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    status: "queued",
    phase: "queued",
    pid: null,
    request: { prompt: "Fix the failing test." },
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z"
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
    const cancelledAt = "2026-07-17T10:00:01.000Z";
    const cancelledJob = {
      ...storedJob,
      ...stateJob,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt: cancelledAt,
      cancelledAt,
      updatedAt: cancelledAt,
      errorMessage: "Cancelled by deterministic turn interleaving test."
    };
    return {
      stateJob: cancelledJob,
      storedJob: cancelledJob
    };
  });
}

function buildTurn(turnId, status = "inProgress") {
  return { id: turnId, status, items: [], error: null };
}

class FakeTurnClient {
  constructor() {
    this.notificationHandler = null;
    this.requests = [];
    this.transport = "test";
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  emit(message) {
    this.notificationHandler?.(message);
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "turn/interrupt") {
      queueMicrotask(() => {
        this.emit({
          method: "turn/completed",
          params: { threadId: params.threadId, turn: buildTurn(params.turnId, "interrupted") }
        });
      });
    }
    return {};
  }
}

test("turn preflight suppresses app-server start when cancellation lands after runner entry", async () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-before-turn-start";
  const workerPid = 424249;
  seedTaskJob(workspace, jobId);

  let startRequests = 0;
  const outcome = await runClaimedTaskWorker(
    workspace,
    jobId,
    workerPid,
    async (_job, turnLifecycle) => {
      cancelTaskJob(workspace, jobId);
      const client = new FakeTurnClient();
      const turn = await captureAppServerTurn(
        client,
        "thr_preflight",
        async () => {
          startRequests += 1;
          return { turn: buildTurn("turn_must_not_start") };
        },
        { turnLifecycle }
      );
      assert.equal(turn.cancelled, true);
      assert.equal(turn.cancellationStage, "before-start");
    }
  );

  assert.equal(outcome.claimed, true);
  assert.equal(startRequests, 0);
  const stateJob = listJobs(workspace).find((job) => job.id === jobId);
  const storedJob = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(stateJob.status, "cancelled");
  assert.equal(storedJob.status, "cancelled");
  assert.equal(stateJob.turnLifecycle.state, "suppressed");
  assert.equal(storedJob.turnLifecycle.state, "suppressed");
});

test("turn-start guard persists identifiers and interrupts when cancellation wins after start", async () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-after-turn-start";
  const workerPid = 424250;
  seedTaskJob(workspace, jobId);

  const progress = [];
  const client = new FakeTurnClient();
  const outcome = await runClaimedTaskWorker(
    workspace,
    jobId,
    workerPid,
    async (_job, turnLifecycle) => {
      const turn = await captureAppServerTurn(
        client,
        "thr_started",
        async () => {
          const prepared = readJobFile(resolveJobFile(workspace, jobId));
          assert.equal(prepared.turnLifecycle.state, "starting");
          cancelTaskJob(workspace, jobId);
          client.emit({
            method: "turn/started",
            params: { threadId: "thr_started", turn: buildTurn("turn_started") }
          });
          client.emit({
            method: "item/completed",
            params: {
              threadId: "thr_started",
              turnId: "turn_started",
              item: {
                type: "fileChange",
                id: "write_after_cancel",
                status: "completed",
                changes: [{ path: "must-not-land.txt", kind: "add" }]
              }
            }
          });
          return { turn: buildTurn("turn_started") };
        },
        {
          turnLifecycle,
          onProgress(event) {
            progress.push(event);
          }
        }
      );

      assert.equal(turn.cancelled, true);
      assert.equal(turn.cancellationStage, "after-start");
      assert.deepEqual(turn.fileChanges, []);
    }
  );

  assert.equal(outcome.claimed, true);
  assert.deepEqual(client.requests, [
    {
      method: "turn/interrupt",
      params: { threadId: "thr_started", turnId: "turn_started" }
    }
  ]);
  assert.ok(
    progress.some((event) => String(event?.message ?? event).includes("cancelled job")),
    "expected the self-interrupt path to be observable through progress"
  );

  const stateJob = listJobs(workspace).find((job) => job.id === jobId);
  const storedJob = readJobFile(resolveJobFile(workspace, jobId));
  for (const job of [stateJob, storedJob]) {
    assert.equal(job.status, "cancelled");
    assert.equal(job.threadId, "thr_started");
    assert.equal(job.turnId, "turn_started");
    assert.equal(job.turnLifecycle.state, "interrupted");
  }
});

test("normal turn capture handles response and start notification without duplicate progress", async () => {
  const client = new FakeTurnClient();
  const progress = [];
  let reportStarted;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });

  const capture = captureAppServerTurn(
    client,
    "thr_normal",
    async () => ({ turn: buildTurn("turn_normal") }),
    {
      onProgress(event) {
        progress.push(event);
        if (String(event?.message ?? event).startsWith("Turn started")) {
          reportStarted();
        }
      }
    }
  );

  await started;
  client.emit({
    method: "turn/started",
    params: { threadId: "thr_normal", turn: buildTurn("turn_normal") }
  });
  client.emit({
    method: "turn/completed",
    params: { threadId: "thr_normal", turn: buildTurn("turn_normal", "completed") }
  });
  const turn = await capture;

  assert.equal(turn.cancelled, false);
  assert.equal(turn.finalTurn.status, "completed");
  assert.equal(
    progress.filter((event) => String(event?.message ?? event).startsWith("Turn started")).length,
    1
  );
});
