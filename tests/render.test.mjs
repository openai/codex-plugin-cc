import test from "node:test";
import assert from "node:assert/strict";

import { renderCancelReport, renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderCancelReport reports a non-cancelled adopted outcome instead of a cancel stub", () => {
  const failed = renderCancelReport({ id: "task-1", title: "Codex Task", status: "failed" });
  assert.match(failed, /recorded as failed/);
  assert.doesNotMatch(failed, /Cancelled task-1\./);

  const cancelled = renderCancelReport({ id: "task-1", title: "Codex Task", status: "cancelled" });
  assert.match(cancelled, /Cancelled task-1\./);
});

test("renderCancelReport warns when the worker could not be terminated", () => {
  const job = { id: "task-1", title: "Codex Task" };

  const clean = renderCancelReport(job, { workerTerminated: true });
  assert.doesNotMatch(clean, /Warning/);

  const survived = renderCancelReport(job, { workerTerminated: false });
  assert.match(survived, /Warning: the worker process could not be terminated/);
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
