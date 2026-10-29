import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStatusReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderStatusReport keeps a backslash followed by a pipe in one table cell", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "native" },
    config: { stopReviewGate: false },
    running: [{
      id: "task-1",
      kindLabel: "task",
      status: "running",
      phase: "running",
      elapsed: "1s",
      summary: String.raw`a\|b`
    }],
    recent: []
  });
  const row = output.split("\n").find((line) => line.startsWith("| task-1 |"));

  assert.ok(row);
  assert.ok(row.includes(String.raw` | a\\\|b |`));
  assert.equal([...row.matchAll(/(?<!\\)(?:\\\\)*\|/g)].length, 9);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
