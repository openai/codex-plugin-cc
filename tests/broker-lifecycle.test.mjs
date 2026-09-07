import test from "node:test";
import assert from "node:assert/strict";

import { teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

test("teardownBrokerSession does not treat persisted pid metadata as process ownership", () => {
  const killed = [];

  teardownBrokerSession({
    pid: 1234,
    killProcess(pid) {
      killed.push(pid);
    }
  });

  assert.deepEqual(killed, []);
});

test("teardownBrokerSession may terminate a process explicitly owned by the caller", () => {
  const killed = [];

  teardownBrokerSession({
    ownedPid: 1234,
    killProcess(pid) {
      killed.push(pid);
    }
  });

  assert.deepEqual(killed, [1234]);
});
