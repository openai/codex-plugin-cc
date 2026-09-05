import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveState } from "../plugins/codex/scripts/lib/state.mjs";

import {
  buildStatusSnapshot,
  reconcileJobLiveness,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/codex/scripts/lib/job-control.mjs";

function activeJob(overrides = {}) {
  return {
    id: "task-dead-worker",
    status: "running",
    phase: "editing",
    pid: 999999,
    ...overrides
  };
}

test("reconcileJobLiveness marks an absent worker as terminated-unknown", () => {
  const job = reconcileJobLiveness(activeJob(), {
    killImpl() {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(job.status, "terminated-unknown");
  assert.equal(job.phase, "worker-exited");
  assert.equal(job.pid, 999999);
});

test("reconcileJobLiveness keeps a dead worker active when its Codex turn may still run", () => {
  const job = reconcileJobLiveness(
    activeJob({ threadId: "thr_live", turnId: "turn_live" }),
    {
      killImpl() {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      }
    }
  );

  assert.equal(job.status, "running");
  assert.equal(job.phase, "worker-exited-turn-unknown");
  assert.equal(job.threadId, "thr_live");
  assert.equal(job.turnId, "turn_live");
});

test("reconcileJobLiveness keeps the turn-start response window active", () => {
  const job = reconcileJobLiveness(activeJob({ threadId: "thr_pending", turnId: null }), {
    killImpl() {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(job.status, "running");
  assert.equal(job.phase, "worker-exited-turn-unknown");
  assert.equal(job.pid, null);
  assert.equal(job.workerExited, true);
});

test("reconcileJobLiveness treats EPERM as alive", () => {
  const original = activeJob();
  const job = reconcileJobLiveness(original, {
    killImpl() {
      const error = new Error("not permitted");
      error.code = "EPERM";
      throw error;
    }
  });
  assert.deepEqual(job, original);
});

test("reconcileJobLiveness leaves terminal and pid-less jobs untouched", () => {
  let calls = 0;
  const killImpl = () => { calls += 1; };
  const completed = activeJob({ status: "completed" });
  const noPid = activeJob({ pid: null });

  assert.deepEqual(reconcileJobLiveness(completed, { killImpl }), completed);
  assert.deepEqual(reconcileJobLiveness(noPid, { killImpl }), noPid);
  assert.equal(calls, 0);
});

test("dead wrapper with a live turn stays active and cancelable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-job-turn-unknown-"));
  const workspace = path.join(root, "workspace");
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  fs.mkdirSync(workspace, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin-data");

  try {
    saveState(workspace, {
      config: { stopReviewGate: false },
      jobs: [activeJob({
        threadId: "thr_live",
        turnId: "turn_live",
        sessionId: "sess-current",
        createdAt: "2026-09-04T10:00:00.000Z",
        updatedAt: "2026-09-04T10:01:00.000Z"
      })]
    });
    const killImpl = () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    };
    const options = { env: { CODEX_COMPANION_SESSION_ID: "sess-current" }, killImpl };
    const report = buildStatusSnapshot(workspace, options);
    assert.equal(report.running.length, 1);
    assert.equal(report.running[0].phase, "worker-exited-turn-unknown");
    assert.equal(report.running[0].pid, null);
    assert.equal(resolveCancelableJob(workspace, "task-dead-worker", options).job.turnId, "turn_live");
    assert.throws(() => resolveResultJob(workspace, "task-dead-worker", options));
  } finally {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildStatusSnapshot moves a dead worker out of the active queue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-job-control-"));
  const workspace = path.join(root, "workspace");
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  fs.mkdirSync(workspace, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin-data");

  try {
    saveState(workspace, {
      config: { stopReviewGate: false },
      jobs: [{
        id: "task-dead-worker",
        status: "running",
        phase: "editing",
        pid: 999999,
        createdAt: "2026-09-04T10:00:00.000Z",
        updatedAt: "2026-09-04T10:01:00.000Z"
      }]
    });
    const reportKill = () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    };
    const report = buildStatusSnapshot(workspace, { env: {}, killImpl: reportKill });
    assert.equal(report.running.length, 0);
    assert.equal(report.latestFinished.status, "terminated-unknown");
    assert.equal(report.latestFinished.phase, "worker-exited");
    assert.equal(
      resolveResultJob(workspace, "task-dead-worker", { killImpl: reportKill }).job.status,
      "terminated-unknown"
    );
    assert.throws(
      () => resolveCancelableJob(workspace, "task-dead-worker", { killImpl: reportKill }),
      /No job found|No active job/
    );
  } finally {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("implicit result ignores a newer dead worker in favor of stored final output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-job-result-"));
  const workspace = path.join(root, "workspace");
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  fs.mkdirSync(workspace, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin-data");

  try {
    saveState(workspace, {
      config: { stopReviewGate: false },
      jobs: [
        activeJob({ sessionId: "sess-current", updatedAt: "2026-09-04T10:02:00.000Z" }),
        { id: "task-completed", status: "completed", sessionId: "sess-current", result: { rawOutput: "done" }, updatedAt: "2026-09-04T10:01:00.000Z" }
      ]
    });
    const killImpl = () => { const error = new Error("no such process"); error.code = "ESRCH"; throw error; };
    const options = { env: { CODEX_COMPANION_SESSION_ID: "sess-current" }, killImpl };

    assert.equal(resolveResultJob(workspace, null, options).job.id, "task-completed");
    assert.equal(resolveResultJob(workspace, "task-dead-worker", options).job.status, "terminated-unknown");
  } finally {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
