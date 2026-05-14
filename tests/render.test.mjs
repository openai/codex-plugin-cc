import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusSnapshot } from "../plugins/codex/scripts/lib/job-control.mjs";
import {
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult
} from "../plugins/codex/scripts/lib/render.mjs";
import { saveState } from "../plugins/codex/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("renderSetupReport includes review subagent state", () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: "v24.0.0" },
    npm: { detail: "10.0.0" },
    codex: { detail: "installed" },
    auth: { detail: "logged in" },
    sessionRuntime: { label: "direct" },
    reviewGateEnabled: true,
    reviewSubagentsEnabled: false,
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /^- review gate: enabled$/m);
  assert.match(output, /^- review subagents: disabled$/m);
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

function baseStatusReport(overrides = {}) {
  return {
    sessionRuntime: { label: "direct" },
    config: { stopReviewGate: false },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: false,
    reviewInvokerBreakdown: {
      windowMs: 3_600_000,
      total: 0,
      byInvoker: {
        "user-slash": 0,
        "claude-subagent": 0,
        "claude-bash": 0,
        hook: 0
      }
    },
    ...overrides
  };
}

test("renderStatusReport includes invoker table column and legacy review invoker", () => {
  const output = renderStatusReport(
    baseStatusReport({
      running: [
        {
          id: "review-running",
          kindLabel: "review",
          kind: "review",
          jobClass: "review",
          status: "running",
          phase: "reviewing",
          elapsed: "2s",
          invoker: "claude-subagent",
          summary: "working tree"
        },
        {
          id: "task-running",
          kindLabel: "rescue",
          kind: "task",
          jobClass: "task",
          status: "running",
          phase: "running",
          elapsed: "3s",
          summary: "task"
        }
      ],
      latestFinished: {
        id: "review-legacy",
        kindLabel: "adversarial-review",
        kind: "adversarial-review",
        jobClass: "review",
        status: "completed",
        phase: "done",
        duration: "1s",
        summary: "legacy"
      },
      reviewInvokerBreakdown: {
        windowMs: 3_600_000,
        total: 1,
        byInvoker: {
          "user-slash": 0,
          "claude-subagent": 1,
          "claude-bash": 0,
          hook: 0
        }
      }
    })
  );

  assert.match(output, /\| Job \| Kind \| Invoker \| Status \|/);
  assert.match(output, /\| review-running \| review \| claude-subagent \| running \|/);
  assert.match(output, /\| task-running \| rescue \| - \| running \|/);
  assert.match(output, /Invoker: unknown/);
});

test("renderStatusReport includes review invoker aggregate only when reviews exist", () => {
  const output = renderStatusReport(
    baseStatusReport({
      latestFinished: {
        id: "review-1",
        kindLabel: "review",
        kind: "review",
        jobClass: "review",
        status: "completed",
        phase: "done",
        invoker: "claude-subagent",
        summary: "done"
      },
      reviewInvokerBreakdown: {
        windowMs: 3_600_000,
        total: 3,
        byInvoker: {
          "user-slash": 1,
          "claude-subagent": 1,
          "claude-bash": 1,
          hook: 0
        }
      }
    })
  );

  assert.equal(
    output.match(/reviews in the last hour were Claude-driven/g)?.length,
    1
  );
  assert.match(output, /2 of last 3 reviews in the last hour were Claude-driven \(claude-subagent or claude-bash\)\./);

  const emptyOutput = renderStatusReport(baseStatusReport());
  assert.doesNotMatch(emptyOutput, /reviews in the last hour were Claude-driven/);
});

test("buildStatusSnapshot counts review invokers across workspace sessions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-snapshot-"));
  const now = Date.parse("2026-05-14T12:00:00.000Z");

  saveState(workspace, {
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-current",
        status: "completed",
        jobClass: "review",
        sessionId: "sess-current",
        invoker: "claude-subagent",
        createdAt: "2026-05-14T11:30:00.000Z",
        updatedAt: "2026-05-14T11:30:10.000Z"
      },
      {
        id: "review-other-1",
        status: "completed",
        jobClass: "review",
        sessionId: "sess-other",
        invoker: "claude-subagent",
        createdAt: "2026-05-14T11:40:00.000Z",
        updatedAt: "2026-05-14T11:40:10.000Z"
      },
      {
        id: "review-other-2",
        status: "completed",
        jobClass: "review",
        sessionId: "sess-other",
        invoker: "claude-subagent",
        createdAt: "2026-05-14T11:50:00.000Z",
        updatedAt: "2026-05-14T11:50:10.000Z"
      }
    ]
  });

  const snapshot = buildStatusSnapshot(workspace, {
    env: { [SESSION_ID_ENV]: "sess-current" },
    now
  });

  assert.equal(snapshot.latestFinished.id, "review-current");
  assert.equal(snapshot.recent.length, 0);
  assert.equal(snapshot.reviewInvokerBreakdown.total, 3);
  assert.equal(snapshot.reviewInvokerBreakdown.byInvoker["claude-subagent"], 3);
});
