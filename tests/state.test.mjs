import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { listJobsAcrossWorkspaces, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/codex/scripts/lib/state.mjs";

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

test("cross-workspace scans validate each workspace once while rejecting misplaced job records", (t) => {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  const workspaces = [makeTempDir(), makeTempDir()];
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  let spawnSpy;

  try {
    const expectedJobs = workspaces.flatMap((workspaceRoot, workspaceIndex) => {
      initGitRepo(workspaceRoot);
      const jobs = Array.from({ length: 50 }, (_, index) => ({
        id: `job-${workspaceIndex}-${index}`,
        workspaceRoot
      }));
      saveState(workspaceRoot, { jobs });
      return jobs;
    });
    const misplacedStateFile = path.join(pluginData, "state", "misplaced", "state.json");
    fs.mkdirSync(path.dirname(misplacedStateFile), { recursive: true });
    fs.writeFileSync(misplacedStateFile, JSON.stringify({
      jobs: [
        { id: "forged-first-workspace", workspaceRoot: workspaces[0] },
        { id: "forged-second-workspace", workspaceRoot: workspaces[1] },
        null,
        { id: "malformed", workspaceRoot: 123 }
      ]
    }), "utf8");

    const gitWorkspaceResolutions = [];
    const originalSpawnSync = childProcess.spawnSync;
    spawnSpy = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        gitWorkspaceResolutions.push(options.cwd);
      }
      return originalSpawnSync(command, args, options);
    });
    syncBuiltinESMExports();

    for (let scan = 0; scan < 2; scan += 1) {
      gitWorkspaceResolutions.length = 0;
      const jobs = listJobsAcrossWorkspaces();
      assert.deepEqual(jobs.map((job) => job.id).sort(), expectedJobs.map((job) => job.id).sort());
      assert.deepEqual([...gitWorkspaceResolutions].sort(), [...workspaces].sort());
    }
  } finally {
    spawnSpy?.mock.restore();
    syncBuiltinESMExports();
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});
