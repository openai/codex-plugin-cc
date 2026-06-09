import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { setupFakeCodex } from "./fake-codex-fixture.mjs";
import { runAppServerInvestigation } from "../plugins/codex/scripts/lib/codex.mjs";
import { makeTempDir } from "./helpers.mjs";

// Structured JSON payloads used by multiple tests.
const STRUCTURED_REVIEW = JSON.stringify({
  verdict: "needs-attention",
  summary: "Concern X.",
  findings: [{
    severity: "high",
    title: "Race",
    file: "a.js",
    line_start: 10,
    line_end: 12,
    confidence: 0.8,
    body: "Potential race condition.",
    recommendation: "Add a mutex."
  }],
  next_steps: []
});

const APPROVE_REVIEW = JSON.stringify({
  verdict: "approve",
  summary: "No material issues found.",
  findings: [],
  next_steps: []
});

test("converges when Codex emits a final-answer turn with no commands", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands, no final answer
    fake.queueTurnResponse({
      commands: [{ command: "git diff HEAD~1", exitCode: 0 }],
      finalAnswer: null
    });
    // Recon turn 2: no commands, final answer => converges
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // Finalize turn 3
    fake.queueTurnResponse({
      finalAnswer: { text: STRUCTURED_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate the changes.",
      finalizePrompt: "Produce your structured verdict.",
      outputSchema: { type: "object", required: ["verdict"] }
    });

    assert.equal(result.investigation.turnCount, 2);
    assert.equal(result.investigation.truncated, false);

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3, "should have 3 turn/start requests (2 recon + 1 finalize)");
  } finally {
    fake.close();
  }
});

test("converges when agentMessage has no `final_answer` phase tag (real-world case)", async () => {
  // In production, recon turns run with outputSchema=null, and the
  // app-server does NOT always tag agent messages with phase="final_answer".
  // The convergence detector must treat any 0-command turn that emits an
  // agent message as convergence — otherwise the model keeps insisting it
  // has converged but the loop refuses to stop.
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      commands: [{ command: "git diff HEAD~1", exitCode: 0 }],
      finalAnswer: null
    });
    // Recon turn 2: no commands, agent message WITHOUT final_answer phase
    // => must still converge (this is what real codex sends in recon mode).
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "My investigation is complete.", phase: "agent_message" }
    });
    fake.queueTurnResponse({
      finalAnswer: { text: STRUCTURED_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] }
    });

    assert.equal(result.investigation.turnCount, 2,
      "convergence on the no-command + agentMessage turn must not be missed");
    assert.equal(result.investigation.truncated, false);

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3, "2 recon + 1 finalize");
  } finally {
    fake.close();
  }
});

test("respects maxInvestigationTurns and marks truncated", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Queue 3 recon turns: all have commands, no final answer.
    // (With maxInvestigationTurns=3 the loop will exhaust here.)
    for (let i = 0; i < 3; i++) {
      fake.queueTurnResponse({
        commands: [{ command: `check-${i}`, exitCode: 0 }]
      });
    }
    // Finalize turn: pure JSON, zero commands.
    fake.queueTurnResponse({
      finalAnswer: { text: APPROVE_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      maxInvestigationTurns: 3
    });

    assert.equal(result.investigation.turnCount, 3);
    assert.equal(result.investigation.truncated, true);

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 4, "3 recon + 1 finalize");
  } finally {
    fake.close();
  }
});

test("turn with both finalAnswer and commands does not converge", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands AND final answer => does NOT converge
    fake.queueTurnResponse({
      commands: [{ command: "grep -r TODO", exitCode: 0 }],
      finalAnswer: { text: "Partial finding." }
    });
    // Recon turn 2: only final answer, no commands => converges
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // Finalize turn
    fake.queueTurnResponse({
      finalAnswer: { text: APPROVE_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize."
    });

    assert.equal(result.investigation.turnCount, 2);
    assert.equal(result.investigation.truncated, false);
  } finally {
    fake.close();
  }
});

test("outputSchema is null on recon turns and set on finalize turn", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands
    fake.queueTurnResponse({
      commands: [{ command: "cat file.js", exitCode: 0 }]
    });
    // Recon turn 2: final answer, no commands => converges
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Done investigating." }
    });
    // Finalize turn
    fake.queueTurnResponse({
      finalAnswer: { text: STRUCTURED_REVIEW }
    });

    const schema = { type: "object", required: ["verdict"] };
    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: schema
    });

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3);

    // Recon turns must have outputSchema === null
    assert.equal(starts[0].params.outputSchema, null, "recon turn 1 outputSchema should be null");
    assert.equal(starts[1].params.outputSchema, null, "recon turn 2 outputSchema should be null");

    // Finalize turn must have the schema
    assert.deepEqual(starts[2].params.outputSchema, schema, "finalize turn should have the outputSchema");
  } finally {
    fake.close();
  }
});

