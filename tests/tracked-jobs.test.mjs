import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_JOBS_URL = pathToFileURL(
  path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs")
).href;
const STATE_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "state.mjs")).href;

const STDERR_FAILURE_RUN = [
  'import fs from "node:fs";',
  'const tracked = await import(process.env.TRACKED_JOBS_URL);',
  'const state = await import(process.env.STATE_URL);',
  'const workspaceRoot = process.env.TEST_WORKSPACE;',
  'const job = { id: "review-stderr-failure", title: "Codex Review", jobClass: "review", workspaceRoot };',
  'const logFile = tracked.createJobLogFile(workspaceRoot, job.id, job.title);',
  'const updateProgress = tracked.createJobProgressUpdater(workspaceRoot, job.id);',
  'let eventCount = 0;',
  'let stderrWrites = 0;',
  'let durableBeforeFirstStderrWrite = false;',
  'process.stderr.write = function patchedWrite() {',
  '  stderrWrites += 1;',
  '  if (stderrWrites === 1) {',
  '    const storedAtWrite = state.readJobFile(state.resolveJobFile(workspaceRoot, job.id));',
  '    durableBeforeFirstStderrWrite = storedAtWrite.phase === "reviewing" && fs.readFileSync(logFile, "utf8").includes("Durable progress one.");',
  '  }',
  '  const callback = Array.from(arguments).find((value) => typeof value === "function");',
  '  const error = Object.assign(new Error("broken stderr pipe"), { code: "EPIPE" });',
  '  if (process.env.STDERR_FAILURE_MODE === "sync") throw error;',
  '  process.nextTick(() => {',
  '    if (callback) callback(error);',
  '    process.stderr.emit("error", error);',
  '  });',
  '  return false;',
  '};',
  'const progress = tracked.createProgressReporter({',
  '  stderr: true,',
  '  logFile,',
  '  onEvent(event) { eventCount += 1; updateProgress(event); }',
  '});',
  'const execution = await tracked.runTrackedJob(job, async () => {',
  '  progress({ message: "Durable progress one.", phase: "reviewing" });',
  '  await new Promise((resolve) => setImmediate(resolve));',
  '  progress({ message: "Durable progress two.", phase: "finalizing" });',
  '  return { exitStatus: 0, payload: { ok: true }, rendered: "done\\n", summary: "done" };',
  '}, { logFile });',
  'const storedJob = state.readJobFile(state.resolveJobFile(workspaceRoot, job.id));',
  'process.stdout.write(JSON.stringify({',
  '  eventCount,',
  '  stderrWrites,',
  '  durableBeforeFirstStderrWrite,',
  '  exitStatus: execution.exitStatus,',
  '  storedStatus: storedJob.status,',
  '  log: fs.readFileSync(logFile, "utf8")',
  '}));'
].join("\n");

test("progress reporter keeps runs durable across synchronous and asynchronous stderr failures", () => {
  for (const failureMode of ["sync", "async"]) {
    const workspace = makeTempDir();
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", STDERR_FAILURE_RUN], {
      cwd: ROOT,
      env: {
        ...process.env,
        STDERR_FAILURE_MODE: failureMode,
        TEST_WORKSPACE: workspace,
        TRACKED_JOBS_URL,
        STATE_URL
      },
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true
    });

    assert.notEqual(result.error?.code, "ETIMEDOUT");
    assert.equal(result.status, 0, `${failureMode}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.eventCount, 2);
    assert.equal(payload.stderrWrites, 1);
    assert.equal(payload.durableBeforeFirstStderrWrite, true);
    assert.equal(payload.exitStatus, 0);
    assert.equal(payload.storedStatus, "completed");
    assert.match(payload.log, /Durable progress one\./);
    assert.match(payload.log, /Durable progress two\./);
    assert.match(payload.log, /Final output/);
  }
});

test("progress reporters share one stderr error listener", () => {
  const source = [
    'const { createProgressReporter } = await import(process.env.TRACKED_JOBS_URL);',
    'const before = process.stderr.listenerCount("error");',
    'for (let index = 0; index < 100; index += 1) {',
    '  createProgressReporter({ stderr: true, onEvent() {} });',
    '}',
    'const after = process.stderr.listenerCount("error");',
    'process.stdout.write(JSON.stringify({ before, after }));'
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: ROOT,
    env: {
      ...process.env,
      TRACKED_JOBS_URL
    },
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.after - payload.before, 1);
});
