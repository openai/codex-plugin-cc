import test from "node:test";
import assert from "node:assert/strict";

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
import path from "node:path";
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
