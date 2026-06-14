import fs from "node:fs";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobLogFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";

// These cover the liveness-reconcile fix: a job whose worker pid is dead but whose stored
// status is still active must not masquerade as `running` forever (the zombie bug).
function withWorkspace(fn) {
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevSession = process.env.CODEX_COMPANION_SESSION_ID;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  delete process.env.CODEX_COMPANION_SESSION_ID; // avoid session-scoped filtering in tests
  const workspace = makeTempDir();
  try {
    return fn(workspace);
  } finally {
    if (prevData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = prevData;
    }
    if (prevSession === undefined) {
      delete process.env.CODEX_COMPANION_SESSION_ID;
    } else {
      process.env.CODEX_COMPANION_SESSION_ID = prevSession;
    }
  }
}

const DEAD_PID = 999999; // beyond the macOS/Linux pid range — guaranteed not running

test("status reconciles a running job with a dead worker pid to failed:orphaned", () => {
  withWorkspace((workspace) => {
    const logFile = resolveJobLogFile(workspace, "task-dead");
    fs.writeFileSync(logFile, "[t] Running command: pytest\n[t] partial work captured\n");
    const record = {
      id: "task-dead",
      status: "running",
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      logFile,
      jobClass: "task"
    };
    upsertJob(workspace, record);
    writeJobFile(workspace, "task-dead", record);

    const snapshot = buildStatusSnapshot(workspace);
    assert.equal(
      snapshot.running.some((job) => job.id === "task-dead"),
      false,
      "a dead-pid job must not remain in running[]"
    );
    const finished = [snapshot.latestFinished, ...snapshot.recent].filter(Boolean);
    const dead = finished.find((job) => job.id === "task-dead");
    assert.ok(dead, "the dead job must be reconciled into a terminal bucket");
    assert.equal(dead.status, "failed");
    assert.equal(dead.phase, "failed:orphaned");

    // Idempotent: a second read must not error or flip it back to running.
    const second = buildStatusSnapshot(workspace);
    assert.equal(second.running.some((job) => job.id === "task-dead"), false);
  });
});

test("status leaves a running job with a live worker pid untouched", () => {
  withWorkspace((workspace) => {
    const child = spawn("sleep", ["10"]);
    try {
      upsertJob(workspace, {
        id: "task-live",
        status: "running",
        pid: child.pid,
        startedAt: new Date().toISOString(),
        jobClass: "task"
      });
      const snapshot = buildStatusSnapshot(workspace);
      assert.equal(
        snapshot.running.some((job) => job.id === "task-live" && job.status === "running"),
        true,
        "a live-pid job must stay running"
      );
    } finally {
      child.kill();
    }
  });
});

test("result resolves a reconciled orphan instead of throwing 'still running'", () => {
  withWorkspace((workspace) => {
    const logFile = resolveJobLogFile(workspace, "task-orphan");
    fs.writeFileSync(logFile, "[t] FINDING: example at foo.js:12\n");
    const record = {
      id: "task-orphan",
      status: "running",
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      logFile,
      jobClass: "task",
      title: "Codex Task"
    };
    upsertJob(workspace, record);
    writeJobFile(workspace, "task-orphan", record);

    const { job } = resolveResultJob(workspace, "task-orphan");
    assert.equal(job.status, "failed");
    assert.equal(job.phase, "failed:orphaned");
  });
});
