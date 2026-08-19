import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

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

test("loadState rejects invalid state JSON with its absolute path and parse detail", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{invalid json", "utf8");

  assert.throws(
    () => loadState(workspace),
    (error) =>
      error instanceof Error &&
      error.message.includes(stateFile) &&
      error.message.startsWith("Failed to read Codex Companion state at ") &&
      /Unexpected|Expected/.test(error.message)
  );
});

test("loadState rejects parsed state with an invalid schema", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: { stopReviewGate: "yes" }, jobs: {} }), "utf8");

  assert.throws(() => loadState(workspace), /Failed to read Codex Companion state.*invalid state schema/);
});

test("state and job writes leave valid JSON without sibling temporary artifacts", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobFile = writeJobFile(workspace, "job-atomic", { id: "job-atomic", status: "queued" });

  saveState(workspace, {
    config: { stopReviewGate: true },
    jobs: [{ id: "job-atomic", status: "queued" }]
  });

  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).config.stopReviewGate, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, "utf8")), { id: "job-atomic", status: "queued" });
  assert.deepEqual(
    fs.readdirSync(path.dirname(stateFile)).filter((entry) => entry.startsWith(`${path.basename(stateFile)}.`)),
    []
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(jobFile)).filter((entry) => entry.startsWith(`${path.basename(jobFile)}.`)),
    []
  );
});

test("saveState reaps a lock left by a dead owner", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, ".state.lock"), JSON.stringify({ pid: 999999, token: "dead-owner", createdAt: "2026-08-19T12:00:00.000Z" }), "utf8");

  saveState(workspace, { config: { stopReviewGate: false }, jobs: [] });

  assert.equal(fs.existsSync(path.join(stateDir, ".state.lock")), false);
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
    if (jobId === "job-0") {
      fs.writeFileSync(jobFile.replace(/\.json$/, ".started.json"), JSON.stringify({ status: "running", pid: 999999 }), "utf8");
      fs.writeFileSync(jobFile.replace(/\.json$/, ".admission.json"), JSON.stringify({ status: "admitted" }), "utf8");
      fs.writeFileSync(jobFile.replace(/\.json$/, ".terminal.json"), JSON.stringify({ status: "completed" }), "utf8");
    }
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
      .concat("job-0.removed")
      .sort()
  );
});

test("saveState retains a removal fence for a pruned job before it starts", () => {
  const workspace = makeTempDir();
  const job = { id: "job-prestart", status: "queued", logFile: resolveJobLogFile(workspace, "job-prestart") };
  writeJobFile(workspace, job.id, job);
  fs.writeFileSync(job.logFile, "queued\n", "utf8");
  saveState(workspace, { config: { stopReviewGate: false }, jobs: [job] });

  saveState(workspace, { config: { stopReviewGate: false }, jobs: [] });

  const jobFile = resolveJobFile(workspace, job.id);
  assert.equal(fs.existsSync(jobFile), false);
  assert.equal(fs.existsSync(job.logFile), false);
  assert.equal(fs.existsSync(jobFile.replace(/\.json$/, ".removed")), true);
});
