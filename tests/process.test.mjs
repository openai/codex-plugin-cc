import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  getProcessIdentity,
  isProcessRunning,
  isProcessTreeRunning,
  processHasLaunchSequence,
  runCommand,
  runCommandChecked,
  terminateProcessTree,
  waitForProcessExit
} from "../plugins/codex/scripts/lib/process.mjs";

const SELF_TERMINATING_SCRIPT = "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);";

test("runCommand reports a signal-terminated process as a failure", { skip: process.platform === "win32" }, () => {
  const result = runCommand(process.execPath, ["-e", SELF_TERMINATING_SCRIPT]);

  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, null);
});

test("runCommandChecked throws when the process dies from a signal", { skip: process.platform === "win32" }, () => {
  assert.throws(
    () => runCommandChecked(process.execPath, ["-e", SELF_TERMINATING_SCRIPT]),
    /signal=SIGTERM/
  );
});

test("Linux zombie processes are treated as exited even when signal 0 succeeds", () => {
  const running = isProcessRunning(1234, {
    platform: "linux",
    killImpl() {},
    readProcessStat() {
      return { state: "Z", startTime: "42" };
    }
  });

  assert.equal(running, false);
});

test("Linux processes with unreadable /proc metadata stay running", () => {
  const running = isProcessRunning(1234, {
    platform: "linux",
    identity: "42",
    killImpl() {},
    readProcessStat() {
      return null;
    }
  });

  assert.equal(running, true);
});

test("macOS process identity uses the process start time", () => {
  let captured = null;
  const identity = getProcessIdentity(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "Fri Jul 25 01:02:03 2026\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.deepEqual(captured, {
    command: "ps",
    args: ["-ww", "-p", "1234", "-o", "lstart="]
  });
  assert.equal(identity, "Fri Jul 25 01:02:03 2026");
});

test("Windows process identity uses PowerShell start-time ticks", () => {
  let capturedCommand = null;
  const identity = getProcessIdentity(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      capturedCommand = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "638890021230000000",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(capturedCommand.command, "powershell.exe");
  assert.match(capturedCommand.args.at(-1), /Get-Process -Id 1234/);
  assert.equal(identity, "638890021230000000");
});

test("non-Linux process identity distinguishes a reused PID", () => {
  const running = isProcessRunning(1234, {
    platform: "darwin",
    identity: "original-start",
    killImpl() {},
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "replacement-start\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(running, false);
});

test("process launch sequence fallback requires arguments in order", () => {
  const runCommandImpl = (command, args) => ({
    command,
    args,
    status: 0,
    signal: null,
    stdout: "node app-server-broker.mjs serve --endpoint pipe:broker --cwd /workspace --pid-file /tmp/broker.pid",
    stderr: "",
    error: null
  });

  assert.equal(
    processHasLaunchSequence(
      1234,
      ["serve", "--endpoint", "pipe:broker", "--cwd", "/workspace", "--pid-file", "/tmp/broker.pid"],
      { platform: "darwin", runCommandImpl }
    ),
    true
  );
  assert.equal(
    processHasLaunchSequence(1234, ["--cwd", "/workspace", "--endpoint", "pipe:broker"], {
      platform: "darwin",
      runCommandImpl
    }),
    false
  );
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

test("a dead group leader with a surviving descendant still counts as a running tree", { skip: process.platform === "win32" }, async () => {
  // The leader spawns a grandchild without detaching it: an un-detached
  // child inherits its parent's process group (standard POSIX fork/exec
  // behavior), so the grandchild keeps the leader's original group alive
  // long after the leader itself has exited and been reaped.
  const leaderScript = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    grandchild.unref();
    setTimeout(() => process.exit(0), 200);
  `;
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    leader.once("spawn", resolve);
    leader.once("error", reject);
  });
  const leaderPid = leader.pid;

  try {
    const recordedIdentity = getProcessIdentity(leaderPid);
    assert.ok(recordedIdentity, "expected a recordable identity while the leader is alive");

    // Poll for the leader's own exit instead of a fixed sleep: its script
    // exits itself after ~200ms, but scheduling jitter under test-suite load
    // must not make this flaky.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessRunning(leaderPid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isProcessRunning(leaderPid), false, "the leader should have exited and been reaped by now");

    // The leader is gone, but the grandchild it left behind is still in the
    // leader's original process group. A live descendant must still read as
    // a running tree, matched against the identity recorded while the
    // leader itself was alive.
    assert.equal(
      isProcessTreeRunning(leaderPid, { identity: recordedIdentity }),
      true,
      "a surviving descendant must keep the recorded process group alive"
    );
  } finally {
    // The leader is already dead; -leaderPid still addresses the process
    // group as long as at least one member (the grandchild) survives.
    try {
      process.kill(-leaderPid, "SIGTERM");
    } catch {
      // Group may already be gone.
    }
    let exited = await waitForProcessExit(leaderPid, { timeoutMs: 2000 });
    if (!exited) {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Already gone between the check above and here.
      }
      exited = await waitForProcessExit(leaderPid, { timeoutMs: 2000 });
    }
    assert.equal(exited, true, "cleanup must confirm the test process exited");
  }
});
