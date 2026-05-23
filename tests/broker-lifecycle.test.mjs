import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { ensureBrokerSession, saveBrokerSession, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForExit(pid) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

function terminateTestProcess(pid) {
  if (!pid || !processExists(pid)) {
    return;
  }
  if (process.platform === "win32") {
    process.kill(pid, "SIGTERM");
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

test("ensureBrokerSession terminates a stale broker pid without an injected killer", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-stale-");
  const endpoint = createBrokerEndpoint(sessionDir, process.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const brokerScript = path.join(workspace, "app-server-broker.mjs");
  writeExecutable(brokerScript, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [brokerScript, "serve", "--endpoint", endpoint, "--cwd", workspace, "--pid-file", pidFile], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  fs.writeFileSync(logFile, "stale broker\n", "utf8");
  saveBrokerSession(workspace, {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid
  });
  const missingBroker = path.join(workspace, "missing-broker.mjs");

  try {
    const session = await ensureBrokerSession(workspace, {
      timeoutMs: 1,
      scriptPath: missingBroker
    });

    assert.equal(session, null);
    await waitForExit(child.pid);
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(fs.existsSync(logFile), false);
  } finally {
    terminateTestProcess(child.pid);
  }
});

test("ensureBrokerSession does not terminate a reused stale pid", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-reused-");
  const endpoint = createBrokerEndpoint(sessionDir, process.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  fs.writeFileSync(logFile, "stale broker\n", "utf8");
  saveBrokerSession(workspace, {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid
  });

  try {
    const session = await ensureBrokerSession(workspace, {
      timeoutMs: 1,
      scriptPath: path.join(workspace, "missing-broker.mjs")
    });

    assert.equal(session, null);
    assert.equal(processExists(child.pid), true);
  } finally {
    terminateTestProcess(child.pid);
  }
});

test("teardownBrokerSession validates broker identity on Windows before killing", () => {
  const sessionDir = makeTempDir("cxc-win-");
  const endpoint = createBrokerEndpoint(sessionDir, "win32");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "12345\n", "utf8");
  fs.writeFileSync(logFile, "broker log\n", "utf8");

  const killedPids = [];
  teardownBrokerSession({
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: 12345,
    platform: "win32",
    runCommandImpl(command, args) {
      assert.equal(command, "powershell");
      assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: `node app-server-broker.mjs serve --endpoint ${endpoint} --pid-file ${pidFile}\n`,
        stderr: "",
        error: null
      };
    },
    killProcess(pid) {
      killedPids.push(pid);
    }
  });

  assert.deepEqual(killedPids, [12345]);
});

test("ensureBrokerSession uses injected broker killers in tests", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-injected-");
  const endpoint = createBrokerEndpoint(sessionDir, process.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const brokerScript = path.join(workspace, "broker.mjs");
  fs.writeFileSync(pidFile, "12345\n", "utf8");
  fs.writeFileSync(logFile, "stale broker\n", "utf8");
  writeExecutable(brokerScript, "setInterval(() => {}, 1000);\n");
  saveBrokerSession(workspace, {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: 12345
  });

  const killedPids = [];
  try {
    const session = await ensureBrokerSession(workspace, {
      timeoutMs: 1,
      scriptPath: brokerScript,
      validateProcess() {
        return true;
      },
      killProcess(pid) {
        killedPids.push(pid);
        if (pid !== 12345) {
          terminateTestProcess(pid);
        }
      }
    });

    assert.equal(session, null);
    assert.equal(killedPids.includes(12345), true);
  } finally {
    for (const pid of killedPids) {
      if (pid !== 12345) {
        terminateTestProcess(pid);
      }
    }
  }
});
