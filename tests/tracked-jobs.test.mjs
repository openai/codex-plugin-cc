import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  markJobCancellationRequested,
  markJobRemovalRequested,
  readJobFile,
  resolveJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { failTrackedJobLaunch, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_JOBS_SOURCE = path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs");

test("runTrackedJob honors a durable cancellation request before invoking the runner", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobId = "task-cancel-handoff";
  markJobCancellationRequested(repo, jobId);
  let runnerCalled = false;
  const execution = await runTrackedJob(
    { id: jobId, workspaceRoot: repo, title: "Codex Task", status: "queued" },
    async () => {
      runnerCalled = true;
      return { exitStatus: 0, payload: {}, rendered: "ran\n", summary: "ran" };
    }
  );
  assert.equal(runnerCalled, false);
  assert.equal(execution.payload.status, "cancelled");
  const stored = readJobFile(resolveJobFile(repo, jobId));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.pid, null);
});

test("runTrackedJob checks cancellation after publishing running state and before the runner", () => {
  const source = fs.readFileSync(TRACKED_JOBS_SOURCE, "utf8");
  const start = source.indexOf("export async function runTrackedJob");
  const end = source.indexOf("\n}", start) + 2;
  const body = source.slice(start, end);
  const runningWrite = body.indexOf("upsertJob(job.workspaceRoot, runningRecord)");
  const cancelCheck = body.indexOf("isJobCancellationRequested(job.workspaceRoot, job.id)");
  const runnerCall = body.indexOf("await runner()");
  assert.ok(runningWrite >= 0 && runningWrite < cancelCheck);
  assert.ok(cancelCheck < runnerCall);
});


test("runTrackedJob rechecks removal after persisting startup cancellation", () => {
  const source = fs.readFileSync(TRACKED_JOBS_SOURCE, "utf8");
  const start = source.indexOf("if (isJobCancellationRequested(job.workspaceRoot, job.id))", source.indexOf("export async function runTrackedJob"));
  const end = source.indexOf("const execution = await runner()", start);
  const branch = source.slice(start, end);
  const cancelledWrite = branch.indexOf("writeJobFile(job.workspaceRoot, job.id, cancelledRecord)");
  const cancelledUpsert = branch.indexOf("upsertJob(job.workspaceRoot");
  const removalRecheck = branch.indexOf("isJobRemovalRequested(job.workspaceRoot, job.id)", cancelledUpsert);
  assert.ok(cancelledWrite >= 0 && cancelledWrite < cancelledUpsert);
  assert.ok(cancelledUpsert >= 0 && cancelledUpsert < removalRecheck);
});

test("runTrackedJob does not recreate a job removed during execution", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobId = "task-session-end";
  const execution = await runTrackedJob(
    { id: jobId, workspaceRoot: repo, title: "Codex Task", status: "queued" },
    async () => {
      markJobRemovalRequested(repo, jobId);
      return { exitStatus: 0, payload: {}, rendered: "ran\n", summary: "ran" };
    }
  );
  assert.equal(execution.payload.status, "removed");
  assert.equal(fs.existsSync(resolveJobFile(repo, jobId)), false);
});

test("failTrackedJobLaunch transitions a queued job to failed", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobId = "task-spawn-failure";
  const failed = failTrackedJobLaunch(
    { id: jobId, workspaceRoot: repo, status: "queued", phase: "queued", pid: null },
    new Error("spawn denied")
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage, /spawn denied/);
  assert.equal(readJobFile(resolveJobFile(repo, jobId)).status, "failed");
});

test("failTrackedJobLaunch does not overwrite a cancelled job", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobId = "task-spawn-failure-after-cancel";
  const jobFile = resolveJobFile(repo, jobId);
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ id: jobId, workspaceRoot: repo, status: "cancelled", phase: "cancelled", pid: null }, null, 2)}\n`,
    "utf8"
  );
  markJobCancellationRequested(repo, jobId);

  const result = failTrackedJobLaunch(
    { id: jobId, workspaceRoot: repo, status: "queued", phase: "queued", pid: null },
    new Error("late spawn error")
  );

  assert.equal(result.status, "cancelled");
  assert.equal(readJobFile(jobFile).status, "cancelled");
});

test("failTrackedJobLaunch preserves cancellation that wins after the initial check", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobId = "task-spawn-failure-races-cancel";
  const jobFile = resolveJobFile(repo, jobId);
  const queued = { id: jobId, workspaceRoot: repo, status: "queued", phase: "queued", pid: null };
  fs.writeFileSync(jobFile, `${JSON.stringify(queued, null, 2)}\n`, "utf8");

  const error = {
    toString() {
      markJobCancellationRequested(repo, jobId);
      fs.writeFileSync(
        jobFile,
        `${JSON.stringify({ ...queued, status: "cancelled", phase: "cancelled" }, null, 2)}\n`,
        "utf8"
      );
      return "late spawn error";
    }
  };

  const result = failTrackedJobLaunch(queued, error);
  assert.equal(result.status, "cancelled");
  assert.equal(readJobFile(jobFile).status, "cancelled");
});

test("failTrackedJobLaunch preserves removal that wins after the initial check", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobId = "task-spawn-failure-races-removal";
  const jobFile = resolveJobFile(repo, jobId);
  const queued = { id: jobId, workspaceRoot: repo, status: "queued", phase: "queued", pid: null };
  fs.writeFileSync(jobFile, `${JSON.stringify(queued, null, 2)}\n`, "utf8");

  const error = {
    toString() {
      markJobRemovalRequested(repo, jobId);
      fs.unlinkSync(jobFile);
      return "late spawn error";
    }
  };

  const result = failTrackedJobLaunch(queued, error);
  assert.equal(result.status, "removed");
  assert.equal(fs.existsSync(jobFile), false);
});
