import test from "node:test";
import assert from "node:assert/strict";

import { processHasLaunchToken, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("processHasLaunchToken verifies the recorded worker token", () => {
  let captured = null;
  const verified = processHasLaunchToken(1234, "worker-token-1234567890", {
    platform: "darwin",
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "node worker.mjs --worker-token worker-token-1234567890",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(verified, true);
  assert.deepEqual(captured, {
    command: "ps",
    args: ["-ww", "-p", "1234", "-o", "command="],
    options: { timeout: 2000, killSignal: "SIGTERM" }
  });
});

test("processHasLaunchToken fails closed when the token is absent", () => {
  const verified = processHasLaunchToken(1234, "worker-token-1234567890", {
    platform: "darwin",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "node unrelated.mjs",
        stderr: "",
        error: null
      };
    }
  });
  assert.equal(verified, false);
});

test("processHasLaunchToken uses bounded PowerShell lookup on Windows", () => {
  let captured = null;
  const verified = processHasLaunchToken(1234, "worker-token-1234567890", {
    platform: "win32",
    timeoutMs: 750,
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "node worker.mjs --worker-token worker-token-1234567890",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(verified, true);
  assert.equal(captured.command, "powershell.exe");
  assert.deepEqual(captured.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(captured.args[3], /ProcessId = 1234/);
  assert.deepEqual(captured.options, { timeout: 750, killSignal: "SIGTERM" });
});

test("processHasLaunchToken fails closed when Windows lookup times out", () => {
  const verified = processHasLaunchToken(1234, "worker-token-1234567890", {
    platform: "win32",
    runCommandImpl(command, args) {
      const error = new Error("timed out");
      error.code = "ETIMEDOUT";
      return { command, args, status: 1, signal: "SIGTERM", stdout: "", stderr: "", error };
    }
  });
  assert.equal(verified, false);
});

test("terminateProcessTree rejects unsafe process IDs", () => {
  for (const pid of [Number.NaN, 0, -1, 1.5]) {
    const outcome = terminateProcessTree(pid, {
      killImpl() {
        throw new Error("invalid process IDs must not be signalled");
      }
    });
    assert.deepEqual(outcome, { attempted: false, delivered: false, method: null });
  }
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
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
    args: ["/PID", "1234", "/T", "/F"],
    options: {
      cwd: undefined,
      env: undefined,
      timeout: 2000,
      killSignal: "SIGTERM"
    }
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
