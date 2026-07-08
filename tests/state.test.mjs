import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_CONCURRENT_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-concurrent-worker.mjs");

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

function runWorker(workspace, workerId, jobsPerWorker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATE_CONCURRENT_WORKER, workspace, String(workerId), String(jobsPerWorker)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

test("upsertJob preserves concurrent state updates from multiple processes", async () => {
  const workspace = makeTempDir();
  const workerCount = 5;
  const jobsPerWorker = 8;
  const expectedJobCount = workerCount * jobsPerWorker;

  const results = await Promise.all(
    Array.from({ length: workerCount }, (_, workerId) => runWorker(workspace, workerId, jobsPerWorker))
  );
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
  }

  const jobs = listJobs(workspace);
  assert.equal(jobs.length, expectedJobCount);
  assert.equal(new Set(jobs.map((job) => job.id)).size, expectedJobCount);
});

test("upsertJob waits for a live stale-looking state lock owner", async () => {
  const workspace = makeTempDir();
  const previousTimeout = process.env.CODEX_COMPANION_STATE_LOCK_TIMEOUT_MS;
  process.env.CODEX_COMPANION_STATE_LOCK_TIMEOUT_MS = "100";
  const stateDir = resolveStateDir(workspace);
  const lockDir = path.join(stateDir, ".state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`, "utf8");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, old, old);

  try {
    const result = await runWorker(workspace, "blocked", 1);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Timed out waiting for state lock/);
    assert.equal(fs.existsSync(lockDir), true);
  } finally {
    if (previousTimeout == null) {
      delete process.env.CODEX_COMPANION_STATE_LOCK_TIMEOUT_MS;
    } else {
      process.env.CODEX_COMPANION_STATE_LOCK_TIMEOUT_MS = previousTimeout;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("upsertJob recovers a stale lock after pid reuse", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const lockDir = path.join(stateDir, ".state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner"),
    `${JSON.stringify({ pid: process.pid, startedAt: "reused-process", token: "stale-owner" })}\n`,
    "utf8"
  );
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, old, old);

  const result = await runWorker(workspace, "recovered", 1);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(listJobs(workspace).length, 1);
});