test("phase-1 soft error (turn/failed) aborts before phase-2 finalize", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands, normal
    fake.queueTurnResponse({
      commands: [{ command: "git log --oneline", exitCode: 0 }]
    });
    // Recon turn 2: soft error
    fake.queueTurnResponse({
      turnError: { message: "model produced unrenderable response" }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize."
    });

    assert.ok(result.error, "result should have an error");
    assert.match(result.error.message, /model produced unrenderable response/);
    assert.equal(result.investigation.turnCount, 2, "soft-error turn IS counted");
    // A turn/completed with status="completed" can still arrive after an
    // error notification, so result.status must be derived from the error,
    // not from finalTurn.status. CI/automation relies on this.
    assert.equal(result.status, 1, "soft-error path returns numeric status 1");

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 2, "NO finalize turn should be attempted");
  } finally {
    fake.close();
  }
});

test("phase-1 hard error (transport throw) aborts before phase-2 finalize", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands, normal
    fake.queueTurnResponse({
      commands: [{ command: "git status", exitCode: 0 }]
    });
    // Recon turn 2: RPC error (transport throw)
    fake.queueTurnRpcError({ message: "ECONNRESET" });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize."
    });

    assert.ok(result.error, "result should have an error");
    assert.match(result.error.message, /ECONNRESET/);
    assert.equal(result.investigation.turnCount, 1, "hard error returns BEFORE incrementing turnCount");
    assert.equal(result.status, 1, "transport-error path returns numeric status");

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 2, "the failing turn was still attempted");
  } finally {
    fake.close();
  }
});

test("turn that never responds is aborted by the idle timeout (no infinite hang)", async () => {
  // Production hang: turn 1 runs fine, then the next turn/start is sent but the
  // half-dead upstream never responds — no `turn/started`, no completion. The
  // RPC promise has no timeout, so the loop would await forever (observed as
  // "stuck at Investigation turn 2"). An idle timeout must abort it gracefully.
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: makes progress, does NOT converge (has commands).
    fake.queueTurnResponse({
      commands: [{ command: "git diff", exitCode: 0 }],
      finalAnswer: null
    });
    // Recon turn 2: the server receives turn/start but never responds.
    fake.queueTurnHang();

    const start = Date.now();
    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      turnIdleTimeoutMs: 300
    });
    const elapsed = Date.now() - start;

    assert.ok(result.error, "a timed-out run must carry an error");
    assert.match(result.error.message, /idle|timed out|timeout/i, "error should explain the idle timeout");
    assert.equal(result.status, 1, "idle-timeout path returns non-zero status");
    assert.ok(elapsed < 15000, `must abort promptly, not hang (took ${elapsed}ms)`);
  } finally {
    fake.close();
  }
});

test("a turn that keeps emitting progress is NOT killed by the idle timeout", async () => {
  // Regression guard: the idle timer must reset on every progress notification,
  // so a healthy turn running many commands (longer than the idle window in
  // aggregate, but never silent for that long) must not be aborted.
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Turn 1: several commands, then converges on turn 2 with a summary.
    fake.queueTurnResponse({
      commands: [
        { command: "c1", exitCode: 0 },
        { command: "c2", exitCode: 0 },
        { command: "c3", exitCode: 0 }
      ],
      finalAnswer: null
    });
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Done." } });
    fake.queueTurnResponse({ finalAnswer: { text: STRUCTURED_REVIEW } });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      turnIdleTimeoutMs: 300
    });

    assert.equal(result.error ?? null, null, "a healthy turn must not be timed out");
    assert.equal(result.finalMessage, STRUCTURED_REVIEW, "should reach finalize normally");
  } finally {
    fake.close();
  }
});

test("transient reconnect during recon recovers and still reaches finalize", async () => {
  // The app-server multiplexes transient retry notices ("Reconnecting... N/5")
  // onto the same `error` notification channel as fatal turn failures. A
  // reconnect that recovers still drives the turn to turn/completed with an
  // agent message. The loop must NOT treat that as a fatal abort — doing so
  // skips the schema-enforced finalize turn and hands the raw investigation
  // prose to the JSON parser (observed: `Unexpected token 'I', "Investigat"...`).
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: ran commands, hit a transient reconnect, still produced a
    // summary agent message and completed (i.e. it recovered).
    fake.queueTurnResponse({
      commands: [{ command: "git diff", exitCode: 0 }],
      finalAnswer: { text: "Investigation complete. I'm ready for finalization." },
      turnError: { message: "Reconnecting... 1/5" }
    });
    // Recon turn 2: 0 commands + agent message => converges.
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Confirmed, ready." }
    });
    // Finalize turn 3: structured JSON.
    fake.queueTurnResponse({
      finalAnswer: { text: STRUCTURED_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] }
    });

    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3, "should run 2 recon + 1 finalize (finalize NOT skipped)");
    assert.equal(result.finalMessage, STRUCTURED_REVIEW,
      "finalMessage should be the structured JSON, not the investigation prose");
  } finally {
    fake.close();
  }
});

