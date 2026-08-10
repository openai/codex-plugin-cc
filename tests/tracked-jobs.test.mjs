import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { claimTerminalStatus, createJobProgressUpdater, reassertTerminalClaim, runTrackedJob, waitForTurnIdentity } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobClaimFile, resolveJobFile, resolveStateFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

// A pid that cannot belong to a live process on any supported platform.
const DEAD_PID = 999999999;

function successExecution() {
  return {
    exitStatus: 0,
    payload: { ok: true },
    rendered: "done",
    summary: "done",
    threadId: "thr_1",
    turnId: "turn_1"
  };
}

test("runTrackedJob does not resurrect a job cancelled before the worker started", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-cancelled-early", workspaceRoot, title: "Codex Task" };
  const cancelledRecord = { ...job, status: "cancelled", phase: "cancelled", pid: null };
  writeJobFile(workspaceRoot, job.id, cancelledRecord);
  upsertJob(workspaceRoot, cancelledRecord);

  let runnerCalled = false;
  await assert.rejects(
    runTrackedJob(job, async () => {
      runnerCalled = true;
      return successExecution();
    }),
    /cancelled before it started/
  );

  assert.equal(runnerCalled, false, "runner must not execute for a cancelled job");
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, "cancelled");
});

test("runTrackedJob keeps a cancellation recorded while the turn was finishing", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-cancelled-mid-turn", workspaceRoot, title: "Codex Task" };

  const execution = await runTrackedJob(job, async () => {
    // Simulate `cancel` landing while the worker awaits the turn outcome:
    // it persists the terminal cancelled record before interrupting.
    const cancelledRecord = { ...job, status: "cancelled", phase: "cancelled", pid: null };
    writeJobFile(workspaceRoot, job.id, cancelledRecord);
    upsertJob(workspaceRoot, cancelledRecord);
    return successExecution();
  });

  assert.equal(execution.exitStatus, 0, "the worker still returns its execution result");
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, "cancelled", "completed must not overwrite cancelled");

  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  const indexed = state.jobs.find((candidate) => candidate.id === job.id);
  assert.equal(indexed.status, "cancelled");
});

test("runTrackedJob keeps a cancellation recorded when the worker fails afterwards", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-cancelled-then-error", workspaceRoot, title: "Codex Task" };

  await assert.rejects(
    runTrackedJob(job, async () => {
      const cancelledRecord = { ...job, status: "cancelled", phase: "cancelled", pid: null };
      writeJobFile(workspaceRoot, job.id, cancelledRecord);
      upsertJob(workspaceRoot, cancelledRecord);
      throw new Error("transport died");
    }),
    /transport died/
  );

  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, "cancelled", "failed must not overwrite cancelled");
});

test("runTrackedJob refuses to start over an orphaned terminal claim and repairs the record", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-orphaned-claim", workspaceRoot, title: "Codex Task" };
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: 4242 };
  writeJobFile(workspaceRoot, job.id, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  // A cancel claimed the terminal status but died before writing its record.
  assert.equal(claimTerminalStatus(workspaceRoot, job.id), true);

  let runnerCalled = false;
  await assert.rejects(
    runTrackedJob(job, async () => {
      runnerCalled = true;
      return successExecution();
    }),
    /cancelled before it started/
  );

  assert.equal(runnerCalled, false, "runner must not execute under a taken claim");
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, "cancelled", "the orphaned claim must be repaired to a terminal record");
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === job.id)?.status, "cancelled");
});

