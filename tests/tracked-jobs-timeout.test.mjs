import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";

test("runTrackedJob enforces a hard timeout when the runner hangs", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-hang-1",
    kind: "task",
    kindLabel: "rescue",
    title: "Hung Task",
    workspaceRoot: workspace,
    jobClass: "task",
    summary: "test job",
    write: false,
    createdAt: new Date().toISOString()
  };

  // Hold the event loop open with a ref'd timer for the duration of this test.
  // The production timeout uses unref so it does not keep the process alive
  // when paired with a real long-running runner; in the test the hanging
  // runner has nothing keeping the loop alive on its own.
  const keepAlive = setInterval(() => {}, 1_000);

  let resolveRunner;
  const hangingRunner = () =>
    new Promise((resolve) => {
      resolveRunner = resolve;
    });

  try {
    await assert.rejects(
      () => runTrackedJob(job, hangingRunner, { timeoutMs: 50 }),
      /exceeded the .+ hard timeout/
    );

    const jobs = listJobs(workspace);
    const stored = jobs.find((entry) => entry.id === "task-hang-1");
    assert.ok(stored, "expected the hung job to be persisted");
    assert.equal(stored.status, "failed");
    assert.equal(stored.phase, "failed");
    assert.equal(stored.pid, null);
    assert.match(stored.errorMessage ?? "", /hard timeout/);
  } finally {
    // Drain the leaked runner promise and free the event loop.
    resolveRunner?.({ exitStatus: 1, payload: null, rendered: "", summary: "drained" });
    clearInterval(keepAlive);
  }
});

test("runTrackedJob still records a normal completion when the runner settles in time", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-ok-1",
    kind: "task",
    kindLabel: "rescue",
    title: "Quick Task",
    workspaceRoot: workspace,
    jobClass: "task",
    summary: "test job",
    write: false,
    createdAt: new Date().toISOString()
  };

  const result = await runTrackedJob(
    job,
    () =>
      Promise.resolve({
        exitStatus: 0,
        threadId: "thread-1",
        turnId: "turn-1",
        payload: { ok: true },
        rendered: "ok",
        summary: "summary"
      }),
    { timeoutMs: 5_000 }
  );

  assert.equal(result.exitStatus, 0);
  const jobs = listJobs(workspace);
  const stored = jobs.find((entry) => entry.id === "task-ok-1");
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "done");
  assert.equal(stored.pid, null);
});
