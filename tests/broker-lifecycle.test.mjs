import assert from "node:assert/strict";
import test from "node:test";

import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const UNREACHABLE_ENDPOINT =
  process.platform === "win32"
    ? "pipe:\\\\.\\pipe\\codex-broker-lifecycle-test-does-not-exist"
    : "unix:/tmp/codex-broker-lifecycle-test-does-not-exist.sock";

test("waitForBrokerEndpoint returns false for an unreachable endpoint within the timeout", async () => {
  const start = Date.now();
  const ready = await waitForBrokerEndpoint(UNREACHABLE_ENDPOINT, 300);
  const elapsed = Date.now() - start;
  assert.equal(ready, false);
  // Should consume roughly the whole window (probe + 50ms backoff loop), not hang.
  assert.ok(elapsed >= 250 && elapsed < 2000, `unexpected elapsed ${elapsed}ms`);
});

test("waitForBrokerEndpoint bails immediately once the spawned broker has exited", async () => {
  // A child whose exitCode is already set means nothing will ever bind the
  // endpoint, so the wait must abandon early instead of burning the full timeout.
  const exitedChild = { exitCode: 1 };
  const start = Date.now();
  const ready = await waitForBrokerEndpoint(UNREACHABLE_ENDPOINT, 10000, exitedChild);
  const elapsed = Date.now() - start;
  assert.equal(ready, false);
  assert.ok(elapsed < 1000, `expected early bail, took ${elapsed}ms`);
});

test("waitForBrokerEndpoint keeps waiting while the spawned broker is still alive", async () => {
  // exitCode null => process still booting; the wait should run to the timeout.
  const liveChild = { exitCode: null };
  const start = Date.now();
  const ready = await waitForBrokerEndpoint(UNREACHABLE_ENDPOINT, 300, liveChild);
  const elapsed = Date.now() - start;
  assert.equal(ready, false);
  assert.ok(elapsed >= 250, `expected full wait, took ${elapsed}ms`);
});
