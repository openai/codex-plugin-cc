import test from "node:test";
import assert from "node:assert/strict";

import { assertInvoker, DEFAULT_INVOKER, INVOKER_VALUES } from "../plugins/codex/scripts/lib/invoker.mjs";
import { enforceReviewRateLimit, parseReviewRateLimit } from "../plugins/codex/scripts/lib/review-rate-limit.mjs";
import { listJobs, saveState } from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

function invalidRateLimitWarning(raw) {
  return `CODEX_PLUGIN_REVIEW_RATE_LIMIT="${raw}" is not a valid rate limit (expected <positive int>/<positive int>min, with count <= 500 and minutes <= 60). Non-user-slash reviews are refused until this is fixed.`;
}

function invalidRateLimitError(raw, invoker) {
  return `Codex review rate limit misconfigured: CODEX_PLUGIN_REVIEW_RATE_LIMIT="${raw}" is not a valid rate limit (expected <positive int>/<positive int>min, with count <= 500 and minutes <= 60). Refusing invoker ${invoker} until this is fixed. Run \`/codex:adversarial-review\` (user-slash) to bypass.`;
}

test("invoker enum is closed and validates values", () => {
  assert.deepEqual(INVOKER_VALUES, ["user-slash", "claude-subagent", "claude-bash", "hook"]);
  assert.equal(Object.isFrozen(INVOKER_VALUES), true);
  assert.equal(DEFAULT_INVOKER, "user-slash");

  for (const value of INVOKER_VALUES) {
    assert.equal(assertInvoker(value), value);
  }

  assert.throws(() => assertInvoker("bogus"), {
    message:
      "Invalid --invoker value: bogus. Expected one of: user-slash, claude-subagent, claude-bash, hook."
  });
});

test("parseReviewRateLimit returns absent for unset or blank values", () => {
  for (const value of [undefined, null, "", " "]) {
    assert.deepEqual(parseReviewRateLimit(value), { kind: "absent" });
  }
});

test("parseReviewRateLimit returns invalid with raw trimmed string for malformed values", () => {
  for (const [value, raw] of [
    ["3/15m", "3/15m"],
    ["abc", "abc"],
    ["5 / 10min", "5 / 10min"],
    [" 5 / 10min ", "5 / 10min"],
    ["0/10min", "0/10min"],
    ["5/0min", "5/0min"],
    ["5/61min", "5/61min"],
    ["501/10min", "501/10min"],
    ["1000/30min", "1000/30min"],
    ["-1/10min", "-1/10min"],
    ["5/10min extra", "5/10min extra"]
  ]) {
    assert.deepEqual(parseReviewRateLimit(value), { kind: "invalid", raw });
  }
});

test("parseReviewRateLimit returns active for valid limits", () => {
  for (const [value, expected] of [
    ["5/10min", { kind: "active", count: 5, windowMs: 600_000 }],
    ["1/60min", { kind: "active", count: 1, windowMs: 3_600_000 }],
    ["100/1min", { kind: "active", count: 100, windowMs: 60_000 }],
    ["500/60min", { kind: "active", count: 500, windowMs: 3_600_000 }],
    [" 5/10min ", { kind: "active", count: 5, windowMs: 600_000 }]
  ]) {
    assert.deepEqual(parseReviewRateLimit(value), expected);
  }
});

test("enforceReviewRateLimit never refuses user-slash", () => {
  const warnings = [];
  assert.doesNotThrow(() =>
    enforceReviewRateLimit({
      workspaceRoot: "/repo",
      invoker: "user-slash",
      env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "3/15m" },
      now: Date.parse("2026-05-14T12:00:00.000Z"),
      listJobs: () => {
        throw new Error("listJobs should not be called for user-slash");
      },
      warn: (message) => warnings.push(message)
    })
  );
  assert.deepEqual(warnings, []);
});

test("user-slash bypass is intentional (ADR 0002)", () => {
  const overBudgetJobs = Array.from({ length: 5 }, (_, index) => ({
    id: `review-${index}`,
    jobClass: "review",
    invoker: "claude-subagent",
    createdAt: "2026-05-14T11:30:00.000Z"
  }));

  // ADR 0002 accepts self-reported invoker spoofing; this limiter is a soft budget, not auth.
  assert.doesNotThrow(() =>
    enforceReviewRateLimit({
      workspaceRoot: "/repo",
      invoker: "user-slash",
      env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "1/60min" },
      now: Date.parse("2026-05-14T12:00:00.000Z"),
      listJobs: () => overBudgetJobs
    })
  );
});

