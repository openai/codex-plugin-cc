import test from "node:test";
import assert from "node:assert/strict";

import process from "node:process";

import { binaryAvailable, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("binaryAvailable ignores a missing cwd for version probes", () => {
  const status = binaryAvailable(process.execPath, ["--version"], {
    cwd: "/does/not/exist"
  });

  assert.equal(status.available, true);
});

test("binaryAvailable still reports a missing binary when cwd is invalid", () => {
  const status = binaryAvailable("definitely-not-a-real-binary-xyz", ["--version"], {
    cwd: "/does/not/exist"
  });

  assert.equal(status.available, false);
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
