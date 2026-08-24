import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

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

test("terminateProcessTree throws on a genuine Windows taskkill failure, not just a missing-process one", () => {
  // A partial `taskkill /T` tree-kill failure (Windows refusing to kill a
  // subset of grandchild processes) does not match the "already gone"
  // regex, so it must still surface as a thrown error here -- callers like
  // handleCancel are responsible for deciding whether that's fatal to them,
  // not terminateProcessTree itself.
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        runCommandImpl(command, args) {
          return {
            command,
            args,
            status: 128,
            signal: null,
            stdout: "",
            stderr:
              "ERROR: The process with PID 25692 (child process of PID 27196) could not be terminated.\n" +
              "Reason: This operation is not supported.",
            error: null
          };
        }
      }),
    /could not be terminated/i
  );
});
