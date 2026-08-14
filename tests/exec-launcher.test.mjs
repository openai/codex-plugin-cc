import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, writeExecutable } from "./helpers.mjs";
import {
  buildCodexExecArgs,
  describeExecOutcome,
  normalizeExitCode,
  runHardenedCodexExec
} from "../plugins/codex/scripts/lib/exec-launcher.mjs";

function installFakeExec(dir, body) {
  const scriptPath = path.join(dir, "fake-codex.mjs");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
${body}
});
`
  );
  return scriptPath;
}

function launcherOptions(dir, scriptPath, overrides = {}) {
  const promptFile = path.join(dir, "prompt.txt");
  fs.writeFileSync(promptFile, "Answer this exact question.\n", "utf8");
  return {
    command: scriptPath,
    cwd: dir,
    promptFile,
    outputFile: path.join(dir, "final.md"),
    logFile: path.join(dir, "run.log"),
    schedulerDir: path.join(dir, "scheduler"),
    jobId: "exec-test",
    timeoutMs: 15000,
    ...overrides
  };
}

test("the hardened launcher never leaves the child waiting on inherited stdin", async () => {
  const dir = makeTempDir("codex-exec-");
  const scriptPath = installFakeExec(
    dir,
    `  if (outputFile) { fs.writeFileSync(outputFile, "received:" + prompt.trim() + "\\n"); }
  process.exit(0);`
  );

  const options = launcherOptions(dir, scriptPath);
  const result = await runHardenedCodexExec(options);

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.finalOutput, /^received:Answer this exact question\.$/);
  assert.equal(describeExecOutcome(result), "Codex completed.");
});

test("a signal-terminated run is normalized into a non-zero exit and a readable outcome", async () => {
  const dir = makeTempDir("codex-exec-");
  const scriptPath = installFakeExec(dir, `  process.kill(process.pid, "SIGTERM");`);

  const result = await runHardenedCodexExec(launcherOptions(dir, scriptPath));

  assert.equal(result.signal, "SIGTERM");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.finalOutput, "");
  assert.match(describeExecOutcome(result), /terminated by SIGTERM/);
});

test("an over-running child is killed at the deadline and reported as timed out", async () => {
  const dir = makeTempDir("codex-exec-");
  const scriptPath = installFakeExec(dir, `  setTimeout(() => process.exit(0), 30000);`);

  const result = await runHardenedCodexExec(launcherOptions(dir, scriptPath, { timeoutMs: 600 }));

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(describeExecOutcome(result), /deadline expired/);
});

test("a SIGTERM-resistant child is escalated to SIGKILL after the grace period", async () => {
  const dir = makeTempDir("codex-exec-");
  const scriptPath = installFakeExec(
    dir,
    `  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);`
  );

  const startedAt = Date.now();
  const result = await runHardenedCodexExec(
    launcherOptions(dir, scriptPath, { timeoutMs: 400, killGraceMs: 400 })
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(elapsed < 10000, true, `the deadline took ${elapsed}ms to take effect`);
});

test("exit codes keep signals visible", () => {
  assert.equal(normalizeExitCode(0, null), 0);
  assert.equal(normalizeExitCode(2, null), 2);
  assert.notEqual(normalizeExitCode(null, "SIGTERM"), 0);
  assert.equal(normalizeExitCode(null, null), 0);
});

test("--skip-git-repo-check is added only outside a Git worktree unless overridden", () => {
  const repo = makeTempDir("codex-exec-repo-");
  initGitRepo(repo);
  const scratch = makeTempDir("codex-exec-scratch-");

  assert.equal(buildCodexExecArgs({ cwd: repo }).args.includes("--skip-git-repo-check"), false);
  assert.equal(buildCodexExecArgs({ cwd: scratch }).args.includes("--skip-git-repo-check"), true);
  assert.equal(buildCodexExecArgs({ cwd: repo, skipGitRepoCheck: true }).args.includes("--skip-git-repo-check"), true);
  assert.equal(buildCodexExecArgs({ cwd: scratch, skipGitRepoCheck: false }).skipGitRepoCheck, false);

  const { args } = buildCodexExecArgs({ cwd: repo, model: "gpt-5.6-luna", effort: "high", outputFile: "/tmp/out.md" });
  assert.deepEqual(args, [
    "exec",
    "-m",
    "gpt-5.6-luna",
    "-s",
    "read-only",
    "-c",
    "model_reasoning_effort=high",
    "-o",
    "/tmp/out.md",
    "-"
  ]);
});
