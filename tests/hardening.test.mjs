import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { MAX_ENVELOPE_STDOUT_BYTES } from "../plugins/codex/scripts/lib/envelope.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function writePromptFile(dir, text) {
  const promptPath = path.join(dir, "consult-prompt.md");
  fs.writeFileSync(promptPath, text, "utf8");
  return promptPath;
}

test("consult reads the exact prompt from --prompt-file and ignores inherited stdin", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const promptPath = writePromptFile(repo, "Is the retry loop idempotent?\nExplain briefly.");

  const result = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--json"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "THIS STDIN MUST NEVER REACH CODEX"
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.prompt, "Is the retry loop idempotent?\nExplain briefly.");
  assert.equal(state.lastTurnStart.prompt.includes("THIS STDIN MUST NEVER REACH CODEX"), false);
});

test("consult returns a bounded envelope with a verdict, tally, and on-disk paths", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const promptPath = writePromptFile(repo, "Give me a second opinion on this plan.");

  const result = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--model", "gpt-5.6-luna", "--effort", "high", "--timeout-ms", "420000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout, "utf8") < MAX_ENVELOPE_STDOUT_BYTES, true);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.kind, "consult");
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.verdict, "approve");
  assert.deepEqual(envelope.severity_tally, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(envelope.finding_count, 0);
  assert.equal(typeof envelope.duration_ms, "number");
  assert.equal(typeof envelope.queue_wait_ms, "number");
  assert.equal(fs.existsSync(envelope.final_output_path), true);
  assert.equal(fs.existsSync(envelope.log_path), true);

  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(state.lastTurnStart.effort, "high");
});

test("consult always uses a fresh ephemeral thread and cannot resume", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const promptPath = writePromptFile(repo, "First question.");
  const env = buildEnv(binDir);

  run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--json"], { cwd: repo, env });
  run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--json"], { cwd: repo, env });

  const state = readFakeState(binDir);
  assert.equal(state.threads.length, 2);
  for (const thread of state.threads) {
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.name, null);
  }

  const resumed = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--resume-last"], { cwd: repo, env });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /only from --prompt-file/);
});

test("consult --write is rejected before anything joins the queue", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const promptPath = writePromptFile(repo, "Please edit my files.");

  const result = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--write"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /read-only and does not accept --write/);
  assert.equal(fs.existsSync(path.join(binDir, "scheduler", "queue")), false);
});

test("consult requires a prompt file instead of a positional prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "consult", "what do you think?"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --prompt-file/);
});

test("consult runs in a non-Git directory without any caller-supplied flag", () => {
  const scratch = makeTempDir("codex-non-git-");
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const promptPath = writePromptFile(scratch, "Review this idea from a scratch directory.");

  assert.equal(fs.existsSync(path.join(scratch, ".git")), false);
  const result = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--cwd", scratch, "--json"], {
    cwd: scratch,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.final_output_path.startsWith(path.sep) || /^[A-Za-z]:/.test(envelope.final_output_path), true);
});

test("consult returns inconclusive when Codex output cannot be parsed", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "invalid-json");
  initGitRepo(repo);
  const promptPath = writePromptFile(repo, "Second opinion please.");

  const result = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.verdict, "inconclusive");
  assert.equal(typeof envelope.parse_error, "string");
});

test("an expired deadline interrupts the turn, stores a timed-out job, and releases the lease", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const timedOut = run("node", [SCRIPT, "task", "--timeout-ms", "600", "investigate the slow path"], {
    cwd: repo,
    env
  });

  assert.equal(timedOut.status, 124, timedOut.stderr);
  const interrupted = await waitFor(() => readFakeState(binDir).lastInterrupt ?? null, { timeoutMs: 5000 });
  assert.equal(typeof interrupted.turnId, "string");

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  const snapshot = JSON.parse(status.stdout);
  const job = snapshot.latestFinished;
  assert.equal(job.status, "timed-out");
  assert.equal(job.phase, "timed-out");
  assert.equal(snapshot.scheduler.active, null);
  assert.deepEqual(snapshot.scheduler.queue, []);

  // The lease is free again, so the next workload runs immediately.
  installFakeCodex(binDir);
  const promptPath = writePromptFile(repo, "Now answer quickly.");
  const consult = run("node", [SCRIPT, "consult", "--prompt-file", promptPath, "--json"], { cwd: repo, env });
  assert.equal(consult.status, 0, consult.stderr);
});

test("native review and adversarial review both produce the common envelope", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "const a = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "const a = 2;\n");
  const env = buildEnv(binDir);

  const native = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env });
  assert.equal(native.status, 0, native.stderr);
  const nativeEnvelope = JSON.parse(native.stdout).envelope;
  assert.equal(nativeEnvelope.kind, "review");
  assert.equal(nativeEnvelope.status, "completed");
  assert.deepEqual(nativeEnvelope.severity_tally, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(fs.existsSync(nativeEnvelope.final_output_path), true);

  const adversarial = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd: repo, env });
  assert.equal(adversarial.status, 0, adversarial.stderr);
  const adversarialEnvelope = JSON.parse(adversarial.stdout).envelope;
  assert.equal(adversarialEnvelope.kind, "adversarial-review");
  assert.equal(adversarialEnvelope.verdict, "needs-attention");
  assert.deepEqual(adversarialEnvelope.severity_tally, { critical: 0, high: 1, medium: 0, low: 0 });
  assert.equal(adversarialEnvelope.finding_count, 1);
  assert.equal(adversarialEnvelope.findings_preview[0].file, "src/app.js");
});

test("result returns the bounded envelope by default and the full answer with --full", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "const a = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "const a = 2;\n");
  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd: repo, env });
  const jobId = JSON.parse(review.stdout).envelope.job_id;

  const summary = run("node", [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Verdict: needs-attention/);
  assert.match(summary.stdout, /Findings: 1 \(critical 0, high 1, medium 0, low 0\)/);
  assert.equal(summary.stdout.includes("The change assumes data is always present."), false);
  assert.equal(Buffer.byteLength(summary.stdout, "utf8") < MAX_ENVELOPE_STDOUT_BYTES, true);

  const full = run("node", [SCRIPT, "result", jobId, "--full"], { cwd: repo, env });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /The change assumes data is always present\./);

  const asJson = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
  const envelope = JSON.parse(asJson.stdout);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.verdict, "needs-attention");
});

test("the stop-gate review runs under its own deadline inside a longer hook guard", () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs"), "utf8");

  assert.match(source, /STOP_REVIEW_EXECUTION_TIMEOUT_MS = 14 \* 60 \* 1000/);
  assert.match(source, /"--timeout-ms", String\(STOP_REVIEW_EXECUTION_TIMEOUT_MS\)/);
  assert.match(source, /STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_EXECUTION_TIMEOUT_MS \+ 60 \* 1000/);
});

test("no plugin-owned codex exec launch site inherits the parent stdin", () => {
  const scriptsDir = path.join(PLUGIN_ROOT, "scripts");
  const files = fs
    .readdirSync(scriptsDir, { recursive: true })
    .filter((entry) => String(entry).endsWith(".mjs"))
    .map((entry) => path.join(scriptsDir, String(entry)));

  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const segments = source.split(/spawnSync\(|spawn\(/).slice(1);
    for (const segment of segments) {
      const call = segment.slice(0, 600);
      const launchesCodexExec = /["']codex["']/.test(call) && /["']exec["']/.test(call);
      if (!launchesCodexExec) {
        continue;
      }
      if (!/stdio:\s*\[\s*["']ignore["']/.test(call)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
  }

  assert.deepEqual(offenders, []);
});
