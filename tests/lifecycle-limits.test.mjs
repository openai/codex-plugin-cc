import test from "node:test";
import assert from "node:assert/strict";

import {
  brokerIdleShutdownMs,
  brokerStartupTimeoutMs,
  workerTtlMs
} from "../plugins/codex/scripts/lib/lifecycle-limits.mjs";

const TEN_MINUTES = 10 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

test("broker idle shutdown defaults to ten minutes", () => {
  assert.equal(brokerIdleShutdownMs({}), TEN_MINUTES);
  assert.equal(brokerIdleShutdownMs({ CODEX_BROKER_IDLE_SHUTDOWN_MS: "" }), TEN_MINUTES);
});

test("broker idle shutdown honours an override and can be disabled", () => {
  assert.equal(brokerIdleShutdownMs({ CODEX_BROKER_IDLE_SHUTDOWN_MS: "5000" }), 5000);
  assert.equal(brokerIdleShutdownMs({ CODEX_BROKER_IDLE_SHUTDOWN_MS: "0" }), 0);
});

test("broker idle shutdown falls back to the default on unusable input", () => {
  for (const raw of ["abc", "-1", "NaN", "   "]) {
    assert.equal(brokerIdleShutdownMs({ CODEX_BROKER_IDLE_SHUTDOWN_MS: raw }), TEN_MINUTES);
  }
});

test("broker startup timeout defaults to five minutes and is overridable", () => {
  assert.equal(brokerStartupTimeoutMs({}), FIVE_MINUTES);
  assert.equal(brokerStartupTimeoutMs({ CODEX_BROKER_STARTUP_TIMEOUT_MS: "1500" }), 1500);
  assert.equal(brokerStartupTimeoutMs({ CODEX_BROKER_STARTUP_TIMEOUT_MS: "0" }), 0);
});

test("worker ttl defaults to a day", () => {
  assert.equal(workerTtlMs({}), ONE_DAY);
  assert.equal(workerTtlMs({ CODEX_TASK_WORKER_TTL_MS: "" }), ONE_DAY);
});

test("worker ttl honours an override and can be disabled", () => {
  assert.equal(workerTtlMs({ CODEX_TASK_WORKER_TTL_MS: "1000" }), 1000);
  assert.equal(workerTtlMs({ CODEX_TASK_WORKER_TTL_MS: "0" }), 0);
});

test("worker ttl falls back to the default on unusable input", () => {
  for (const raw of ["soon", "-5", "NaN", "  "]) {
    assert.equal(workerTtlMs({ CODEX_TASK_WORKER_TTL_MS: raw }), ONE_DAY);
  }
});

test("durations are clamped to what setTimeout can actually hold", () => {
  // 30 days would truncate to a 32-bit int and fire almost immediately — killing precisely the
  // long-running work the operator meant to protect.
  const thirtyDays = String(30 * 24 * 60 * 60 * 1000);
  assert.equal(workerTtlMs({ CODEX_TASK_WORKER_TTL_MS: thirtyDays }), MAX_TIMEOUT_MS);
  assert.equal(brokerIdleShutdownMs({ CODEX_BROKER_IDLE_SHUTDOWN_MS: thirtyDays }), MAX_TIMEOUT_MS);
});