test("finalize turn that runs commands triggers one strict-prompt retry", async () => {
  // Production observation: the model occasionally emits a tool-call stub
  // during finalize (e.g. {"cmd": "wc -l ..."}) instead of the structured
  // JSON. When that happens the finalize turn has commandExecutions.length > 0.
  // The orchestrator should detect this contract violation and retry once
  // with a stricter prompt.
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon: converge.
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // First finalize attempt: model misbehaves and runs a command.
    fake.queueTurnResponse({
      commands: [{ command: "wc -l README.md", exitCode: 0 }],
      finalAnswer: { text: "{\"cmd\":\"wc -l README.md\"}" }
    });
    // Second finalize attempt: model behaves and emits proper JSON.
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: APPROVE_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] }
    });

    assert.equal(result.finalMessage, APPROVE_REVIEW,
      "the second (well-behaved) finalize attempt should be the final message");
    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3, "1 recon + 2 finalize attempts");

    // The retry must use a stricter prompt distinct from the first try.
    const finalizeStarts = starts.slice(1); // first start is recon
    assert.match(
      finalizeStarts[1].params.input?.[0]?.text ?? "",
      /STRICT FINALIZE/,
      "retry prompt must include the stricter directive"
    );
    assert.doesNotMatch(
      finalizeStarts[0].params.input?.[0]?.text ?? "",
      /STRICT FINALIZE/,
      "first finalize attempt uses the normal prompt"
    );
  } finally {
    fake.close();
  }
});

test("finalize retry gives up after the second attempt and surfaces the output", async () => {
  // If the model misbehaves twice in a row, the orchestrator must not loop
  // forever — it should accept the second attempt's output and let the
  // upstream parser produce a useful validation error.
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // Both finalize attempts misbehave.
    fake.queueTurnResponse({
      commands: [{ command: "wc -l a", exitCode: 0 }],
      finalAnswer: { text: "{\"cmd\":\"wc -l a\"}" }
    });
    fake.queueTurnResponse({
      commands: [{ command: "wc -l b", exitCode: 0 }],
      finalAnswer: { text: "{\"cmd\":\"wc -l b\"}" }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] }
    });

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3, "1 recon + 2 finalize attempts only — no infinite loop");
    assert.equal(result.finalMessage, "{\"cmd\":\"wc -l b\"}",
      "the second-attempt output is surfaced so the parser can flag it");

    // The two finalize attempts ran one command each; neither should be
    // double-counted. (Regression: the final attempt was previously appended
    // both in-loop and after the loop, duplicating its command/file traces.)
    const cmds = result.commandExecutions.map((c) => c.command);
    assert.deepEqual(cmds, ["wc -l a", "wc -l b"],
      "each finalize attempt's commands recorded exactly once, no duplicates");
  } finally {
    fake.close();
  }
});

test("phase-2 finalize transport error preserves investigation metadata", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands
    fake.queueTurnResponse({
      commands: [{ command: "git diff", exitCode: 0 }]
    });
    // Recon turn 2: converge with final answer + no commands
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // Finalize turn: RPC error
    fake.queueTurnRpcError({ message: "ETIMEDOUT during finalize" });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize."
    });

    assert.ok(result.error, "result should carry the finalize error");
    assert.match(result.error.message, /ETIMEDOUT during finalize/);
    assert.equal(result.investigation.turnCount, 2, "investigation completed both recon turns before finalize failed");
    assert.equal(result.investigation.truncated, false, "investigation converged; not truncated");
    assert.equal(result.status, 1, "finalize-error path returns numeric status");

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 3, "2 recon + 1 finalize attempted");
  } finally {
    fake.close();
  }
});

test("converges with zero commands flags truncated=true", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: only final answer, no commands => converges immediately
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Nothing to investigate." }
    });
    // Finalize turn
    fake.queueTurnResponse({
      finalAnswer: { text: APPROVE_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize."
    });

    assert.equal(result.investigation.turnCount, 1);
    assert.equal(result.investigation.truncated, true, "zero commands across investigation => truncated");

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 2, "1 recon + 1 finalize");
  } finally {
    fake.close();
  }
});

