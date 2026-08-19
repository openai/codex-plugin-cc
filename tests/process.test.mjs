import test from "node:test";
import assert from "node:assert/strict";

import { isProcessAlive, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("isProcessAlive treats successful and permission-denied probes as alive", () => {
  assert.equal(isProcessAlive(123, { killImpl() {} }), true);
  assert.equal(
    isProcessAlive(123, {
      killImpl() {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
    }),
    true
  );
});

test("isProcessAlive treats a missing process as dead", () => {
  assert.equal(
    isProcessAlive(123, {
      killImpl() {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    }),
    false
  );
});

test("process helpers reject unsafe process ids", () => {
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isProcessAlive(pid, { killImpl() { throw new Error("must not probe"); } }), false);
    assert.equal(terminateProcessTree(pid, { killImpl() { throw new Error("must not kill"); } }).attempted, false);
  }
});

test("terminateProcessTree falls back from a missing POSIX group to its leader", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid) {
      calls.push(pid);
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
  });
  assert.deepEqual(calls, [-1234, 1234]);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
