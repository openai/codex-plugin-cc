import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  isJobCancelled,
  isSessionEnded,
  listJobs,
  markJobCancelled,
  markSessionEnded,
  readJobPid,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "state.mjs")).href;

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

test("upsertJob merges a patch into a job's record without dropping fields", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "j1", { id: "j1", status: "running", sessionId: "s1", pid: 123 });
  upsertJob(workspace, { id: "j1", status: "completed", summary: "done" });

  const job = listJobs(workspace).find((entry) => entry.id === "j1");
  assert.equal(job.status, "completed");
  assert.equal(job.summary, "done");
  assert.equal(job.sessionId, "s1"); // field from the earlier write is preserved
  assert.ok(job.createdAt);
  assert.ok(job.updatedAt);
});

test("concurrent upserts of different jobs never lose a record (no lock)", async () => {
  const workspace = makeTempDir();
  const jobCount = 16;
  const worker =
    `import { upsertJob } from ${JSON.stringify(STATE_URL)};\n` +
    "const [cwd, id] = process.argv.slice(1);\n" +
    "upsertJob(cwd, { id, status: \"queued\", jobClass: \"task\", summary: id });\n";

  await Promise.all(
    Array.from({ length: jobCount }, (_, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", worker, workspace, `job-${index}`],
          { stdio: "ignore" }
        );
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker ${index} exited ${code}`))
        );
      })
    )
  );

  const ids = new Set(listJobs(workspace).map((job) => job.id));
  const missing = Array.from({ length: jobCount }, (_, index) => `job-${index}`).filter(
    (id) => !ids.has(id)
  );
  assert.deepEqual(missing, [], "every concurrently launched job must be present");
});

test("prune evicts oldest terminal jobs but keeps live and non-terminal ones over the cap", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);

  // 50 old terminal jobs (completed), staggered updatedAt so ordering is defined.
  for (let i = 0; i < 50; i += 1) {
    const id = `done-${String(i).padStart(2, "0")}`;
    const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
    fs.writeFileSync(resolveJobFile(workspace, id), JSON.stringify({ id, status: "completed", updatedAt: ts, createdAt: ts }));
    fs.writeFileSync(resolveJobLogFile(workspace, id), `log ${id}\n`);
  }
  // A running job owned by THIS (alive) process, with the oldest timestamp of all.
  const liveTs = new Date(Date.UTC(2025, 0, 1)).toISOString();
  fs.writeFileSync(
    resolveJobFile(workspace, "live"),
    JSON.stringify({ id: "live", status: "running", pid: process.pid, updatedAt: liveTs, createdAt: liveTs })
  );

  // 52 files now (> MAX_JOBS=50). One more write triggers prune (overflow 2).
  upsertJob(workspace, { id: "trigger", status: "completed" });

  const ids = new Set(listJobs(workspace).map((job) => job.id));
  assert.equal(ids.has("live"), true, "a live running job must never be pruned, even as the oldest");
  // Only records OUTSIDE the newest MAX_JOBS window are eviction candidates. With 52
  // records the two oldest are `done-00` and `live`; `done-00` (terminal) is evicted,
  // `live` (non-evictable) is kept -> the cap stays soft at 51. `done-01` is inside the
  // protected newest-50 window, so it survives.
  assert.equal(ids.has("done-00"), false, "the oldest terminal job (outside the window) is evicted");
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "done-00")), false, "evicted job's log is removed too");
  assert.equal(ids.has("done-01"), true, "a job inside the newest-MAX_JOBS window is protected");
  assert.equal(ids.has("done-02"), true, "newer terminal jobs are kept");
});

test("prune never evicts a just-completed job when the cap is full of non-evictable jobs", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  // MAX_JOBS (50) queued, pid-less jobs -> all non-evictable.
  for (let i = 0; i < 50; i += 1) {
    const id = `q-${String(i).padStart(2, "0")}`;
    const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
    fs.writeFileSync(resolveJobFile(workspace, id), JSON.stringify({ id, status: "queued", pid: null, updatedAt: ts, createdAt: ts }));
  }
  // A 51st job completes with full output; its write triggers prune.
  upsertJob(workspace, { id: "fresh", status: "completed", result: { codex: { stdout: "important" } } });

  const job = listJobs(workspace).find((entry) => entry.id === "fresh");
  assert.ok(job, "the just-completed job is the ONLY evictable record but must not be pruned");
  assert.equal(job.status, "completed");
  assert.equal(fs.existsSync(resolveJobFile(workspace, "fresh")), true);
});

test("legacy state.json jobs[] array migrates to per-job files on read", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const legacy = {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [
      { id: "old-a", status: "completed", sessionId: "s", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "old-b", status: "failed", sessionId: "s", updatedAt: "2026-01-01T00:01:00.000Z" }
    ]
  };
  fs.writeFileSync(resolveStateFile(workspace), JSON.stringify(legacy, null, 2));

  const ids = new Set(listJobs(workspace).map((job) => job.id));
  assert.equal(ids.has("old-a"), true);
  assert.equal(ids.has("old-b"), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "old-a")), true, "legacy entry materialized as a per-job file");

  // state.json is rewritten config-only (no jobs array left to re-migrate/resurrect).
  const rewritten = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.equal(Array.isArray(rewritten.jobs), false);
  assert.equal(rewritten.config.stopReviewGate, true);
});

test("a no-status patch (e.g. a progress update) leaves status untouched", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "running", pid: 42 });
  upsertJob(workspace, { id: "j", phase: "thinking" });

  const job = listJobs(workspace).find((entry) => entry.id === "j");
  assert.equal(job.status, "running");
  assert.equal(job.phase, "thinking");
});

test("a cancel marker overlays as cancelled and cannot be resurrected by a later running write", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "queued", pid: null });
  assert.equal(markJobCancelled(workspace, "j", "test"), true, "marker created");

  // A racing worker publishes running AFTER the marker (the record itself says running):
  upsertJob(workspace, { id: "j", status: "running", pid: 99, phase: "starting" });

  const job = listJobs(workspace).find((entry) => entry.id === "j");
  assert.equal(job.status, "cancelled", "the immutable marker overlays the record");
  assert.equal(job.pid, null, "an overlaid-cancelled job exposes no live pid");
  assert.equal(isJobCancelled(workspace, "j"), true);
});

test("the cancel marker is immutable: a second mark is a no-op, not an error", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "running", pid: 1 });
  assert.equal(markJobCancelled(workspace, "j", "first"), true);
  assert.equal(markJobCancelled(workspace, "j", "second"), false, "already marked -> false, no throw");
});

test("a completion that lands after a cancel marker still reads as cancelled", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "running", pid: 5 });
  markJobCancelled(workspace, "j", "cancelled by user");
  upsertJob(workspace, { id: "j", status: "completed", summary: "done" });

  const job = listJobs(workspace).find((entry) => entry.id === "j");
  assert.equal(job.status, "cancelled", "cancellation wins over a later completion via the overlay");
});

test("normal forward transitions still advance (queued -> running -> completed)", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "queued", pid: null });
  upsertJob(workspace, { id: "j", status: "running", pid: 7 });
  const done = upsertJob(workspace, { id: "j", status: "completed" });
  assert.equal(done.status, "completed");
});

test("a no-status progress patch advances phase without touching status", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "running", pid: 7, phase: "starting" });
  const after = upsertJob(workspace, { id: "j", phase: "thinking" });
  assert.equal(after.status, "running");
  assert.equal(after.phase, "thinking", "phase update must not be dropped");
});

test("session-ended marker is create-once and observable", () => {
  const workspace = makeTempDir();
  assert.equal(isSessionEnded(workspace, "s1"), false);
  assert.equal(markSessionEnded(workspace, "s1"), true, "first mark creates it");
  assert.equal(markSessionEnded(workspace, "s1"), false, "second mark is a no-op");
  assert.equal(isSessionEnded(workspace, "s1"), true);
  assert.equal(isSessionEnded(workspace, "s2"), false, "unrelated session is unaffected");
});

test("readJobPid returns the raw record pid (not overlaid) so a canceller can kill after marking", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "j", status: "running", pid: 4321 });
  assert.equal(readJobPid(workspace, "j"), 4321);
  // After marking, listJobs overlays pid:null, but the RAW pid is still readable to kill.
  markJobCancelled(workspace, "j", "test");
  assert.equal(readJobPid(workspace, "j"), 4321, "raw pid survives the overlay");
  assert.equal(listJobs(workspace).find((e) => e.id === "j").pid, null, "overlay hides the pid from readers");
});

test("legacy migration folds index-only metadata into an existing FINISHED per-job file", () => {
  const workspace = makeTempDir();
  // A finished per-job payload already exists but lacks the index-only fields.
  writeJobFile(workspace, "review-done", { id: "review-done", status: "completed", title: "Review" });
  fs.writeFileSync(
    resolveStateFile(workspace),
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "review-done",
          status: "completed",
          title: "Review",
          summary: "found 2 issues",
          threadId: "thr_abc",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z"
        }
      ]
    }, null, 2)
  );

  const job = listJobs(workspace).find((entry) => entry.id === "review-done");
  assert.equal(job.status, "completed");
  assert.equal(job.summary, "found 2 issues", "index-only summary is merged in, not lost");
  assert.equal(job.threadId, "thr_abc", "index-only threadId is merged in");
  assert.equal(job.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(job.completedAt, "2026-01-01T00:01:00.000Z");
});

test("legacy migration does NOT overwrite a LIVE (running, live-pid) per-job file", () => {
  const workspace = makeTempDir();
  // A running job owned by THIS (alive) process; its worker is the sole writer.
  writeJobFile(workspace, "live", { id: "live", status: "running", pid: process.pid, phase: "thinking" });
  fs.writeFileSync(
    resolveStateFile(workspace),
    JSON.stringify({
      version: 1,
      config: {},
      jobs: [{ id: "live", status: "queued", phase: "queued", summary: "stale index" }]
    }, null, 2)
  );

  const job = listJobs(workspace).find((entry) => entry.id === "live");
  assert.equal(job.status, "running", "a live worker's record is never reverted by a stale index");
  assert.equal(job.phase, "thinking");
});

test("cancel overlay strips result/rendered and surfaces the marker's reason + timestamp", () => {
  const workspace = makeTempDir();
  // A job that finished (has result/rendered) and is THEN cancel-marked.
  upsertJob(workspace, {
    id: "j",
    status: "completed",
    result: { codex: { stdout: "secret output" } },
    rendered: "full rendered output"
  });
  assert.equal(markJobCancelled(workspace, "j", "Cancelled by user."), true);

  const job = listJobs(workspace).find((entry) => entry.id === "j");
  assert.equal(job.status, "cancelled");
  assert.equal(job.result, undefined, "result payload is stripped from a cancelled job");
  assert.equal(job.rendered, undefined, "rendered output is stripped from a cancelled job");
  assert.equal(job.errorMessage, "Cancelled by user.", "marker reason surfaces as errorMessage");
  assert.ok(job.cancelledAt, "marker timestamp surfaces as cancelledAt");
});
