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
  listJobs,
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
  // The two oldest *terminal* jobs are evicted (done-00, done-01), payload + log.
  assert.equal(ids.has("done-00"), false);
  assert.equal(ids.has("done-01"), false);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "done-00")), false, "evicted job's log is removed too");
  assert.equal(ids.has("done-02"), true, "newer terminal jobs are kept");
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