test("recon turn 1 sends the investigate prompt; turn 2+ sends the continuation cue", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands
    fake.queueTurnResponse({
      commands: [{ command: "ls", exitCode: 0 }]
    });
    // Recon turn 2: commands
    fake.queueTurnResponse({
      commands: [{ command: "cat a.js", exitCode: 0 }]
    });
    // Recon turn 3: final answer, no commands => converges
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "All done." }
    });
    // Finalize turn
    fake.queueTurnResponse({
      finalAnswer: { text: APPROVE_REVIEW }
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "FULL INVESTIGATE PROMPT: look at the code",
      finalizePrompt: "FINALIZE PROMPT: produce verdict"
    });

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 4, "3 recon + 1 finalize");

    // Extract input text from each turn/start
    const inputTexts = starts.map((s) =>
      (s.params.input || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
    );

    // Turn 1: investigate prompt
    assert.match(inputTexts[0], /FULL INVESTIGATE PROMPT/, "turn 1 should use investigate prompt");
    // Turn 2 and 3: continuation cue
    assert.equal(inputTexts[1], "Continue your investigation.", "turn 2 should use continuation cue");
    assert.equal(inputTexts[2], "Continue your investigation.", "turn 3 should use continuation cue");
    // Turn 4: finalize prompt
    assert.match(inputTexts[3], /FINALIZE PROMPT/, "turn 4 should use finalize prompt");
  } finally {
    fake.close();
  }
});

// -------------------------------------------------------------------
// Integration tests: subprocess-based end-to-end companion tests
// -------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMPANION_PATH = fileURLToPath(
  new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url)
);

