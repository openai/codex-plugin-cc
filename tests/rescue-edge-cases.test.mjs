import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

// ---------------------------------------------------------------------------
// 1. Graceful output when codex returns empty stdout
// ---------------------------------------------------------------------------

test("task renders a fallback message when codex returns empty stdout", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "empty-stdout");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello\n");
  run("git", ["add", "hello.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "do something"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // The script should still exit successfully (turn completed) but show a
  // meaningful fallback instead of blank output.
  const output = result.stdout.trim();
  assert.ok(output.length > 0, "stdout must not be empty when codex returns empty output");
  assert.ok(
    output.includes("did not return") || output.includes("Codex"),
    `Expected a fallback message, got: ${output}`
  );
});

// ---------------------------------------------------------------------------
// 2. Correct error message surfaced when exit code is non-zero
// ---------------------------------------------------------------------------

test("formatCommandFailure includes exit code and stderr", async () => {
  const { formatCommandFailure } = await import(
    "../plugins/codex/scripts/lib/process.mjs"
  );

  const result = {
    command: "codex",
    args: ["app-server"],
    status: 1,
    signal: null,
    stdout: "",
    stderr: "authentication failed",
    error: null
  };

  const message = formatCommandFailure(result);
  assert.match(message, /exit=1/, "should include exit code");
  assert.match(message, /authentication failed/, "should include stderr text");
});

test("formatCommandFailure prefers stderr over stdout", async () => {
  const { formatCommandFailure } = await import(
    "../plugins/codex/scripts/lib/process.mjs"
  );

  const result = {
    command: "codex",
    args: ["task"],
    status: 2,
    signal: null,
    stdout: "some output",
    stderr: "real error here",
    error: null
  };

  const message = formatCommandFailure(result);
  assert.match(message, /real error here/, "should prefer stderr");
  assert.ok(!message.includes("some output"), "should not include stdout when stderr is present");
});

test("formatCommandFailure includes signal when process is killed", async () => {
  const { formatCommandFailure } = await import(
    "../plugins/codex/scripts/lib/process.mjs"
  );

  const result = {
    command: "codex",
    args: ["app-server"],
    status: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    error: null
  };

  const message = formatCommandFailure(result);
  assert.match(message, /signal=SIGKILL/, "should include signal name");
});

test("runCommandChecked throws on non-zero exit code with formatted message", async () => {
  const { runCommandChecked } = await import(
    "../plugins/codex/scripts/lib/process.mjs"
  );

  assert.throws(
    () => runCommandChecked("node", ["-e", "process.exit(42)"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /exit=42/, "error message should include exit code");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Timeout / stall handling — codex stalls and the companion surfaces the
//    partial state gracefully
// ---------------------------------------------------------------------------

test("task with slow-task behavior still completes when codex eventually responds", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello\n");
  run("git", ["add", "hello.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "do something slow"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, `Expected exit 0, stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("Task prompt accepted"), "should contain task output despite delay");
});

test("task cancel interrupts a running codex turn", () => {
  // Use the interruptible-slow-task behavior which sets up a 5s delay but
  // responds to turn/interrupt.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello\n");
  run("git", ["add", "hello.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Start a task in the background, then cancel it immediately.
  const startResult = run(
    "node",
    [SCRIPT, "task", "--background", "--write", "slow task"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(startResult.status, 0, `background start failed: ${startResult.stderr}`);

  // Extract job id from the output.
  const jobIdMatch = startResult.stdout.match(/task-\w+/);
  assert.ok(jobIdMatch, `Could not find job id in output: ${startResult.stdout}`);
  const jobId = jobIdMatch[0];

  // Give the background worker a moment to start, then cancel.
  const cancelResult = run("node", [SCRIPT, "cancel", jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // Cancel should succeed — it terminates the process tree and marks the job.
  assert.equal(cancelResult.status, 0, `cancel failed: ${cancelResult.stderr}`);
  assert.ok(
    cancelResult.stdout.includes("cancelled") || cancelResult.stdout.includes("Cancelled"),
    `cancel output should confirm cancellation: ${cancelResult.stdout}`
  );
});

// ---------------------------------------------------------------------------
// 4. Edge case: parseStructuredOutput handles empty / invalid input
// ---------------------------------------------------------------------------

test("parseStructuredOutput returns fallback for empty string", async () => {
  const { parseStructuredOutput } = await import(
    "../plugins/codex/scripts/lib/codex.mjs"
  );

  const result = parseStructuredOutput("", { failureMessage: "custom fallback" });
  assert.equal(result.parsed, null);
  assert.equal(result.parseError, "custom fallback");
  assert.equal(result.rawOutput, "");
});

test("parseStructuredOutput returns fallback for null input", async () => {
  const { parseStructuredOutput } = await import(
    "../plugins/codex/scripts/lib/codex.mjs"
  );

  const result = parseStructuredOutput(null);
  assert.equal(result.parsed, null);
  assert.ok(result.parseError.length > 0, "should have a non-empty error message");
  assert.equal(result.rawOutput, "");
});

test("parseStructuredOutput returns parse error for invalid JSON", async () => {
  const { parseStructuredOutput } = await import(
    "../plugins/codex/scripts/lib/codex.mjs"
  );

  const result = parseStructuredOutput("not valid json {{{");
  assert.equal(result.parsed, null);
  assert.ok(result.parseError.length > 0, "should report the JSON parse error");
  assert.equal(result.rawOutput, "not valid json {{{");
});

test("parseStructuredOutput parses valid JSON", async () => {
  const { parseStructuredOutput } = await import(
    "../plugins/codex/scripts/lib/codex.mjs"
  );

  const input = JSON.stringify({ verdict: "approve", summary: "ok" });
  const result = parseStructuredOutput(input);
  assert.deepEqual(result.parsed, { verdict: "approve", summary: "ok" });
  assert.equal(result.parseError, null);
  assert.equal(result.rawOutput, input);
});

// ---------------------------------------------------------------------------
// 5. Edge case: binaryAvailable reports correct status for missing binaries
// ---------------------------------------------------------------------------

test("binaryAvailable returns not-found for missing binary", async () => {
  const { binaryAvailable } = await import(
    "../plugins/codex/scripts/lib/process.mjs"
  );

  const result = binaryAvailable("__nonexistent_binary_12345__");
  assert.equal(result.available, false);
  assert.match(result.detail, /not found/);
});
