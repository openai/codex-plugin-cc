import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { reapDeadJobs } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_JOBS_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs")).href;

function seedJob(workspace, job) {
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
}

function spawnDeadPid() {
  const result = run(process.execPath, ["-e", ""]);
  assert.equal(result.status, 0);
  return result.pid;
}

test("reapDeadJobs marks a running job with a dead pid as failed", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-dead", status: "running", phase: "delegating", pid: spawnDeadPid(), logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].status, "failed");
  assert.equal(reaped[0].pid, null);
  assert.match(reaped[0].errorMessage, /died without recording a result/);

  const stored = readJobFile(resolveJobFile(workspace, "job-dead"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.pid, null);
  assert.equal(listJobs(workspace).find((job) => job.id === "job-dead").status, "failed");
});

test("reapDeadJobs refreshes updatedAt so the reaped job sorts newest-first", () => {
  const workspace = makeTempDir();
  const stale = "2000-01-01T00:00:00.000Z";
  seedJob(workspace, { id: "job-stale", status: "running", phase: "delegating", pid: spawnDeadPid(), updatedAt: stale, logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.notEqual(reaped[0].updatedAt, stale);
  assert.equal(reaped[0].updatedAt, reaped[0].completedAt);
  assert.equal(readJobFile(resolveJobFile(workspace, "job-stale")).updatedAt, reaped[0].updatedAt);
});

test("reapDeadJobs leaves a running job with a live pid untouched", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-live", status: "running", phase: "delegating", pid: process.pid, logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "running");
  assert.equal(readJobFile(resolveJobFile(workspace, "job-live")).status, "running");
});

test("reapDeadJobs leaves jobs without a recorded pid untouched", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-no-pid", status: "queued", phase: "queued", pid: null, logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "queued");
});

test("reapDeadJobs keeps the stored result when the job finished between read and probe", () => {
  const workspace = makeTempDir();
  const deadPid = spawnDeadPid();
  writeJobFile(workspace, "job-raced", { id: "job-raced", status: "completed", phase: "completed", result: "done" });
  upsertJob(workspace, { id: "job-raced", status: "running", phase: "delegating", pid: deadPid, logFile: null });

  const reaped = reapDeadJobs(workspace, [{ id: "job-raced", status: "running", pid: deadPid, logFile: null }]);

  assert.equal(reaped[0].status, "completed");
  assert.equal(reaped[0].result, "done");
  assert.equal(readJobFile(resolveJobFile(workspace, "job-raced")).status, "completed");
});

test("registerWorkerCrashGuard marks the job failed when the worker dies on an unhandled rejection", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-crash", status: "running", phase: "delegating", pid: null, logFile: null });

  const workerFile = path.join(makeTempDir(), "crashing-worker.mjs");
  fs.writeFileSync(
    workerFile,
    [
      `import { registerWorkerCrashGuard } from ${JSON.stringify(TRACKED_JOBS_URL)};`,
      "registerWorkerCrashGuard(process.argv[2], process.argv[3], null);",
      'Promise.reject(new Error("boom"));',
      "setTimeout(() => {}, 5000);",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = run(process.execPath, [workerFile, workspace, "job-crash"]);

  assert.equal(result.status, 1);
  const stored = readJobFile(resolveJobFile(workspace, "job-crash"));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /unhandledRejection/);
  assert.match(stored.errorMessage, /boom/);
});

test("registerWorkerCrashGuard does not rewrite a cancelled job when the worker is SIGTERMed", async () => {
  const workspace = makeTempDir();
  // Simulate handleCancel having already written the terminal state before the
  // worker processes the teardown SIGTERM it delivered.
  seedJob(workspace, { id: "job-cancelled", status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user." });

  const workerFile = path.join(makeTempDir(), "long-worker.mjs");
  fs.writeFileSync(
    workerFile,
    [
      `import { registerWorkerCrashGuard } from ${JSON.stringify(TRACKED_JOBS_URL)};`,
      "registerWorkerCrashGuard(process.argv[2], process.argv[3], null);",
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"),
    "utf8"
  );

  const child = spawn(process.execPath, [workerFile, workspace, "job-cancelled"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) {
        resolve();
      }
    });
    child.on("error", reject);
  });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const { signal } = await exited;

  assert.equal(signal, "SIGTERM");
  const stored = readJobFile(resolveJobFile(workspace, "job-cancelled"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.errorMessage, "Cancelled by user.");
});
