import test from "node:test";
import assert from "node:assert/strict";

import { runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("runCommand allows output larger than Node's default maxBuffer", () => {
  const outputBytes = 2 * 1024 * 1024;
  const result = runCommand(process.execPath, [
    "-e",
    `process.stdout.write("x".repeat(${outputBytes}))`
  ]);

  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(Buffer.byteLength(result.stdout), outputBytes);
});

test("runCommand preserves an explicit maxBuffer override", () => {
  const result = runCommand(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(${2 * 1024}))`],
    { maxBuffer: 1024 }
  );

  assert.equal(result.error?.code, "ENOBUFS");
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
