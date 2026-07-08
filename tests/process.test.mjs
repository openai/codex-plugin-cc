import test from "node:test";
import assert from "node:assert/strict";

import {
  formatCommandFailure,
  runCommand,
  runCommandChecked,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

test("runCommand reports a signal-terminated process as a non-zero failure", () => {
  const result = runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, "SIGKILL");
});

test("runCommandChecked throws when the child is killed by a signal", () => {
  assert.throws(
    () => runCommandChecked(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]),
    /signal=SIGKILL/
  );
});

test("runCommand still reports a clean exit as status 0", () => {
  const result = runCommand(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("runCommand preserves a non-zero exit code", () => {
  const result = runCommand(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(result.status, 3);
});

test("formatCommandFailure surfaces the signal for a signal-killed command", () => {
  const failure = formatCommandFailure({
    command: "git",
    args: ["status"],
    status: 1,
    signal: "SIGKILL",
    stdout: "",
    stderr: ""
  });
  assert.match(failure, /signal=SIGKILL/);
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
