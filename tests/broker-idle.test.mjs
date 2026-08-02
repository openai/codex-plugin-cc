import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  BROKER_IDLE_MS_ENV,
  createBrokerSessionDir,
  ensureBrokerSession,
  loadBrokerSession,
  readProcessStartTime,
  saveBrokerSession,
  spawnBrokerProcess,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { handleSessionEnd } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

const BROKER_SCRIPT = fileURLToPath(
  new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const waitForExit = (pid, timeoutMs) => waitFor(() => !isAlive(pid), timeoutMs);
const waitForFile = (filePath, timeoutMs) => waitFor(() => fs.existsSync(filePath), timeoutMs);

// A broker is spawned detached and outlives its parent, so before the idle timeout the
// only ways it ever exited were a `broker/shutdown` RPC and SIGTERM/SIGINT. Anything
// that lost track of one stranded it, and the codex stack under it, permanently.
test("a broker nobody connects to exits on its own", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" }
  });

  // Wait on the pid file, not the endpoint: probing the endpoint would connect and
  // disconnect, which is the other code path. Nothing here ever connects.
  // Record it the way ensureBrokerSession would, so the idle exit has something to clear.
  saveBrokerSession(cwd, { endpoint, pidFile, logFile, sessionDir, pid: child.pid });

  // Wait on the pid file, not the endpoint: probing the endpoint would connect and
  // disconnect, which is the other code path. Nothing here ever connects.
  assert.equal(await waitForFile(pidFile, 10000), true, "broker never came up");
  assert.equal(await waitForExit(child.pid, 10000), true, "broker was still alive after idling");
  assert.equal(fs.existsSync(pidFile), false, "the pid file outlived the broker");
  // `reuseExistingBroker` callers read this record without probing, so a survivor points
  // them at a dead socket instead of the direct spawn they fall back to when it is absent.
  assert.equal(loadBrokerSession(cwd), null, "broker.json outlived the broker");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// Only its own record: by the time an idle broker exits, a replacement may already own