test("reassertTerminalClaim synchronizes state.json when the job file is already terminal", () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-index-reverted";
  // The interleaving: worker writes its running job file, cancel claims and
  // writes cancelled to both stores, then the worker's running upsert lands
  // last and reverts state.json. The job file stays cancelled.
  writeJobFile(workspaceRoot, jobId, {
    id: jobId,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: "2026-03-18T15:31:00.000Z",
    errorMessage: "Cancelled by user."
  });
  upsertJob(workspaceRoot, { id: jobId, status: "running", phase: "starting", pid: 4242 });
  assert.equal(claimTerminalStatus(workspaceRoot, jobId), true);

  reassertTerminalClaim(workspaceRoot, jobId);

  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  const indexed = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(indexed.status, "cancelled", "the index must be resynchronized to the terminal job file");
  assert.equal(indexed.pid, null);
  assert.equal(indexed.errorMessage, "Cancelled by user.");
});

test("waitForTurnIdentity reads persisted ids even when the worker is already dead", async () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-ids-then-death";
  // The worker persisted the turn identity and then exited/crashed; a
  // caller whose snapshot predates the persist must still find the ids.
  writeJobFile(workspaceRoot, jobId, { id: jobId, status: "running", threadId: "thr_5", turnId: "turn_5", pid: DEAD_PID });
  upsertJob(workspaceRoot, { id: jobId, status: "running" });

  const identity = await waitForTurnIdentity(workspaceRoot, jobId, {
    deadline: Date.now() + 1000,
    workerPid: DEAD_PID
  });
  assert.equal(identity.threadId, "thr_5");
  assert.equal(identity.turnId, "turn_5");
});

test("waitForTurnIdentity keeps polling when the pid is not yet known and picks up late ids", async () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-late-spawn";
  // Record-before-spawn: the snapshot the canceller holds has pid null. The
  // worker publishes pid and turn identity a moment later; the wait must
  // not end after one read just because the initial pid was unknown.
  writeJobFile(workspaceRoot, jobId, { id: jobId, status: "queued", pid: null });
  upsertJob(workspaceRoot, { id: jobId, status: "queued", pid: null });

  setTimeout(() => {
    const record = { id: jobId, status: "running", pid: process.pid, threadId: "thr_9", turnId: "turn_9" };
    writeJobFile(workspaceRoot, jobId, record);
    upsertJob(workspaceRoot, record);
  }, 300);

  const identity = await waitForTurnIdentity(workspaceRoot, jobId, {
    deadline: Date.now() + 2000,
    workerPid: null
  });
  assert.equal(identity.threadId, "thr_9");
  assert.equal(identity.turnId, "turn_9");
  assert.equal(identity.workerPid, process.pid, "the refreshed worker pid must be returned for termination");
});

test("claimTerminalStatus grants the terminal status to the first claimant only", () => {
  const workspaceRoot = makeTempDir();
  assert.equal(claimTerminalStatus(workspaceRoot, "task-claim"), true);
  assert.equal(claimTerminalStatus(workspaceRoot, "task-claim"), false);
});

test("reassertTerminalClaim repairs a worker-owned orphan claim to failed, not cancelled", () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-worker-died";
  const runningRecord = { id: jobId, status: "running", phase: "working", pid: DEAD_PID };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);
  // The worker claimed the terminal status for its own completed/failed
  // write, then died before the write landed: the job ran, so repairing it
  // as a deliberate cancellation would misreport the outcome.
  fs.writeFileSync(resolveJobClaimFile(workspaceRoot, jobId), `${DEAD_PID} worker\n`, "utf8");

  reassertTerminalClaim(workspaceRoot, jobId);

  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /worker died before recording/);
  // The repair cause must reach the canonical index too.
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  const indexed = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(indexed.status, "failed");
  assert.match(indexed.errorMessage ?? "", /worker died before recording/);
});

test("reassertTerminalClaim does not preempt a live worker finalizing its own outcome", () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-live-finalizer";
  const runningRecord = { id: jobId, status: "running", phase: "working", pid: process.pid };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);
  // The worker (this test process) claimed for its own terminal write and
  // is still alive: a repair must not race its completed/failed record.
  assert.equal(claimTerminalStatus(workspaceRoot, jobId, "worker"), true);

  reassertTerminalClaim(workspaceRoot, jobId);

  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.status, "running", "a live finalizer must be left to write its own outcome");
});

