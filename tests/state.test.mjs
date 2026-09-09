import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";
import { loadState, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

beforeEach(isolateTestEnvironment);

test("concurrent job writers preserve both indices and artifacts", { timeout: 60000 }, async (t) => {
  const workspace = makeTempDir();
  const gate = path.join(workspace, "start");
  const source = `
    import fs from "node:fs";
    import { updateState, writeJobFile, resolveJobLogFile } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};
    const [workspace, id, gate] = process.argv.slice(1);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const logFile = resolveJobLogFile(workspace, id);
    writeJobFile(workspace, id, { id });
    fs.writeFileSync(logFile, id);
    fs.writeFileSync(gate + id, "ready");
    while (!fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10);
    for (let iteration = 0; iteration < 6; iteration += 1) {
      updateState(workspace, (state) => {
        Atomics.wait(wait, 0, 0, iteration === 0 ? 100 : 10);
        const job = { id, iteration, logFile };
        const index = state.jobs.findIndex((item) => item.id === id);
        if (index < 0) state.jobs.push(job);
        else state.jobs[index] = job;
      });
    }
  `;
  const workers = ["task-one", "task-two"].map((id) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, workspace, id, gate], { env: process.env });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Worker exited ${code}`)));
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { id, done };
  });
  while (!workers.every(({ id }) => fs.existsSync(gate + id))) {
    t.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(gate, "start");
  await Promise.all(workers.map(({ done }) => done));
  assert.deepEqual(loadState(workspace).jobs.map(({ id, iteration }) => ({ id, iteration })).sort((a, b) => a.id.localeCompare(b.id)),
    workers.map(({ id }) => ({ id, iteration: 5 })));
  for (const { id } of workers) {
    assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, id), "utf8")).id, id);
    assert.equal(fs.readFileSync(resolveJobLogFile(workspace, id), "utf8"), id);
  }
  assert.equal(fs.existsSync(path.join(resolveStateDir(workspace), "state.lock")), false);
});

test("state writes recover the lock of an exited writer", () => {
  const workspace = makeTempDir();
  const exited = run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  assert.equal(exited.status, 0, exited.stderr);
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.lock"), exited.stdout);
  upsertJob(workspace, { id: "recovered", status: "running" });
  assert.equal(loadState(workspace).jobs[0].id, "recovered");
  assert.equal(fs.existsSync(path.join(stateDir, "state.lock")), false);
});

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  delete process.env.CLAUDE_PLUGIN_DATA;
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