// this cwd, and clearing that would strand the live one.
test("an idle broker leaves a replacement's session record alone", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const sessionDir = createBrokerSessionDir();
  const pidFile = path.join(sessionDir, "broker.pid");
  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile,
    logFile: path.join(sessionDir, "broker.log"),
    env: { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" }
  });
  assert.equal(await waitForFile(pidFile, 10000), true, "broker never came up");

  // A different broker's record, as a replacement would have written it.
  const otherDir = createBrokerSessionDir();
  const other = {
    endpoint: createBrokerEndpoint(otherDir),
    pidFile: path.join(otherDir, "broker.pid"),
    logFile: path.join(otherDir, "broker.log"),
    sessionDir: otherDir,
    pid: 999999
  };
  saveBrokerSession(cwd, other);

  assert.equal(await waitForExit(child.pid, 10000), true, "broker was still alive after idling");
  assert.deepEqual(loadBrokerSession(cwd), other, "it cleared someone else's record");

  for (const dir of [sessionDir, otherDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Replacing a stale broker deletes its pid, log and state files whether or not the
// process was killed -- so a survivor becomes invisible to every later reaper,
// including the SessionEnd hook, which finds brokers through the state file this path
// clears. Before the fix the sole production caller passed no killProcess at all.
test("replacing a stale broker kills the process it replaces", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" };

  const sessionDir = createBrokerSessionDir();
  const stale = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    env: { ...env, [BROKER_IDLE_MS_ENV]: "600000" }
  });
  assert.equal(await waitForFile(path.join(sessionDir, "broker.pid"), 10000), true);

  // Record it against an endpoint nothing is listening on: that is what a broker whose
  // endpoint went unreachable looks like to `ensureBrokerSession`.
  const unreachableDir = createBrokerSessionDir();
  saveBrokerSession(cwd, {
    endpoint: createBrokerEndpoint(unreachableDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: stale.pid,
    processStartTime: readProcessStartTime(stale.pid)
  });

  const killedPids = [];
  let replacement = null;
  try {
    replacement = await ensureBrokerSession(cwd, {
      scriptPath: BROKER_SCRIPT,
      env,
      terminateProcessTreeImpl(pid) {
        killedPids.push(pid);
        stale.kill("SIGTERM");
      }
    });

    assert.deepEqual(killedPids, [stale.pid], "the default broker terminator was not used");
    assert.equal(await waitForExit(stale.pid, 10000), true, "the replaced broker is still running");
  } finally {
    if (isAlive(stale.pid)) {
      stale.kill("SIGTERM");
    }
    await waitForExit(stale.pid, 10000);
    // The replacement self-reaps on its 300 ms idle timeout, but its session dir holds a
    // log file, so nothing removes it. A test in a leak fix does not get to leak.
    await waitForExit(replacement?.pid, 10000);
    for (const dir of [sessionDir, unreachableDir, replacement?.sessionDir]) {
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("replacing stale state does not kill a pid whose start time does not match", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" };
  const recycledPid = 424242;

  const sessionDir = createBrokerSessionDir();
  const unreachableDir = createBrokerSessionDir();
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, `${recycledPid}\n`, "utf8");
  fs.writeFileSync(logFile, "stale\n", "utf8");
  saveBrokerSession(cwd, {
    endpoint: createBrokerEndpoint(unreachableDir),
    pidFile,
    logFile,
    sessionDir,
    pid: recycledPid,
    processStartTime: "recorded-start"
  });

  const killedPids = [];
  let replacement = null;
  try {
    replacement = await ensureBrokerSession(cwd, {
      scriptPath: BROKER_SCRIPT,
      env,
      readProcessStartTime() {
        return "different-start";
      },
      killProcess(pid) {
        killedPids.push(pid);
      }
    });

    assert.deepEqual(killedPids, [], "a recycled pid was killed");
    assert.equal(fs.existsSync(pidFile), false, "the stale pid file survived");
    assert.equal(fs.existsSync(logFile), false, "the stale log file survived");
    assert.notEqual(loadBrokerSession(cwd)?.pid, recycledPid, "the stale state survived");
  } finally {
    if (replacement?.pid) {
      await waitForExit(replacement.pid, 10000);
    }
    for (const dir of [sessionDir, unreachableDir, replacement?.sessionDir]) {
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("session end does not kill a broker pid whose start time does not match", async () => {
  const cwd = makeTempDir();
  const sessionDir = createBrokerSessionDir();
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const recycledPid = 424242;
  fs.writeFileSync(pidFile, `${recycledPid}\n`, "utf8");
  fs.writeFileSync(logFile, "stale\n", "utf8");
  saveBrokerSession(cwd, {
    endpoint: null,
    pidFile,
    logFile,
    sessionDir,
    pid: recycledPid,
    processStartTime: "recorded-start"
  });

  const killedPids = [];
  await handleSessionEnd(
    { cwd, session_id: "identity-test" },
    {
      platform: "linux",
      readProcessStartTime() {
        return "different-start";
      },
      killImpl(pid) {
        killedPids.push(pid);
      }
    }
  );

  assert.deepEqual(killedPids, [], "the session hook killed a recycled pid");
  assert.equal(fs.existsSync(pidFile), false, "the stale pid file survived");
  assert.equal(fs.existsSync(logFile), false, "the stale log file survived");
  assert.equal(loadBrokerSession(cwd), null, "the stale session record survived");
});

// The endpoint wait does not watch the child, so a broker that dies at startup still
// costs the full timeout -- and node reaps it, freeing the pid for the whole window.
test("a broker that dies before its endpoint opens is not killed by pid", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const scriptDir = makeTempDir();
  const scriptPath = path.join(scriptDir, "broker-that-exits.mjs");
  fs.writeFileSync(scriptPath, "process.exit(1);\n", "utf8");

  const killedPids = [];
  const session = await ensureBrokerSession(cwd, {
    scriptPath,
    env: buildEnv(binDir),
    timeoutMs: 2000,
    killProcess(pid) {
      killedPids.push(pid);
    }
  });

  assert.equal(session, null, "a broker that never came up was reported ready");
  assert.deepEqual(killedPids, [], "a reaped pid was killed");
  assert.equal(loadBrokerSession(cwd), null, "a failed spawn left a session record");
});

test("process start-time probes are bounded and timeouts are unverifiable", () => {
  let captured = null;
  const timeoutError = new Error("probe timed out");
  timeoutError.code = "ETIMEDOUT";

  const startTime = readProcessStartTime(1234, {
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: timeoutError
      };
    }
  });

  assert.equal(startTime, null, "a timed-out probe was treated as verified");
  assert.equal(captured?.command, "powershell.exe");
  assert.equal(captured?.options.timeout, 2000, "the identity probe was not bounded");
  assert.equal(captured?.options.shell, false);
});

// The timeout must not fire under a connected client: a turn holds its socket open for
// its whole duration, so killing a broker with a live socket would kill a running job.
test("a connected client holds the broker open, and releases it on disconnect", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);

  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    env: { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" }
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true, "broker never came up");

  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(parseBrokerEndpoint(endpoint).path);
    s.on("connect", () => resolve(s));
    s.on("error", reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(isAlive(child.pid), true, "broker exited while a client was connected");

  socket.end();
  assert.equal(await waitForExit(child.pid, 10000), true, "broker survived its client");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// The file is now importable for tests, which means `main()` sits behind an entry-point guard.
// Get that guard wrong and the SessionEnd broker reaper becomes a silent no-op: exit 0, no output,
// nothing reaped. Nothing else in the suite would notice, so run the file the way hooks.json does.
test("the SessionEnd hook still runs when invoked the way hooks.json invokes it", async () => {
  const cwd = makeTempDir();
  const sessionDir = createBrokerSessionDir();
  saveBrokerSession(cwd, {
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: null // nothing to kill; this test is only about whether main() ran at all
  });
  assert.notEqual(loadBrokerSession(cwd), null, "precondition: the record exists");

  const hookScript = fileURLToPath(
    new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url)
  ).split(path.sep).join("/"); // exactly how hooks.json spells it

  const result = spawnSync(process.execPath, [hookScript, "SessionEnd"], {
    input: JSON.stringify({ cwd }),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBrokerSession(cwd), null, "the hook did not run: broker.json survived");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// Reaching the same script through a symlinked plugin root gives `process.argv[1]` the
// link path while `import.meta.url` resolves to the target, so an entry-point guard that
// compares the two literally stops running the hook at all -- silently, since a hook that
// exits 0 without doing anything looks exactly like a hook with nothing to do.
test("the SessionEnd hook still runs when its plugin root is a symlink", async () => {
  const cwd = makeTempDir();
  const sessionDir = createBrokerSessionDir();
  saveBrokerSession(cwd, {
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: null // nothing to kill; this test is only about whether main() ran at all
  });

  const scriptsDir = fileURLToPath(new URL("../plugins/codex/scripts", import.meta.url));
  // Deliberately not under `makeTempDir`: its exit reaper deletes recursively, and a link
  // to the real scripts directory is not something to hand a recursive delete.
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-link-"));
  const linkRoot = path.join(linkParent, "scripts");
  fs.symlinkSync(scriptsDir, linkRoot, "junction"); // "junction" is ignored off Windows

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(linkRoot, "session-lifecycle-hook.mjs"), "SessionEnd"],
      { input: JSON.stringify({ cwd }), encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(loadBrokerSession(cwd), null, "the hook did not run through the symlink");
  } finally {
    try {
      fs.unlinkSync(linkRoot);
    } catch {
      fs.rmdirSync(linkRoot); // Windows removes a junction this way, target untouched
    }
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