function makeSelfCollectGitFixture() {
  // 3+ changed files triggers self-collect (DEFAULT_INLINE_DIFF_MAX_FILES = 2)
  const root = mkdtempSync(path.join(tmpdir(), "codex-self-collect-test-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "# repo\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  spawnSync("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
  mkdirSync(path.join(root, "src"), { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(path.join(root, "src", `f${i}.js`), `export const v${i} = ${i};\n`);
  }
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "feature"], { cwd: root });
  return root;
}

function makeInlineGitFixture() {
  // 1 changed file stays on inline-diff path
  const root = mkdtempSync(path.join(tmpdir(), "codex-inline-test-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "# repo\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  spawnSync("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
  writeFileSync(path.join(root, "one.js"), "export const v = 1;\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "tiny"], { cwd: root });
  return root;
}

function makeCleanDefaultBranchGitFixture() {
  // A clean working tree sitting ON the default branch (main). resolveReviewTarget
  // falls back to a branch diff against the detected default (main) — but HEAD IS
  // main, so merge-base == HEAD and the diff is empty. Nothing to review.
  const root = mkdtempSync(path.join(tmpdir(), "codex-empty-diff-test-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "# repo\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

function runCompanion(args, env) {
  return spawnSync("node", [COMPANION_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30000
  });
}

test("self-collect path uses runAppServerInvestigation end-to-end", async () => {
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: runs a command, no convergence
    fake.queueTurnResponse({
      commands: [{ command: "git diff main...HEAD", exitCode: 0 }],
      finalAnswer: null
    });
    // Recon turn 2: no commands, final answer => converges
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // Finalize turn: structured output
    fake.queueTurnResponse({
      finalAnswer: {
        text: JSON.stringify({
          verdict: "needs-attention",
          summary: "Found risk in src/f1.js.",
          findings: [{
            severity: "high",
            title: "Unguarded export",
            file: "src/f1.js",
            line_start: 1,
            line_end: 1,
            confidence: 0.7,
            body: "Module exports v1 with no validation.",
            recommendation: "Add validation."
          }],
          next_steps: []
        })
      }
    });

    const result = runCompanion(
      ["adversarial-review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

    // stdout may contain progress lines followed by JSON; parse the last JSON object
    const stdout = result.stdout.trim();
    const payload = JSON.parse(stdout);
    assert.ok(payload.investigation, "self-collect payload must have investigation field");
    assert.equal(payload.investigation.turnCount, 2);
    assert.equal(payload.investigation.truncated, false);
    assert.equal(payload.result?.verdict, "needs-attention");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inline run that completes with no message renders as no-content, not a fake parse error (e2e)", async () => {
  // Reproduces the production failure (thread 019ea22a): a status-0 turn that
  // emitted only reasoning and no agent message. finalMessage was "", but the
  // run did NOT error — so the old code skipped the `failed` branch, ran the
  // empty string through parseStructuredOutput's `!rawOutput` path, and
  // produced an EMPTY parseError. The user saw "Codex did not return valid
  // structured JSON / - Parse error:" with nothing after the colon. An empty
  // completed run is a no-content result, NOT a malformed-JSON parse error.
  const cwd = makeInlineGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    // Single inline turn that completes with NO finalAnswer => empty message,
    // status 0, no error (the fake emits turn/completed with no agentMessage).
    fake.queueTurnResponse({ commands: [], finalAnswer: null });

    const result = runCompanion(
      ["adversarial-review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.failed, true, "an empty completed run must be flagged failed");
    assert.equal(payload.parseError, null, "must NOT fabricate a JSON parse error for empty output");
    assert.match(
      payload.failureMessage ?? "",
      /no review content|no final message|returned no/i,
      "failure reason must explain the empty output honestly"
    );
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("clean repo on the default branch short-circuits without calling the model (e2e)", async () => {
  // Reproduces the empty-diff trigger: running adversarial-review on a clean
  // working tree while sitting ON the default branch makes the branch
  // comparison resolve merge-base == HEAD, i.e. an empty diff. The old code
  // fed that empty diff to the model, which burned reasoning tokens and
  // returned nothing. With nothing to review there is no reason to call the
  // model at all — the run should short-circuit to an approve verdict.
  const cwd = makeCleanDefaultBranchGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    // Queue a turn so that IF the model is (wrongly) called, we can detect it.
    fake.queueTurnResponse({
      finalAnswer: { text: JSON.stringify({ verdict: "approve", summary: "x", findings: [], next_steps: [] }) }
    });

    const result = runCompanion(
      ["adversarial-review", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result?.verdict, "approve", "an empty diff should short-circuit to approve");

    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 0, "no model turn should be started when there is nothing to review");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inline-diff path does not call runAppServerInvestigation", async () => {
  const cwd = makeInlineGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    // Single turn: inline path uses runAppServerTurn
    fake.queueTurnResponse({
      finalAnswer: {
        text: JSON.stringify({
          verdict: "approve",
          summary: "No material issues found.",
          findings: [],
          next_steps: []
        })
      }
    });

    const result = runCompanion(
      ["adversarial-review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.investigation, undefined,
      "inline-path payload must not carry the investigation field");

    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 1, "inline path is single-turn");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("self-collect run failure renders as failure, not a fake JSON parse error (e2e)", async () => {
  // Reproduces the production failure: the connection to the upstream drops
  // mid-investigation (the `turn/start` request rejects, modelling a closed
  // socket). The companion must report the transport failure reason, NOT
  // JSON.parse the leftover prose and surface a misleading parse error.
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnRpcError({
      message: "stream disconnected before completion: error sending request"
    });

    const result = runCompanion(
      ["adversarial-review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.notEqual(result.status, 0, "a failed run should exit non-zero");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.failed, true, "payload should be flagged failed");
    assert.match(payload.failureMessage ?? "", /stream disconnected/, "failure reason preserved");
    assert.equal(payload.parseError, null, "must NOT produce a JSON parse error for a transport failure");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("finalize turn that recovered from a transient reconnect keeps its valid verdict (e2e)", async () => {
  // Regression guard for the finalize boundary: a transient reconnect during
  // the finalize turn sets `error` (so status becomes 1), but the turn still
  // emitted valid structured JSON. The companion must render that verdict, NOT
  // discard it as "could not complete the review" — the mirror of fix #1.
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands, no converge.
    fake.queueTurnResponse({ commands: [{ command: "git diff main...HEAD", exitCode: 0 }], finalAnswer: null });
    // Recon turn 2: converges.
    fake.queueTurnResponse({ commands: [], finalAnswer: { text: "Investigation done." } });
    // Finalize turn: valid JSON AND a transient reconnect error (recovered).
    fake.queueTurnResponse({
      finalAnswer: {
        text: JSON.stringify({
          verdict: "needs-attention",
          summary: "Found risk in src/f1.js.",
          findings: [{
            severity: "high", title: "Unguarded export", file: "src/f1.js",
            line_start: 1, line_end: 1, confidence: 0.7,
            body: "Module exports v1 with no validation.", recommendation: "Add validation."
          }],
          next_steps: []
        })
      },
      turnError: { message: "Reconnecting... 1/5" }
    });

    const result = runCompanion(
      ["adversarial-review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.equal(result.status, 0, "a recovered run with a valid verdict must exit success, not propagate the stale transient error status");
    const payload = JSON.parse(result.stdout.trim());
    assert.notEqual(payload.failed, true, "a recovered finalize turn must NOT be flagged failed");
    assert.equal(payload.result?.verdict, "needs-attention", "valid verdict must be preserved");
    assert.equal(payload.parseError, null, "valid JSON should parse cleanly");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------
// Unit tests for runAppServerInvestigation (continued from above)
// -------------------------------------------------------------------

test("outputSchema-set finalize turn produces schema-conformant final message", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: commands, no final answer
    fake.queueTurnResponse({
      commands: [{ command: "git diff HEAD~1", exitCode: 0 }],
      finalAnswer: null
    });
    // Recon turn 2: no commands, final answer => converges
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "Investigation done." }
    });
    // Finalize turn with structured output
    fake.queueTurnResponse({
      finalAnswer: { text: STRUCTURED_REVIEW }
    });

    const schema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string" },
        summary: { type: "string" },
        findings: { type: "array" },
        next_steps: { type: "array" }
      }
    };

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate the changes.",
      finalizePrompt: "Produce your structured verdict.",
      outputSchema: schema
    });

    // The finalMessage should be parseable JSON with a verdict field
    const parsed = JSON.parse(result.finalMessage);
    assert.equal(parsed.verdict, "needs-attention");
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].severity, "high");

    // The finalize turn should have received the schema
    const requests = fake.requests;
    const starts = requests.filter((r) => r.method === "turn/start");
    assert.deepEqual(starts[starts.length - 1].params.outputSchema, schema);

    // Only the finalize turn's reasoningSummary is returned
    assert.ok(Array.isArray(result.reasoningSummary));
  } finally {
    fake.close();
  }
});

// -------------------------------------------------------------------
// Task 5: renderer truncation banner
// -------------------------------------------------------------------

import { renderReviewResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderer prepends truncation banner when investigation.truncated is true", () => {
  const parsed = {
    parsed: {
      verdict: "needs-attention",
      summary: "Risk identified.",
      findings: [],
      next_steps: []
    }
  };
  const out = renderReviewResult(parsed, {
    reviewLabel: "Adversarial Review",
    targetLabel: "branch:feature",
    reasoningSummary: [],
    investigation: { turnCount: 10, truncated: true }
  });
  assert.match(out, /Investigation truncated at 10 turns; findings may be shallow\./);
});

test("renderer omits truncation banner when investigation is null or not truncated", () => {
  const parsed = {
    parsed: {
      verdict: "approve",
      summary: "Looks fine.",
      findings: [],
      next_steps: []
    }
  };
  const outNull = renderReviewResult(parsed, {
    reviewLabel: "Adversarial Review",
    targetLabel: "branch:feature",
    reasoningSummary: [],
    investigation: null
  });
  assert.doesNotMatch(outNull, /Investigation truncated/);

  const outOk = renderReviewResult(parsed, {
    reviewLabel: "Adversarial Review",
    targetLabel: "branch:feature",
    reasoningSummary: [],
    investigation: { turnCount: 4, truncated: false }
  });
  assert.doesNotMatch(outOk, /Investigation truncated/);
});

test("renderer shows truncation banner on parse-error and validation-error paths", () => {
  const parseErrorOut = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "{not json" },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "branch:feature",
      reasoningSummary: [],
      investigation: { turnCount: 10, truncated: true }
    }
  );
  assert.match(parseErrorOut, /Investigation truncated at 10 turns/,
    "banner must appear when output is unparseable AND investigation was truncated");

  const validationErrorOut = renderReviewResult(
    { parsed: { not: "review-shaped" } },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "branch:feature",
      reasoningSummary: [],
      investigation: { turnCount: 10, truncated: true }
    }
  );
  assert.match(validationErrorOut, /Investigation truncated at 10 turns/,
    "banner must appear when output has wrong shape AND investigation was truncated");
});

// -------------------------------------------------------------------
// Task 6: --max-investigation-turns CLI flag
// -------------------------------------------------------------------

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

test("parseArgs accepts --max-investigation-turns as a value option", () => {
  const { options } = parseArgs(
    ["--base", "main", "--max-investigation-turns", "15", "auth"],
    {
      valueOptions: ["base", "scope", "model", "cwd", "max-investigation-turns"],
      booleanOptions: ["json", "background", "wait"]
    }
  );
  assert.equal(options["max-investigation-turns"], "15");
});

test("--max-investigation-turns propagates from CLI to runAppServerInvestigation", async () => {
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    for (let i = 0; i < 6; i += 1) {
      fake.queueTurnResponse({
        commands: [{ command: "git diff", exitCode: 0 }],
        finalAnswer: null
      });
    }
    fake.queueTurnResponse({
      finalAnswer: { text: JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] }) }
    });

    const result = runCompanion(
      ["adversarial-review",
       "--base", "main", "--scope", "branch", "--cwd", cwd,
       "--max-investigation-turns", "5",
       "--json"],
      fake.env
    );

    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.investigation.turnCount, 5);
    assert.equal(payload.investigation.truncated, true);
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid --max-investigation-turns raises a clear error", () => {
  const r = spawnSync("node",
    [COMPANION_PATH, "adversarial-review", "--max-investigation-turns", "abc"],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.notEqual(r.status, 0, "should exit non-zero on invalid flag value");
  assert.match(
    r.stderr,
    /must be a positive integer/,
    "error message should explain the validation failure"
  );
});

test("--max-investigation-turns rejects malformed numeric tokens", () => {
  // parseInt-style salvage must NOT accept these — they are typos, not valid input.
  const cases = [
    "1.5",      // parseInt would yield 1
    "10abc",    // parseInt would yield 10
    "1e2",      // exponential notation: Number(...) yields 100, but the contract is "integer literal"
    "  5",      // leading whitespace from accidental quoting
    "0",        // zero is not positive
    "-3",       // negative integer
    ""          // empty string
  ];
  for (const value of cases) {
    const r = spawnSync("node",
      [COMPANION_PATH, "adversarial-review", "--max-investigation-turns", value],
      { encoding: "utf8", timeout: 30000 }
    );
    assert.notEqual(r.status, 0, `value ${JSON.stringify(value)} should exit non-zero`);
    assert.match(
      r.stderr,
      /must be a positive integer/,
      `value ${JSON.stringify(value)} should trigger the validation error`
    );
  }
});

test("invalid --turn-idle-timeout raises a clear error", () => {
  const r = spawnSync("node",
    [COMPANION_PATH, "adversarial-review", "--turn-idle-timeout", "abc"],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.notEqual(r.status, 0, "should exit non-zero on invalid flag value");
  assert.match(r.stderr, /must be a positive integer/, "error message should explain the validation failure");
});

// -------------------------------------------------------------------
// Prompt contract: inline + finalize prompts must forbid tool-call stubs
// -------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath as fileURLToPathPromptCheck } from "node:url";

const PROMPT_DIR = fileURLToPathPromptCheck(
  new URL("../plugins/codex/prompts/", import.meta.url)
);

test("inline adversarial-review prompt forbids tool-call stub output", () => {
  const text = readFileSync(`${PROMPT_DIR}adversarial-review.md`, "utf8");
  // The model used to respond with payloads like {"cmd": "wc -l ..."}
  // instead of the review JSON — the prompt must explicitly disallow it
  // since this path is single-turn and has no recovery.
  assert.match(text, /tool[- ]?call|tool[- ]?use/i,
    "inline prompt must mention tool-call/tool-use");
  assert.match(text, /\{"cmd"|stub/i,
    "inline prompt must show or name the tool-call stub anti-pattern");
  assert.match(text, /Do NOT run any shell commands/,
    "inline prompt must explicitly forbid running shell commands");
});

test("finalize prompt forbids tool-call stub output", () => {
  const text = readFileSync(`${PROMPT_DIR}adversarial-review-finalize.md`, "utf8");
  assert.match(text, /Do NOT run any shell commands/,
    "finalize prompt must explicitly forbid running shell commands");
  assert.match(text, /no tool-call payloads|no shell commands/i,
    "finalize prompt must spell out the no-tool-call rule");
});

test("task turn that recovered from a transient reconnect is NOT marked failed (e2e)", async () => {
  // A task turn emits a valid agent message AND a stale transient `error`
  // ("Reconnecting... 1/5"), then turn/completed. The companion must exit 0 and
  // report success — not propagate the stale non-zero status from buildResultStatus.
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      finalAnswer: { text: "ALLOW: looks fine" },
      turnError: { message: "Reconnecting... 1/5" }
    });

    const result = runCompanion(["task", "--json", "--cwd", cwd, "do the thing"], fake.env);

    assert.equal(result.status, 0, "a recovered task must exit 0, not propagate the stale transient error status");
    const payload = JSON.parse(result.stdout.trim());
    assert.match(payload.rawOutput, /ALLOW: looks fine/, "the real agent answer must be returned");
    assert.equal(payload.status, 0, "payload.status must be normalized to the resolved success status");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("task turn that errored with no usable output still fails (e2e)", async () => {
  // Guard the genuine-failure case: a transient/fatal error with NO agent message
  // must still exit non-zero. Otherwise resolveRunExitStatus would whitewash real
  // failures.
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      finalAnswer: null,
      turnError: { message: "Connection lost; giving up." }
    });

    const result = runCompanion(["task", "--json", "--cwd", cwd, "do the thing"], fake.env);

    assert.notEqual(result.status, 0, "a turn that errored with no usable output must still fail");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("native review that recovered from a transient reconnect is NOT marked failed (e2e)", async () => {
  // The native /codex:review branch returns exitStatus from result.status raw.
  // A recovered native review (reviewText present + stale error) must exit 0.
  // Note: review uses reviewText as the usable-output signal, not finalMessage.
  const cwd = makeInlineGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      reviewText: "Reviewed current changes.\nNo material issues found.",
      turnError: { message: "Reconnecting... 1/5" }
    });

    const result = runCompanion(
      ["review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.equal(result.status, 0, "a recovered native review with review text must exit 0");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.codex.status, 0, "payload.codex.status must be normalized to the resolved success status");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("idle watchdog interrupts with the buffered turn id when the turn/start RPC reply is delayed (Defect C)", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: progresses (has commands), does not converge.
    fake.queueTurnResponse({ commands: [{ command: "git diff", exitCode: 0 }], finalAnswer: null });
    // Recon turn 2: emits turn/started, then withholds the RPC result and never
    // completes — so the watchdog fires while state.turnId is still null.
    fake.queueTurnHangAfterStarted();

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      turnIdleTimeoutMs: 300
    });

    assert.ok(result.error, "a stalled turn must abort with an error");
    assert.match(result.error.message, /idle|timeout|timed out/i);

    // The fixture must have received a turn/interrupt carrying the turn id it
    // announced via turn/started — proving the watchdog did not skip the
    // interrupt just because state.turnId was null (Defect C). turn_2 is the
    // hung turn's id (turn_1 was recon turn 1). The interrupt is fire-and-forget
    // and lands on the fixture exactly as withAppServer's client.close() is
    // resolving, so the fixture's synchronous saveState can land a beat after
    // the call returns; poll the state file briefly for it to appear.
    const statePath = path.join(fake.binDir, "fake-codex-state.json");
    let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const deadline = Date.now() + 2000;
    while (!state.lastInterrupt && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    }
    assert.ok(state.lastInterrupt, "watchdog must send turn/interrupt even before the turn/start RPC reply");
    assert.equal(state.lastInterrupt.turnId, "turn_2", "interrupt must carry the buffered turn id");
  } finally {
    fake.close();
  }
});

test("foreign-thread chatter does not re-arm the current turn's idle watchdog (Defect B)", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: emits turn/started, then a long stream of foreign-thread
    // notifications spaced UNDER the idle window, then never completes OUR turn.
    // Spans ~4s so the buggy (re-arm-on-foreign) path cannot time out until
    // chatter stops (~4s + the 300ms idle window ≈ 4.3s); the fixed path times
    // out promptly ~300ms after turn/started. The 2500ms ceiling sits between
    // the two with wide margins on both sides (≈1.8s of buggy-side headroom and
    // ≈2s of tolerance for subprocess-startup jitter on the fixed side), so the
    // assertion discriminates without being flaky on a loaded machine.
    fake.queueTurnResponse({ foreignChatterThenHang: { count: 80, everyMs: 50 } });

    const start = Date.now();
    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      turnIdleTimeoutMs: 300
    });
    const elapsed = Date.now() - start;

    assert.ok(result.error, "stuck turn must time out despite foreign chatter");
    assert.match(result.error.message, /idle|timeout|timed out/i);
    assert.ok(elapsed < 2500, `watchdog must fire at the idle window, not be held open by foreign chatter (took ${elapsed}ms)`);
  } finally {
    fake.close();
  }
});

