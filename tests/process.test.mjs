import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { resolveExecutablePath, runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

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

function fakeExistsSync(realPaths) {
  // Windows filesystems are case-insensitive, so match the way the real
  // fs.existsSync would on a Windows machine.
  const set = new Set(realPaths.map((p) => p.toLowerCase()));
  return (candidate) => set.has(candidate.toLowerCase());
}

test("resolveExecutablePath is a no-op off Windows", () => {
  let existsSyncCalled = false;
  const resolved = resolveExecutablePath("codex", {
    platform: "linux",
    existsSync: () => {
      existsSyncCalled = true;
      return true;
    },
    pathEnv: "C:\\tools",
    pathExtEnv: ".EXE"
  });

  assert.equal(resolved, "codex");
  assert.equal(existsSyncCalled, false);
});

test("resolveExecutablePath leaves an already-absolute or path-qualified command alone", () => {
  assert.equal(
    resolveExecutablePath("C:\\tools\\codex.cmd", { platform: "win32", existsSync: () => false }),
    "C:\\tools\\codex.cmd"
  );
  assert.equal(
    resolveExecutablePath(".\\codex.cmd", { platform: "win32", existsSync: () => false }),
    ".\\codex.cmd"
  );
  assert.equal(
    resolveExecutablePath("sub/codex.cmd", { platform: "win32", existsSync: () => false }),
    "sub/codex.cmd"
  );
});

test("resolveExecutablePath finds an npm-style .cmd shim via PATH and PATHEXT, in PATHEXT order", () => {
  const resolved = resolveExecutablePath("codex", {
    platform: "win32",
    pathEnv: "C:\\nothing;C:\\tools",
    pathExtEnv: ".COM;.EXE;.BAT;.CMD",
    existsSync: fakeExistsSync(["C:\\tools\\codex.cmd"])
  });

  assert.equal(resolved, "C:\\tools\\codex.CMD");
});

test("resolveExecutablePath prefers an earlier PATH directory over a later one", () => {
  const resolved = resolveExecutablePath("git", {
    platform: "win32",
    pathEnv: "C:\\first;C:\\second",
    pathExtEnv: ".EXE",
    existsSync: fakeExistsSync(["C:\\first\\git.exe", "C:\\second\\git.exe"])
  });

  assert.equal(resolved, "C:\\first\\git.EXE");
});

test("resolveExecutablePath prefers an earlier PATHEXT extension over a later one in the same directory", () => {
  const resolved = resolveExecutablePath("tool", {
    platform: "win32",
    pathEnv: "C:\\tools",
    pathExtEnv: ".EXE;.CMD",
    existsSync: fakeExistsSync(["C:\\tools\\tool.exe", "C:\\tools\\tool.cmd"])
  });

  assert.equal(resolved, "C:\\tools\\tool.EXE");
});

test("resolveExecutablePath does not append another extension when the command already has a known one", () => {
  const resolved = resolveExecutablePath("codex.CMD", {
    platform: "win32",
    pathEnv: "C:\\tools",
    pathExtEnv: ".COM;.EXE;.BAT;.CMD",
    existsSync: fakeExistsSync(["C:\\tools\\codex.CMD.exe", "C:\\tools\\codex.CMD"])
  });

  assert.equal(resolved, "C:\\tools\\codex.CMD");
});

test("resolveExecutablePath respects a custom PATHEXT instead of the built-in default", () => {
  const resolved = resolveExecutablePath("tool", {
    platform: "win32",
    pathEnv: "C:\\tools",
    pathExtEnv: ".EXE",
    existsSync: fakeExistsSync(["C:\\tools\\tool.cmd"])
  });

  assert.equal(resolved, "tool");
});

test("resolveExecutablePath falls back to the bare command when nothing on PATH matches", () => {
  const resolved = resolveExecutablePath("missing-tool", {
    platform: "win32",
    pathEnv: "C:\\tools",
    pathExtEnv: ".EXE",
    existsSync: () => false
  });

  assert.equal(resolved, "missing-tool");
});

test("runCommand still runs a real command end to end", () => {
  const result = runCommand(process.execPath, ["--version"]);

  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^v\d+\.\d+\.\d+/);
});
