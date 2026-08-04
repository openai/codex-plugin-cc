import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

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

test("saveState with a stale snapshot does not destroy a concurrently written job", () => {
  const workspace = makeTempDir();

  // Process A: seed job-A and load a snapshot that only knows about it.
  upsertJob(workspace, {
    id: "job-A",
    status: "completed",
    logFile: resolveJobLogFile(workspace, "job-A")
  });
  const staleSnapshot = loadState(workspace);

  // Process B: record job-B along with its result and log files.
  const jobBLogFile = resolveJobLogFile(workspace, "job-B");
  fs.writeFileSync(jobBLogFile, "log job-B\n", "utf8");
  writeJobFile(workspace, "job-B", { id: "job-B", status: "completed" });
  upsertJob(workspace, {
    id: "job-B",
    status: "completed",
    logFile: jobBLogFile
  });

  // Process A saves its stale snapshot; job-B must survive untouched.
  saveState(workspace, staleSnapshot);

  const savedState = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.deepEqual(savedState.jobs.map((job) => job.id).sort(), ["job-A", "job-B"]);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-B")), true);
  assert.equal(fs.existsSync(jobBLogFile), true);
});

test("saveState removes ledger entries and artifacts for explicitly removed jobs", () => {
  const workspace = makeTempDir();

  for (const jobId of ["job-keep", "job-drop"]) {
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    writeJobFile(workspace, jobId, { id: jobId, status: "completed" });
    upsertJob(workspace, {
      id: jobId,
      status: "completed",
      logFile
    });
  }

  const state = loadState(workspace);
  saveState(
    workspace,
    {
      ...state,
      jobs: state.jobs.filter((job) => job.id !== "job-drop")
    },
    { removedJobIds: ["job-drop"] }
  );

  const savedState = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.deepEqual(savedState.jobs.map((job) => job.id), ["job-keep"]);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-drop")), false);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-drop")), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-keep")), true);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-keep")), true);
});
