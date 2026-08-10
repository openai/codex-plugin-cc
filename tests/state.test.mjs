import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/codex/scripts/lib/state.mjs";

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

test("saveState never prunes active jobs, however old their records are", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 52 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const jobFile = resolveJobFile(workspace, jobId);
    // The two oldest records belong to another session's in-flight work;
    // pruning them would hide the jobs from the session-end broker guard.
    const status = index <= 1 ? "running" : "completed";
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status }, null, 2), "utf8");
    return {
      id: jobId,
      status,
      updatedAt,
      createdAt: updatedAt
    };
  });

  const savedState = saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  assert.equal(savedState.jobs.length, 50);
  const retainedIds = new Set(savedState.jobs.map((job) => job.id));
  assert.equal(retainedIds.has("job-0"), true, "oldest running job must survive the prune");
  assert.equal(retainedIds.has("job-1"), true, "second running job must survive the prune");
  assert.equal(retainedIds.has("job-2"), false, "oldest terminal jobs age out instead");
  assert.equal(retainedIds.has("job-3"), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), true);
});

test("saveState keeps a newly terminal job even when active jobs fill the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    // The newest record is a job that just finished among 50 active peers;
    // it must not vanish the moment it completes.
    const status = index === 50 ? "completed" : "running";
    fs.writeFileSync(resolveJobFile(workspace, jobId), JSON.stringify({ id: jobId, status }, null, 2), "utf8");
    return { id: jobId, status, updatedAt, createdAt: updatedAt };
  });

  const savedState = saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const retainedIds = new Set(savedState.jobs.map((job) => job.id));
  assert.equal(retainedIds.has("job-50"), true, "the newly completed job must survive the prune");
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-50")), true);
  assert.equal(savedState.jobs.length, 51, "all 50 active jobs plus the fresh terminal record are retained");
});

test("writeJobFile never exposes a torn record to a concurrent reader", async (t) => {
  const { writeJobFile, readJobFile } = await import("../plugins/codex/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  const jobId = "job-atomic";
  const jobFile = resolveJobFile(workspace, jobId);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  // A payload large enough that a truncate-in-place write leaves a torn
  // window a concurrent reader can observe (the enqueue rewrites this file
  // while the detached worker's startup reads it).
  const payload = { id: jobId, status: "queued", filler: "x".repeat(64 * 1024) };
  writeJobFile(workspace, jobId, payload);

  const { spawn } = await import("node:child_process");
  const readerScript = `
    const fs = require("node:fs");
    const deadline = Date.now() + 2000;
    let reads = 0;
    while (Date.now() < deadline) {
      try {
        JSON.parse(fs.readFileSync(${JSON.stringify(jobFile)}, "utf8"));
        reads++;
      } catch (error) {
        console.error("TORN-READ after " + reads + " reads: " + error.message);
        process.exit(1);
      }
    }
    console.log(reads);
  `;
  const reader = spawn(process.execPath, ["-e", readerScript], { stdio: ["ignore", "pipe", "pipe"] });
  let readerErr = "";
  reader.stderr.on("data", (chunk) => (readerErr += chunk));
  const done = new Promise((resolve) => reader.on("exit", resolve));

  const writeDeadline = Date.now() + 1900;
  while (Date.now() < writeDeadline) {
    writeJobFile(workspace, jobId, { ...payload, updatedAt: new Date().toISOString() });
  }

  const exitCode = await done;
  assert.equal(exitCode, 0, `concurrent reader observed a torn job record: ${readerErr.trim()}`);
  assert.deepEqual(readJobFile(jobFile).id, jobId);
});
