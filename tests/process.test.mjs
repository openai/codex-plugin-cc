import test from "node:test";
import assert from "node:assert/strict";

import { runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("runCommand enables shell on Windows for PATH-resolved commands", () => {
  let captured = null;

  const result = runCommand("codex", ["--version"], {
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: "codex-cli 0.0.0",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(captured.command, "codex");
  assert.deepEqual(captured.args, ["--version"]);
  assert.equal(captured.options.shell, true);
  assert.equal(result.status, 0);
});

test("runCommand does not force shell on non-Windows platforms", () => {
  let captured = null;

  runCommand("codex", ["--version"], {
    platform: "linux",
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: "codex-cli 0.0.0",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(captured.command, "codex");
  assert.deepEqual(captured.args, ["--version"]);
  assert.equal(captured.options.shell, false);
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
