import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir } from "./helpers.mjs";
import { loadState, resolveJobFile, saveState, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { cleanupSessionJobs, waitForWorkerJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("session cleanup waits for active jobs before removing their state", async () => {
  const workspace = makeTempDir();
  const logFile = path.join(workspace, "active.log");
  const otherLogFile = path.join(workspace, "other.log");
  fs.writeFileSync(logFile, "active\n", "utf8");
  fs.writeFileSync(otherLogFile, "other\n", "utf8");
  const activeJob = {
    id: "task-active",
    status: "running",
    sessionId: "session-a",
    pid: 123,
    workerToken: "worker-token-1234567890",
    logFile
  };
  const otherJob = {
    id: "task-other",
    status: "completed",
    sessionId: "session-b",
    pid: null,
    logFile: otherLogFile
  };
  saveState(workspace, { jobs: [activeJob, otherJob] });
  writeJobFile(workspace, activeJob.id, activeJob);
  writeJobFile(workspace, otherJob.id, otherJob);

  let running = true;
  const outcome = await cleanupSessionJobs(workspace, "session-a", {
    platform: "darwin",
    verifyProcess(pid, token) {
      return pid === activeJob.pid && token === activeJob.workerToken;
    },
    killImpl(target, signal) {
      assert.equal(target, -123);
      if (signal === 0 && !running) {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      }
      if (signal === "SIGTERM") {
        running = false;
      }
    }
  });

  assert.deepEqual(outcome.removed, [activeJob.id]);
  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), [otherJob.id]);
  assert.equal(fs.existsSync(resolveJobFile(workspace, activeJob.id)), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, otherJob.id)), true);
  assert.equal(fs.existsSync(otherLogFile), true);
});

test("session cleanup retains unverifiable active jobs and diagnostic files", async () => {
  const workspace = makeTempDir();
  const logFile = path.join(workspace, "active.log");
  fs.writeFileSync(logFile, "diagnostic\n", "utf8");
  const activeJob = {
    id: "task-unverifiable",
    status: "running",
    sessionId: "session-a",
    pid: 0,
    workerToken: "worker-token-invalid-1234",
    logFile
  };
  saveState(workspace, { jobs: [activeJob] });
  writeJobFile(workspace, activeJob.id, activeJob);

  await assert.rejects(cleanupSessionJobs(workspace, "session-a"), /Failed to stop all Codex session jobs/);

  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), [activeJob.id]);
  assert.equal(fs.existsSync(resolveJobFile(workspace, activeJob.id)), true);
  assert.equal(fs.existsSync(logFile), true);
});

test("session cleanup preserves jobs added while an active job is stopping", async () => {
  const workspace = makeTempDir();
  const activeJob = {
    id: "task-active",
    status: "running",
    sessionId: "session-a",
    pid: 123,
    workerToken: "worker-token-1234567890"
  };
  const concurrentJob = {
    id: "task-concurrent",
    status: "queued",
    sessionId: "session-b",
    pid: 456,
    workerToken: "worker-token-concurrent-1234"
  };
  saveState(workspace, { jobs: [activeJob] });

  let running = true;
  await cleanupSessionJobs(workspace, "session-a", {
    platform: "darwin",
    verifyProcess() {
      return true;
    },
    killImpl(target, signal) {
      assert.equal(target, -123);
      if (signal === "SIGTERM") {
        running = false;
        saveState(workspace, { jobs: [activeJob, concurrentJob] });
      } else if (signal === 0 && !running) {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), [concurrentJob.id]);
});

test("task worker waits until its tokenized record contains its own PID", async () => {
  const workspace = makeTempDir();
  const jobId = "task-delayed";
  const workerToken = "worker-token-delayed-1234567890";
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "queued",
    pid: null,
    workerToken,
    request: { prompt: "delayed" }
  });

  const waiting = waitForWorkerJob(workspace, jobId, workerToken, 987, {
    timeoutMs: 500,
    intervalMs: 10
  });
  setTimeout(() => {
    const registeredJob = {
      id: jobId,
      status: "queued",
      pid: 987,
      workerToken,
      request: { prompt: "delayed" }
    };
    writeJobFile(workspace, jobId, registeredJob);
    saveState(workspace, { jobs: [registeredJob] });
  }, 30);

  const storedJob = await waiting;
  assert.equal(storedJob.pid, 987);
  assert.equal(storedJob.workerToken, workerToken);
});
