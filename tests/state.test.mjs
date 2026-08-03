import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, updateState, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("writeJobFile writes atomically and leaves no temp files behind", () => {
  const workspace = makeTempDir();
  const jobId = "job-atomic";
  writeJobFile(workspace, jobId, { id: jobId, status: "running", note: "payload" });

  const jobFile = resolveJobFile(workspace, jobId);
  assert.deepEqual(readJobFile(jobFile), { id: jobId, status: "running", note: "payload" });

  const leftovers = fs.readdirSync(path.dirname(jobFile)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no temp files should survive an atomic write");
});

test("updateState re-adds an active job missing from a stale mutation, but a direct saveState can still remove it", () => {
  const workspace = makeTempDir();

  // Seed two active jobs on disk with files + logs.
  const liveIds = ["job-live-a", "job-live-b"];
  for (const id of liveIds) {
    writeJobFile(workspace, id, { id, status: "running" });
    fs.writeFileSync(resolveJobLogFile(workspace, id), `log ${id}\n`, "utf8");
  }
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: liveIds.map((id) => ({ id, status: "running", logFile: resolveJobLogFile(workspace, id) }))
  });

  // A mutation that drops an active job (standing in for a stale snapshot from
  // a concurrent worker) must not lose it: updateState re-adds it and its files
  // survive.
  updateState(workspace, (state) => {
    state.jobs = state.jobs.filter((job) => job.id !== "job-live-b");
  });
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-live-b")), true, "dropped live job file must not be deleted");
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-live-b")), true, "dropped live job log must not be deleted");
  assert.ok(
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.some((job) => job.id === "job-live-b"),
    "dropped live job must be merged back into the index"
  );

  // A direct saveState (session teardown) that intends to remove an active job
  // must still succeed — the reconciliation only guards updateState mutators.
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: "job-live-a", status: "running", logFile: resolveJobLogFile(workspace, "job-live-a") }]
  });
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-live-b")), false, "direct saveState removal must delete the job file");
  assert.ok(
    !JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.some((job) => job.id === "job-live-b"),
    "direct saveState removal must drop the job from the index"
  );
});
