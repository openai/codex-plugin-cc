import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderUsageReport } from "../plugins/codex/scripts/lib/render.mjs";

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

test("renderUsageReport shows error when report is not ok", () => {
  const output = renderUsageReport({
    ok: false,
    error: "Codex is not authenticated. Run `!codex login` first."
  });

  assert.match(output, /# Codex Usage/);
  assert.match(output, /Error: Codex is not authenticated/);
});

test("renderUsageReport shows keychain auth error when logged in but no token file", () => {
  const output = renderUsageReport({
    ok: false,
    error: "Codex is authenticated via keychain or an external credential store, which `/codex:usage` cannot read directly yet. Check your usage at https://platform.openai.com/usage instead."
  });

  assert.match(output, /# Codex Usage/);
  assert.match(output, /keychain/);
  assert.match(output, /platform\.openai\.com\/usage/);
});

test("renderUsageReport renders plan type and rate limits", () => {
  const output = renderUsageReport({
    ok: true,
    planType: "plus",
    data: {
      rate_limit: {
        primary_window: {
          used_percent: 27,
          reset_at: "2026-04-01T18:22:00Z"
        },
        secondary_window: {
          used_percent: 46,
          reset_at: "2026-04-05T09:15:00Z"
        }
      },
      code_review_rate_limit: {
        primary_window: {
          used_percent: 9,
          reset_at: "2026-04-07T14:30:00Z"
        }
      }
    }
  });

  assert.match(output, /# Codex Usage/);
  assert.match(output, /Plan: plus/);
  assert.match(output, /Primary limit: 73% left/);
  assert.match(output, /Weekly limit: 54% left/);
  assert.match(output, /Code review limit: 91% left/);
});

test("renderUsageReport renders credits section", () => {
  const output = renderUsageReport({
    ok: true,
    planType: "pro",
    data: {
      credits: {
        has_credits: true,
        unlimited: false,
        balance: 42.5
      }
    }
  });

  assert.match(output, /Plan: pro/);
  assert.match(output, /Credits: \$42\.50 remaining/);
});

test("renderUsageReport handles unlimited credits", () => {
  const output = renderUsageReport({
    ok: true,
    planType: "enterprise",
    data: {
      credits: {
        has_credits: true,
        unlimited: true
      }
    }
  });

  assert.match(output, /Credits: unlimited/);
});

test("renderUsageReport prefers API plan_type over JWT-decoded planType", () => {
  const output = renderUsageReport({
    ok: true,
    planType: "plus",
    data: {
      plan_type: "pro"
    }
  });

  assert.match(output, /Plan: pro/);
});

test("renderUsageReport falls back to JWT planType when API plan_type is missing", () => {
  const output = renderUsageReport({
    ok: true,
    planType: "team",
    data: {}
  });

  assert.match(output, /Plan: team/);
});
