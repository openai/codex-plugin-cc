import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  removeSessionJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
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

test("removeSessionJobs preserves a job added before acquiring the state lock", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobA = { id: "job-a", status: "running", sessionId: "A" };
  const jobB = {
    id: "job-b",
    status: "running",
    sessionId: "B",
    jobFile: resolveJobFile(workspace, "job-b"),
    logFile: resolveJobLogFile(workspace, "job-b")
  };
  saveState(workspace, { jobs: [jobA] });
  fs.writeFileSync(jobB.jobFile, JSON.stringify(jobB), "utf8");
  fs.writeFileSync(jobB.logFile, "running\n", "utf8");

  const lockDir = `${stateFile}.lock`;
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, destination) => {
    if (destination === lockDir && !injected) {
      injected = true;
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, jobs: [...state.jobs, jobB] }, null, 2)}\n`, "utf8");
    }
    return originalRenameSync.call(fs, source, destination);
  };

  let removed;
  try {
    removed = removeSessionJobs(workspace, "A");
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(removed.map((job) => job.id), ["job-a"]);
  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), ["job-b"]);
  assert.equal(fs.existsSync(jobB.jobFile), true);
  assert.equal(fs.existsSync(jobB.logFile), true);
});

test("saveState does not release a state lock that has a replacement owner", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const lockDir = `${stateFile}.lock`;
  const tokenFile = path.join(lockDir, "owner");
  const originalRenameSync = fs.renameSync;
  let replaced = false;
  fs.renameSync = (source, destination) => {
    const result = originalRenameSync.call(fs, source, destination);
    if (destination === stateFile && !replaced) {
      replaced = true;
      fs.writeFileSync(tokenFile, "replacement-owner", "utf8");
    }
    return result;
  };

  try {
    saveState(workspace, { jobs: [] });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "replacement-owner");
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test("saveState immediately reclaims a fresh lock whose owner process exited", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const lockDir = `${stateFile}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), "2147483647-crashed", "utf8");

  const startedAt = Date.now();
  saveState(workspace, { jobs: [] });

  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(fs.existsSync(lockDir), false);
  assert.deepEqual(loadState(workspace).jobs, []);
});

test("saveState retries when a contended lock disappears before inspection", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const lockDir = `${stateFile}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}-holder`, "utf8");
  const originalExistsSync = fs.existsSync;
  let released = false;
  fs.existsSync = (target) => {
    if (target === lockDir && !released) {
      released = true;
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return originalExistsSync.call(fs, target);
  };

  try {
    saveState(workspace, { jobs: [] });
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert.equal(released, true);
  assert.deepEqual(loadState(workspace).jobs, []);
});

test("saveState recovers an orphaned stale-reclaim barrier", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const barrier = fs.mkdtempSync(`${stateFile}.lock.reclaim-2147483647-`);

  saveState(workspace, { jobs: [] });

  assert.equal(fs.existsSync(barrier), false);
  assert.deepEqual(loadState(workspace).jobs, []);
});