test("runTrackedJob preserves a cancellation that claimed terminal status between check and write", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-cancel-claim-race", workspaceRoot, title: "Codex Task" };

  const execution = await runTrackedJob(job, async () => {
    // Simulate cancel winning the terminal claim while its job-file write has
    // not landed yet (or failed): the job file still says "running", so the
    // stored-record check alone would let the worker record "completed".
    assert.equal(claimTerminalStatus(workspaceRoot, job.id), true);
    upsertJob(workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null });
    return successExecution();
  });

  assert.equal(execution.exitStatus, 0, "the worker still returns its execution result");
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.notEqual(stored.status, "completed", "the worker must not claim the terminal status");

  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  const indexed = state.jobs.find((candidate) => candidate.id === job.id);
  assert.equal(indexed.status, "cancelled");
});

test("runTrackedJob repairs the records when a bare claim has no terminal write behind it", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-crashed-cancel", workspaceRoot, title: "Codex Task" };

  await runTrackedJob(job, async () => {
    // The cancel claimed the terminal status and then crashed before writing
    // either record: nothing but the claim file exists.
    assert.equal(claimTerminalStatus(workspaceRoot, job.id), true);
    return successExecution();
  });

  // Backing off without repair would leave running/stale-pid records forever.
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, "cancelled");
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === job.id)?.status, "cancelled");
});

test("progress updates stop once the job's terminal status has been claimed", () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-claimed-progress";
  const runningRecord = { id: jobId, status: "running", phase: "working", pid: 1234 };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);
  // A cancel claims the terminal status before writing its record; progress
  // events arriving in that window must not touch the job.
  assert.equal(claimTerminalStatus(workspaceRoot, jobId), true);

  const update = createJobProgressUpdater(workspaceRoot, jobId);
  update({ message: "still streaming", phase: "finalizing" });

  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.phase, "working", "a claimed job must not receive further progress writes");
});

test("progress updates persist the turn identity even after the terminal claim is taken", () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-late-identity";
  const cancelledRecord = { id: jobId, status: "cancelled", phase: "cancelled", pid: null };
  writeJobFile(workspaceRoot, jobId, cancelledRecord);
  upsertJob(workspaceRoot, cancelledRecord);
  assert.equal(claimTerminalStatus(workspaceRoot, jobId), true);

  // Cancellation needs threadId/turnId to interrupt the server-side turn,
  // and the worker's updater may hold the only copy: identity fields must
  // land, while the live phase must not revive the terminal record.
  const update = createJobProgressUpdater(workspaceRoot, jobId);
  update({ message: "turn accepted", phase: "starting", threadId: "thr_7", turnId: "turn_7" });

  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.threadId, "thr_7");
  assert.equal(stored.turnId, "turn_7");
  assert.equal(stored.phase, "cancelled", "the live phase must not revive the terminal record");
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
  const indexed = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(indexed.turnId, "turn_7");
  assert.equal(indexed.status, "cancelled");
});

test("progress updates do not touch a job that already reached a terminal status", () => {
  const workspaceRoot = makeTempDir();
  const jobId = "task-cancelled-progress";
  const cancelledRecord = {
    id: jobId,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    updatedAt: "2026-03-18T15:30:00.000Z"
  };
  writeJobFile(workspaceRoot, jobId, cancelledRecord);
  upsertJob(workspaceRoot, cancelledRecord);
  const stateBefore = fs.readFileSync(resolveStateFile(workspaceRoot), "utf8");

  const update = createJobProgressUpdater(workspaceRoot, jobId);
  // Phase-only event: turn identity fields are the one thing that may still
  // land on a terminal record (covered by a separate test).
  update({ message: "interrupt landed", phase: "finalizing" });

  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.phase, "cancelled", "a terminal record must not regain a live phase");
  assert.equal(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"), stateBefore, "state.json must stay untouched");
});
