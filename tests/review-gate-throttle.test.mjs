import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  getConfig,
  loadState,
  resolveStateFile,
  setConfig,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";

function setupWorkspace() {
  const workspace = makeTempDir();
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  return {
    workspace,
    cleanup() {
      if (previousPluginData == null) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
      }
    }
  };
}

// Mirror of the throttle logic from stop-review-gate-hook.mjs for unit testing.
// The hook script calls main() at import time so it cannot be imported directly.
function countSessionStopReviews(jobs) {
  return jobs.filter(
    (job) =>
      job.jobClass === "review" &&
      job.title === "Codex Stop Gate Review" &&
      job.status === "completed"
  ).length;
}

function findLastStopReviewTime(jobs) {
  const stopReview = jobs.find(
    (job) =>
      job.jobClass === "review" &&
      job.title === "Codex Stop Gate Review" &&
      job.completedAt
  );
  return stopReview?.completedAt ? new Date(stopReview.completedAt).getTime() : null;
}

function checkThrottleLimits(config, jobs) {
  const maxPerSession = config.stopReviewGateMaxPerSession ?? null;
  if (maxPerSession != null && maxPerSession > 0) {
    const count = countSessionStopReviews(jobs);
    if (count >= maxPerSession) {
      return `Stop-gate review skipped: session limit reached (${count}/${maxPerSession}). Run /codex:review manually if needed.`;
    }
  }

  const cooldownMinutes = config.stopReviewGateCooldownMinutes ?? null;
  if (cooldownMinutes != null && cooldownMinutes > 0) {
    const lastTime = findLastStopReviewTime(jobs);
    if (lastTime != null) {
      const elapsed = Date.now() - lastTime;
      const cooldownMs = cooldownMinutes * 60 * 1000;
      if (elapsed < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - elapsed) / 60000);
        return `Stop-gate review skipped: cooldown active (${remainingMinutes}m remaining). Run /codex:review manually if needed.`;
      }
    }
  }

  return null;
}

// --- Config storage tests ---

test("setConfig stores stopReviewGateMaxPerSession", () => {
  const { workspace, cleanup } = setupWorkspace();
  try {
    setConfig(workspace, "stopReviewGateMaxPerSession", 5);
    const config = getConfig(workspace);
    assert.equal(config.stopReviewGateMaxPerSession, 5);
  } finally {
    cleanup();
  }
});

test("setConfig stores stopReviewGateCooldownMinutes", () => {
  const { workspace, cleanup } = setupWorkspace();
  try {
    setConfig(workspace, "stopReviewGateCooldownMinutes", 10);
    const config = getConfig(workspace);
    assert.equal(config.stopReviewGateCooldownMinutes, 10);
  } finally {
    cleanup();
  }
});

test("setConfig clears throttle config with null", () => {
  const { workspace, cleanup } = setupWorkspace();
  try {
    setConfig(workspace, "stopReviewGateMaxPerSession", 5);
    setConfig(workspace, "stopReviewGateMaxPerSession", null);
    const config = getConfig(workspace);
    assert.equal(config.stopReviewGateMaxPerSession, null);
  } finally {
    cleanup();
  }
});

test("default config has null throttle values", () => {
  const { workspace, cleanup } = setupWorkspace();
  try {
    const config = getConfig(workspace);
    assert.equal(config.stopReviewGateMaxPerSession, null);
    assert.equal(config.stopReviewGateCooldownMinutes, null);
    assert.equal(config.stopReviewGate, false);
  } finally {
    cleanup();
  }
});

test("loadState merges throttle defaults into existing state without throttle keys", () => {
  const { workspace, cleanup } = setupWorkspace();
  try {
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        config: { stopReviewGate: true },
        jobs: []
      }),
      "utf8"
    );

    const state = loadState(workspace);
    assert.equal(state.config.stopReviewGate, true);
    assert.equal(state.config.stopReviewGateMaxPerSession, null);
    assert.equal(state.config.stopReviewGateCooldownMinutes, null);
  } finally {
    cleanup();
  }
});

// --- Throttle logic tests ---

test("checkThrottleLimits returns null when no limits are configured", () => {
  const config = { stopReviewGateMaxPerSession: null, stopReviewGateCooldownMinutes: null };
  const result = checkThrottleLimits(config, []);
  assert.equal(result, null);
});

test("checkThrottleLimits returns null when under session limit", () => {
  const config = { stopReviewGateMaxPerSession: 3, stopReviewGateCooldownMinutes: null };
  const jobs = [
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed" },
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed" }
  ];
  const result = checkThrottleLimits(config, jobs);
  assert.equal(result, null);
});

test("checkThrottleLimits blocks when session limit reached", () => {
  const config = { stopReviewGateMaxPerSession: 2, stopReviewGateCooldownMinutes: null };
  const jobs = [
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed" },
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed" }
  ];
  const result = checkThrottleLimits(config, jobs);
  assert.match(result, /session limit reached \(2\/2\)/);
});

test("checkThrottleLimits does not count running or queued jobs toward limit", () => {
  const config = { stopReviewGateMaxPerSession: 2, stopReviewGateCooldownMinutes: null };
  const jobs = [
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed" },
    { jobClass: "review", title: "Codex Stop Gate Review", status: "running" },
    { jobClass: "review", title: "Codex Stop Gate Review", status: "queued" }
  ];
  const result = checkThrottleLimits(config, jobs);
  assert.equal(result, null);
});

test("checkThrottleLimits ignores non-stop-gate review jobs", () => {
  const config = { stopReviewGateMaxPerSession: 1, stopReviewGateCooldownMinutes: null };
  const jobs = [
    { jobClass: "review", title: "Codex Review", status: "completed" },
    { jobClass: "review", title: "Codex Adversarial Review", status: "completed" }
  ];
  const result = checkThrottleLimits(config, jobs);
  assert.equal(result, null);
});

test("checkThrottleLimits blocks when cooldown is active", () => {
  const config = { stopReviewGateMaxPerSession: null, stopReviewGateCooldownMinutes: 10 };
  const recentTime = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
  const jobs = [
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed", completedAt: recentTime }
  ];
  const result = checkThrottleLimits(config, jobs);
  assert.match(result, /cooldown active/);
});

test("checkThrottleLimits allows when cooldown has elapsed", () => {
  const config = { stopReviewGateMaxPerSession: null, stopReviewGateCooldownMinutes: 5 };
  const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
  const jobs = [
    { jobClass: "review", title: "Codex Stop Gate Review", status: "completed", completedAt: oldTime }
  ];
  const result = checkThrottleLimits(config, jobs);
  assert.equal(result, null);
});

test("checkThrottleLimits allows when no previous stop-gate review exists for cooldown", () => {
  const config = { stopReviewGateMaxPerSession: null, stopReviewGateCooldownMinutes: 10 };
  const result = checkThrottleLimits(config, []);
  assert.equal(result, null);
});
