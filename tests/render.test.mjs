import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderTaskResult } from "../plugins/codex/scripts/lib/render.mjs";

const TASK_COMPLETE_STATUS_TOKEN = "[[codex-task status=complete]]";

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

test("renderTaskResult only stamps the complete sentinel for successful task runs", () => {
  const successful = renderTaskResult(
    {
      rawOutput: "Handled the requested task.",
      status: 0
    },
    {}
  );

  assert.equal(successful, `Handled the requested task.\n${TASK_COMPLETE_STATUS_TOKEN}\n`);

  const failedEmpty = renderTaskResult(
    {
      rawOutput: "",
      failureMessage: "Codex failed before producing a final message.",
      status: 1
    },
    {}
  );

  assert.equal(failedEmpty, "Codex failed before producing a final message.\n");
  assert.doesNotMatch(failedEmpty, /\[\[codex-task status=complete\]\]/);
});