test("plain recon turn does not infer completion from a readiness cue (Defect A gate)", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    // Recon turn 1: emits a "ready for finalize" final_answer cue, then goes
    // silent — NO real turn/completed, NO subagent work. A plain turn must wait
    // for turn/completed (which never arrives) -> idle watchdog aborts.
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "I'm ready for finalize." },
      cueThenHang: true
    });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      // Quiet window well below the idle timeout: on UNFIXED code, cue-based
      // inference (now using this window) would fire at 60ms and the run would
      // not error. On FIXED code, a plain turn never infers, so only the idle
      // watchdog (400ms) ends it -> result.error is set.
      inferredCompletionQuietMs: 60,
      turnIdleTimeoutMs: 400
    });

    assert.ok(result.error, "a plain turn with no real turn/completed must time out, not infer");
    assert.match(result.error.message, /idle|timeout|timed out/i);
    // Finalize must NOT have been dispatched (the recon turn never completed).
    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 1, "finalize must not be dispatched when recon never completed");
  } finally {
    fake.close();
  }
});

test("a verdict streamed after a readiness cue is captured, not discarded (Defect A end-to-end)", async () => {
  const cwd = makeTempDir("codex-inv-test-");
  const fake = setupFakeCodex({ cwd });
  try {
    fake.enableSerialization();
    // Recon turn 1: a "ready for finalize" cue immediately, then the REAL verdict
    // (~300ms) and the REAL turn/completed (~600ms). delayCompletedMs (600) is
    // ABOVE the unfixed 250ms inference window, so unfixed code dispatches
    // finalize while recon is still busy -> finalize hangs -> watchdog error.
    fake.queueTurnResponse({
      commands: [],
      finalAnswer: { text: "I'm ready for finalize." },
      lateFinalAnswer: { text: "Investigation complete. Verdict ready.", afterMs: 300 },
      delayCompletedMs: 600
    });
    // Finalize turn 2: schema-enforced structured JSON.
    fake.queueTurnResponse({ finalAnswer: { text: STRUCTURED_REVIEW } });

    const result = await runAppServerInvestigation(fake.cwd, {
      investigatePrompt: "Investigate.",
      finalizePrompt: "Finalize.",
      outputSchema: { type: "object", required: ["verdict"] },
      turnIdleTimeoutMs: 2000
      // No inferredCompletionQuietMs override: a plain recon turn must never
      // infer regardless of the window. The fix is the sawSubagentWork gate.
    });

    assert.equal(result.error ?? null, null, "fixed code must NOT hang to the watchdog");
    assert.equal(result.finalMessage, STRUCTURED_REVIEW, "verdict from finalize is preserved");
    const starts = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(starts.length, 2, "recon completes, then finalize is dispatched onto an idle thread");
  } finally {
    fake.close();
  }
});
