import test from "node:test";
import assert from "node:assert/strict";

import { runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("runCommand does not crash with ENOBUFS on large stdout", () => {
  // Generate output larger than Node's default 1 MB maxBuffer.
  // Uses Node itself for cross-platform compatibility (no `seq` on Windows).
  const result = runCommand(process.execPath, [
    "-e",
    "for(let i=0;i<200000;i++) process.stdout.write(i+'\\n')"
  ]);
  assert.equal(result.error, null, "should not error with ENOBUFS");
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length > 1_000_000, "stdout should exceed 1 MB");
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