test("enforceReviewRateLimit refuses non-user invocations on invalid config", () => {
  const raw = "3/15m";
  const warnings = [];
  assert.throws(
    () =>
      enforceReviewRateLimit({
        workspaceRoot: "/repo",
        invoker: "claude-subagent",
        env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: raw },
        now: Date.parse("2026-05-14T12:00:00.000Z"),
        listJobs: () => {
          throw new Error("listJobs should not be called for invalid config");
        },
        warn: (message) => warnings.push(message)
      }),
    {
      message: invalidRateLimitError(raw, "claude-subagent")
    }
  );
  assert.deepEqual(warnings, [invalidRateLimitWarning(raw)]);
});

test("enforceReviewRateLimit memoizes invalid config warnings by raw string", () => {
  const raw = "9/61min";
  const warnings = [];
  const request = {
    workspaceRoot: "/repo",
    invoker: "hook",
    env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: raw },
    now: Date.parse("2026-05-14T12:00:00.000Z"),
    listJobs: () => {
      throw new Error("listJobs should not be called for invalid config");
    },
    warn: (message) => warnings.push(message)
  };

  assert.throws(() => enforceReviewRateLimit(request), {
    message: invalidRateLimitError(raw, "hook")
  });
  assert.throws(() => enforceReviewRateLimit(request), {
    message: invalidRateLimitError(raw, "hook")
  });
  assert.deepEqual(warnings, [invalidRateLimitWarning(raw)]);
});

test("concurrent non-user starts both pass when check runs before persist (accepted)", () => {
  const prePersistedState = [
    {
      id: "review-existing",
      jobClass: "review",
      invoker: "hook",
      createdAt: "2026-05-14T11:30:00.000Z"
    }
  ];
  const request = {
    workspaceRoot: "/repo",
    invoker: "claude-subagent",
    env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "2/60min" },
    now: Date.parse("2026-05-14T12:00:00.000Z"),
    listJobs: () => prePersistedState
  };

  assert.doesNotThrow(() => enforceReviewRateLimit(request));
  assert.doesNotThrow(() => enforceReviewRateLimit(request));
});

test("enforceReviewRateLimit refuses non-user invocations at threshold", () => {
  assert.throws(
    () =>
      enforceReviewRateLimit({
        workspaceRoot: "/repo",
        invoker: "claude-subagent",
        env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "1/60min" },
        now: Date.parse("2026-05-14T12:00:00.000Z"),
        listJobs: () => [
          {
            id: "review-1",
            kind: "adversarial-review",
            invoker: "hook",
            createdAt: "2026-05-14T11:30:00.000Z"
          }
        ]
      }),
    {
      message:
        "Codex review rate limit exceeded: 1/60min for invoker claude-subagent. Run `/codex:adversarial-review` (user-slash) to bypass."
    }
  );
});

test("enforceReviewRateLimit respects the configured window", () => {
  assert.doesNotThrow(() =>
    enforceReviewRateLimit({
      workspaceRoot: "/repo",
      invoker: "hook",
      env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "1/10min" },
      now: Date.parse("2026-05-14T12:00:00.000Z"),
      listJobs: () => [
        {
          id: "review-1",
          jobClass: "review",
          invoker: "claude-bash",
          createdAt: "2026-05-14T11:49:59.000Z"
        }
      ]
    })
  );
});

test("enforceReviewRateLimit ignores legacy records without invoker", () => {
  assert.doesNotThrow(() =>
    enforceReviewRateLimit({
      workspaceRoot: "/repo",
      invoker: "claude-subagent",
      env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "1/60min" },
      now: Date.parse("2026-05-14T12:00:00.000Z"),
      listJobs: () => [
        {
          id: "review-legacy",
          jobClass: "review",
          createdAt: "2026-05-14T11:30:00.000Z"
        }
      ]
    })
  );
});

test("enforceReviewRateLimit counts more than fifty recent persisted review records", () => {
  const workspaceRoot = makeTempDir();
  const now = Date.now();
  const jobs = Array.from({ length: 51 }, (_, index) => {
    const createdAt = new Date(now - index * 1_000).toISOString();
    return {
      id: `review-${index}`,
      status: "completed",
      jobClass: "review",
      invoker: "claude-subagent",
      createdAt,
      updatedAt: createdAt
    };
  });

  saveState(workspaceRoot, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  assert.throws(
    () =>
      enforceReviewRateLimit({
        workspaceRoot,
        invoker: "claude-subagent",
        env: { CODEX_PLUGIN_REVIEW_RATE_LIMIT: "51/60min" },
        now,
        listJobs
      }),
    {
      message:
        "Codex review rate limit exceeded: 51/60min for invoker claude-subagent. Run `/codex:adversarial-review` (user-slash) to bypass."
    }
  );
});
