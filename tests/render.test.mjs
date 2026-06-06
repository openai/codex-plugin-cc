import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

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

test("renderReviewResult reports run failure instead of faking a JSON parse error", () => {
  // When the run failed at the transport/turn level (connection dropped,
  // idle timeout), the leftover `rawOutput` is often just the model's opening
  // line — NOT structured JSON. The renderer must report the real failure
  // reason, not a misleading "did not return valid structured JSON" parse error.
  const output = renderReviewResult(
    {
      parsed: null,
      parseError: null,
      failed: true,
      failureMessage: "stream disconnected before completion: error sending request for url (https://bedrock-mantle.../responses)",
      rawOutput: "Using `superpowers:writing-plans` to judge the plan before read-only investigation."
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "branch diff"
    }
  );

  assert.match(output, /could not complete/i, "should state the run could not complete");
  assert.match(output, /stream disconnected before completion/, "should surface the real failure reason");
  assert.doesNotMatch(output, /valid structured JSON/, "must NOT misrender as a JSON parse error");
  assert.doesNotMatch(output, /Parse error:/, "must NOT show a parse error for a transport failure");
});

test("renderReviewResult still shows the parse-error path for genuine malformed JSON", () => {
  // Regression guard: a status-0 run that legitimately returns malformed JSON
  // (model formatting bug, not a transport failure) must keep the existing
  // parse-error rendering. `failed` is absent here.
  const output = renderReviewResult(
    {
      parsed: null,
      parseError: "Unexpected token '{' ...",
      rawOutput: "{not valid json"
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /Parse error:/);
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
