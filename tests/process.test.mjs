import test from "node:test";
import assert from "node:assert/strict";

import { binaryAvailable, commandWithWindowsShim, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";


test("commandWithWindowsShim avoids shell:true on Windows", () => {
  assert.deepEqual(
    commandWithWindowsShim("codex", ["app-server"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe"
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "call", "codex", "app-server"],
      shell: false
    }
  );
});

test("binaryAvailable uses cmd.exe explicitly for Windows command shims", () => {
  let captured = null;
  const outcome = binaryAvailable("npm", ["--version"], {
    platform: "win32",
    comspec: "C:\\Windows\\System32\\cmd.exe",
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "11.16.0\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.deepEqual(captured, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "call", "npm", "--version"],
    options: { cwd: undefined, env: undefined, shell: false }
  });
  assert.deepEqual(outcome, { available: true, detail: "11.16.0" });
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
    options: { cwd: undefined, env: undefined, shell: false }
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
        stdout: "ERROR: no se encontró el proceso \"1234\".",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.equal(outcome.delivered, false);
});
