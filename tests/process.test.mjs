import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  buildSpawnCommand,
  resolveExecutablePath,
  resolveSpawnInvocation,
  runCommand,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

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

// Regression tests for the P2 finding on PR #669: CreateProcess's own
// documented search sequence for a bare command name is the loading app's
// directory, then "the current directory for the parent process", then the
// system/Windows directories, then PATH -- so a cwd-local copy should win
// over one on PATH, matching what running the same bare command from that
// directory would find, instead of only ever considering PATH.
test("resolveExecutablePath searches cwd before PATH directories", () => {
  const resolved = resolveExecutablePath("codex", {
    platform: "win32",
    cwd: "C:\\project",
    pathEnv: "C:\\tools",
    pathExtEnv: ".CMD",
    existsSync: fakeExistsSync(["C:\\project\\codex.cmd", "C:\\tools\\codex.cmd"])
  });

  assert.equal(resolved, "C:\\project\\codex.CMD");
});

test("resolveExecutablePath falls through to PATH when cwd has no match", () => {
  const resolved = resolveExecutablePath("codex", {
    platform: "win32",
    cwd: "C:\\project",
    pathEnv: "C:\\tools",
    pathExtEnv: ".CMD",
    existsSync: fakeExistsSync(["C:\\tools\\codex.cmd"])
  });

  assert.equal(resolved, "C:\\tools\\codex.CMD");
});

test("resolveExecutablePath resolves a relative PATH entry against cwd", () => {
  const resolved = resolveExecutablePath("codex", {
    platform: "win32",
    cwd: "C:\\project",
    pathEnv: "vendor\\bin",
    pathExtEnv: ".CMD",
    existsSync: fakeExistsSync(["C:\\project\\vendor\\bin\\codex.cmd"])
  });

  assert.equal(resolved, "C:\\project\\vendor\\bin\\codex.CMD");
});

test("resolveSpawnInvocation threads options.cwd through to prefer a cwd-local executable", () => {
  const invocation = resolveSpawnInvocation("codex", ["app-server"], {
    platform: "win32",
    cwd: "C:\\project",
    pathEnv: "C:\\tools",
    pathExtEnv: ".CMD",
    comspec: "cmd.exe",
    existsSync: fakeExistsSync(["C:\\project\\codex.cmd", "C:\\tools\\codex.cmd"])
  });

  assert.equal(invocation.args[3], '"C:\\project\\codex.CMD ^"app-server^""');
});

test("runCommand still runs a real command end to end", () => {
  const result = runCommand(process.execPath, ["--version"]);

  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^v\d+\.\d+\.\d+/);
});

// Regression tests for the P1 finding on PR #669: spawn()/spawnSync() with
// shell: false cannot launch a .bat/.cmd file at all, resolved path or not
// (Node's own docs: "`.bat` and `.cmd` files are not executable on their
// own without a terminal"). A resolved path alone is not sufficient --
// anything that isn't .exe/.com must be launched by explicitly spawning
// cmd.exe with the command line escaped the way cmd.exe itself requires.
test("buildSpawnCommand leaves a resolved .exe target unwrapped", () => {
  const result = buildSpawnCommand("C:\\tools\\git.exe", ["--version"], { platform: "win32" });

  assert.deepEqual(result, {
    command: "C:\\tools\\git.exe",
    args: ["--version"],
    windowsVerbatimArguments: undefined
  });
});

test("buildSpawnCommand leaves a resolved .COM target unwrapped (case-insensitive)", () => {
  const result = buildSpawnCommand("C:\\tools\\tool.COM", ["x"], { platform: "win32" });

  assert.equal(result.command, "C:\\tools\\tool.COM");
  assert.equal(result.windowsVerbatimArguments, undefined);
});

test("buildSpawnCommand is a no-op off Windows regardless of extension", () => {
  const result = buildSpawnCommand("codex.cmd", ["app-server"], { platform: "linux" });

  assert.deepEqual(result, {
    command: "codex.cmd",
    args: ["app-server"],
    windowsVerbatimArguments: undefined
  });
});

test("buildSpawnCommand wraps a resolved .cmd target through cmd.exe with escaped arguments", () => {
  const result = buildSpawnCommand("C:\\tools\\codex.cmd", ["app-server"], {
    platform: "win32",
    comspec: "cmd.exe"
  });

  assert.deepEqual(result, {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\tools\\codex.cmd ^"app-server^""'],
    windowsVerbatimArguments: true
  });
});

test("buildSpawnCommand defaults comspec to cmd.exe when not given", () => {
  const result = buildSpawnCommand("codex.cmd", ["app-server"], { platform: "win32" });

  assert.equal(result.command, "cmd.exe");
});

test("buildSpawnCommand double-escapes meta chars for an npm node_modules/.bin cmd shim", () => {
  const shimResult = buildSpawnCommand("C:\\proj\\node_modules\\.bin\\codex.cmd", ["--flag=a&b"], {
    platform: "win32",
    comspec: "cmd.exe"
  });
  const plainResult = buildSpawnCommand("C:\\tools\\codex.cmd", ["--flag=a&b"], {
    platform: "win32",
    comspec: "cmd.exe"
  });

  assert.deepEqual(shimResult.args, ["/d", "/s", "/c", '"C:\\proj\\node_modules\\.bin\\codex.cmd ^^^"--flag=a^^^&b^^^""'],);
  assert.deepEqual(plainResult.args, ["/d", "/s", "/c", '"C:\\tools\\codex.cmd ^"--flag=a^&b^""']);
});

test("resolveSpawnInvocation resolves the executable and wraps it through cmd.exe in one step", () => {
  const invocation = resolveSpawnInvocation("codex", ["app-server"], {
    platform: "win32",
    pathEnv: "C:\\tools",
    pathExtEnv: ".COM;.EXE;.BAT;.CMD",
    comspec: "cmd.exe",
    existsSync: fakeExistsSync(["C:\\tools\\codex.cmd"])
  });

  assert.equal(invocation.command, "cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(invocation.args[3], '"C:\\tools\\codex.CMD ^"app-server^""');
});

test("resolveSpawnInvocation prefers options.env's PATH/PATHEXT/comspec over process.env's", () => {
  const invocation = resolveSpawnInvocation("codex", ["app-server"], {
    platform: "win32",
    env: {
      PATH: "C:\\childpath",
      PATHEXT: ".EXE",
      comspec: "C:\\child\\cmd.exe"
    },
    existsSync: fakeExistsSync(["C:\\childpath\\codex.EXE"])
  });

  assert.equal(invocation.command, "C:\\childpath\\codex.EXE");
  assert.equal(invocation.args[0], "app-server");
  assert.equal(invocation.windowsVerbatimArguments, undefined);
});

test("resolveSpawnInvocation uses options.env's comspec when the resolved target needs cmd.exe wrapping", () => {
  const invocation = resolveSpawnInvocation("codex", ["app-server"], {
    platform: "win32",
    env: {
      PATH: "C:\\childpath",
      PATHEXT: ".CMD",
      comspec: "C:\\child\\cmd.exe"
    },
    existsSync: fakeExistsSync(["C:\\childpath\\codex.CMD"])
  });

  assert.equal(invocation.command, "C:\\child\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
});
