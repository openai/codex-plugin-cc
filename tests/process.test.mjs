import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { isProcessAlive, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("isProcessAlive returns false for null and invalid pids", () => {
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-5), false);
  assert.equal(isProcessAlive(Number.NaN), false);
  assert.equal(isProcessAlive("123"), false);
});

test("isProcessAlive returns true for the current process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive returns false after a child has exited", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  // Give the kernel a moment to fully reap the entry on Linux/macOS.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isProcessAlive(pid), false);
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
