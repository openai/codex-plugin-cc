import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { isJobCancelled, listJobs, resolveJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";
import { cleanupSessionJobs } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

// A pid that is (practically) guaranteed not to exist, so it reads as a dead worker.
const DEAD_PID = 2 ** 31 - 1;

test("cleanup marks a queued pid-less job cancelled and keeps it (a booting worker cannot resurrect it)", () => {
  const cwd = makeTempDir();
  const workspace = resolveWorkspaceRoot(cwd);
  // Enqueue wrote the queued record but the worker has not published its pid yet.
  upsertJob(workspace, { id: "q", status: "queued", phase: "queued", pid: null, sessionId: "s1" });

  cleanupSessionJobs(cwd, "s1");

  assert.equal(isJobCancelled(workspace, "q"), true, "an immutable cancel marker was published");
  const job = listJobs(workspace).find((entry) => entry.id === "q");
  assert.ok(job, "record must NOT be deleted while a worker could still be booting");
  assert.equal(job.status, "cancelled", "the marker overlays the record as cancelled");

  // A worker that already read the queued record then publishes running: the record
  // says running, but the immutable marker overlays every read back to cancelled.
  upsertJob(workspace, { id: "q", status: "running", pid: 12345 });
  const after = listJobs(workspace).find((entry) => entry.id === "q");
  assert.equal(after.status, "cancelled", "no resurrection to running: the marker wins on every read");
  assert.equal(after.pid, null, "an overlaid-cancelled job exposes no live pid");
});

test("cleanup deletes a running job whose worker is provably gone", () => {
  const cwd = makeTempDir();
  const workspace = resolveWorkspaceRoot(cwd);
  upsertJob(workspace, { id: "r", status: "running", phase: "starting", pid: DEAD_PID, sessionId: "s1" });

  cleanupSessionJobs(cwd, "s1");

  assert.equal(fs.existsSync(resolveJobFile(workspace, "r")), false, "a confirmed-dead worker's record is removed");
});

test("cleanup deletes an already-finished job and ignores other sessions", () => {
  const cwd = makeTempDir();
  const workspace = resolveWorkspaceRoot(cwd);
  upsertJob(workspace, { id: "done", status: "completed", pid: null, sessionId: "s1" });
  upsertJob(workspace, { id: "other", status: "running", pid: DEAD_PID, sessionId: "s2" });

  cleanupSessionJobs(cwd, "s1");

  assert.equal(fs.existsSync(resolveJobFile(workspace, "done")), false, "finished job of this session is removed");
  assert.ok(listJobs(workspace).find((entry) => entry.id === "other"), "another session's job is untouched");
});
