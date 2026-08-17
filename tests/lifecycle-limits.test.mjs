import test from "node:test";
import assert from "node:assert/strict";

import {
  armTimeout,
  brokerIdleShutdownMs,
  brokerStartupTimeoutMs,
  disarmTimeout,
  workerTtlMs
} from "../plugins/codex/scripts/lib/lifecycle-limits.mjs";
import { isProcessAlive } from "../plugins/codex/scripts/lib/process.mjs";

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

test("a disabled limit never fires", async () => {
  // setTimeout(fn, 0) means "next tick", but 0 is our documented way to disable a limit. Passing
  // it straight through would turn "no ceiling" into "terminate immediately".
  let fired = false;
  const timer = armTimeout(0, () => {
    fired = true;
  });
  assert.equal(timer, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fired, false);
  disarmTimeout(timer); // must tolerate the null a disabled limit produces
});

test("an enabled limit fires and can be disarmed", async () => {
  let fired = false;
  const timer = armTimeout(5, () => {
    fired = true;
  });
  assert.notEqual(timer, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, true);

  let second = false;
  disarmTimeout(armTimeout(5, () => {
    second = true;
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(second, false);
});

test("liveness treats a permission error as alive and a missing pid as gone", () => {
  // A broker owned by another user still holds its socket; treating EPERM as "gone" would delete
  // a running broker's files.
  const eperm = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  const esrch = () => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
  assert.equal(isProcessAlive(1234, eperm), true);
  assert.equal(isProcessAlive(1234, esrch), false);
  assert.equal(isProcessAlive(1234, () => {}), true);
  for (const bad of [null, undefined, 0, -1, Number.NaN, "123"]) {
    assert.equal(isProcessAlive(bad, () => {}), false);
  }
  assert.equal(isProcessAlive(process.pid), true);
});

test("durations are clamped to what setTimeout can actually hold", () => {
  // 30 days would truncate to a 32-bit int and fire almost immediately — killing precisely the
  // long-running work the operator meant to protect.
  const thirtyDays = String(30 * 24 * 60 * 60 * 1000);
  assert.equal(workerTtlMs({ CODEX_TASK_WORKER_TTL_MS: thirtyDays }), MAX_TIMEOUT_MS);
  assert.equal(brokerIdleShutdownMs({ CODEX_BROKER_IDLE_SHUTDOWN_MS: thirtyDays }), MAX_TIMEOUT_MS);
});
