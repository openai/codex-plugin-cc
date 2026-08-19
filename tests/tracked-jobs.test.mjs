import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("runTrackedJob does not resurrect a terminal persisted job", async () => {
  const workspaceRoot = makeTempDir();
  const job = {
    id: "task-terminal",
    workspaceRoot,
    status: "queued",
    request: { prompt: "do not run" }
  };
  const terminalJob = {
    ...job,
    status: "failed",
    phase: "failed",
    errorMessage: "Background worker exited before completing the job.",
    pid: null,
    completedAt: "2026-08-19T12:00:00.000Z"
  };
  writeJobFile(workspaceRoot, job.id, terminalJob);
  upsertJob(workspaceRoot, terminalJob);

  let runnerInvoked = false;
  const result = await runTrackedJob(job, async () => {
    runnerInvoked = true;
    return { exitStatus: 0 };
  });

  assert.equal(runnerInvoked, false);
  assert.deepEqual(result, terminalJob);
  assert.deepEqual(readJobFile(resolveJobFile(workspaceRoot, job.id)), terminalJob);
});

test("runTrackedJob returns a failed record for missing background state", async () => {
  const workspaceRoot = makeTempDir();
  const job = {
    id: "task-removed",
    workspaceRoot,
    status: "queued",
    request: { prompt: "do not run" }
  };
  const jobFile = resolveJobFile(workspaceRoot, job.id);

  let runnerInvoked = false;
  const result = await runTrackedJob(job, async () => {
    runnerInvoked = true;
    return { exitStatus: 0 };
  });

  assert.equal(runnerInvoked, false);
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /record is missing/i);
  assert.equal(fs.existsSync(jobFile), false);
});

test("runTrackedJob returns a cancelled record after removal", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "task-removed-fence", workspaceRoot, status: "queued", request: { prompt: "do not run" } };
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, job);
  fs.writeFileSync(resolveJobFile(workspaceRoot, job.id).replace(/\.json$/, ".removed"), "", "utf8");

  let runnerInvoked = false;
  const result = await runTrackedJob(job, async () => {
    runnerInvoked = true;
    return { exitStatus: 0 };
  });

  assert.equal(runnerInvoked, false);
  assert.equal(result.status, "cancelled");
  assert.equal(result.removed, true);
});
