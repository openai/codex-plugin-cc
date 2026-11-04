import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

test("concurrent readers see complete state and job snapshots during progress updates", { timeout: 15000 }, async (t) => {
  const workspace = makeTempDir();
  const job = { id: "progress", status: "running", details: "x".repeat(128 * 1024) };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  const stateFile = resolveStateFile(workspace);
  const jobFile = resolveJobFile(workspace, job.id);
  const moduleUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { upsertJob, writeJobFile } from ${JSON.stringify(moduleUrl)};
    const workspace = ${JSON.stringify(workspace)};
    for (let progress = 0; progress < 16; progress++) {
      const job = { id: "progress", status: "running", details: "x".repeat(128 * 1024), progress };
      writeJobFile(workspace, job.id, job);
      upsertJob(workspace, job);
    }
  `], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  writer.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = once(writer, "close");
  t.after(async () => {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    await closed;
  });
  let snapshots = 0;
  while (writer.exitCode === null && writer.signalCode === null) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    assert.equal(state.jobs[0].details.length, job.details.length);
    assert.equal(stored.details.length, job.details.length);
    snapshots++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.ok(snapshots > 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs[0].progress, 15);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).progress, 15);
});

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
