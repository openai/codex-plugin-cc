import test from "node:test";
import assert from "node:assert/strict";

import { renderJobStatusReport, renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("running job status shows owner liveness and time since progress", () => {
  const job = { id: "task-live", status: "running", ownerAlive: true, progressAgeMinutes: 17 };
  assert.match(renderJobStatusReport(job), /Owner: alive\n  Last progress: 17m ago/);
  assert.match(renderJobStatusReport({ ...job, ownerAlive: false }), /Owner: exited/);
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

test("task status and result show the stored sandbox and effective network access", () => {
  for (const [sandbox, network, expected] of [
    ["read-only", true, "disabled"],
    ["workspace-write", false, "disabled"],
    ["workspace-write", true, "enabled"],
    ["danger-full-access", false, "enabled"]
  ]) {
    const job = { id: "task-1", status: "completed", jobClass: "task", sandbox, network };
    const details = `Sandbox: ${sandbox} (network: ${expected})`;
    assert.ok(renderJobStatusReport(job).includes(details));
    assert.ok(renderStoredJobResult(job, { request: { sandbox, network }, result: { rawOutput: "Finished" } }).includes(details));
  }
});
