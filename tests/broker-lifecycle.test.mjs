import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  shutdownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree, waitForProcessExit } from "../plugins/codex/scripts/lib/process.mjs";

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isProcessGroupRunning(pid) {
  return isProcessRunning(-pid);
}

test("shutdown waits for the broker and app-server child to exit", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  let session = null;
  t.after(async () => {
    if (session?.pid && isProcessGroupRunning(session.pid)) {
      terminateProcessTree(session.pid);
      await waitForProcessExit(session.pid);
    }
  });

  installFakeCodex(binDir);
  initGitRepo(repo);

  session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    killProcess: terminateProcessTree
  });
  assert.ok(session?.pid);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.appServerStarts, 1);
  assert.equal(isProcessGroupRunning(session.pid), true);

  const outcome = await shutdownBrokerSession(repo, {
    session: { ...session, pid: null },
    killProcess: terminateProcessTree
  });

  assert.equal(outcome.found, true);
  assert.equal(outcome.exited, true);
  assert.equal(isProcessRunning(session.pid), false);
  assert.equal(isProcessGroupRunning(session.pid), false);
});

test("shutdown refuses endpoint-only state without an instance token", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  let session = null;
  t.after(async () => {
    if (session?.pid && isProcessGroupRunning(session.pid)) {
      terminateProcessTree(session.pid);
      await waitForProcessExit(session.pid);
    }
  });

  installFakeCodex(binDir);
  initGitRepo(repo);
  session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    killProcess: terminateProcessTree
  });
  assert.ok(session?.pid);
  assert.equal(isProcessGroupRunning(session.pid), true);

  await assert.rejects(
    shutdownBrokerSession(repo, {
      session: { ...session, pid: null, pidFile: null, instanceToken: null },
      killProcess: terminateProcessTree
    }),
    /ownership could not be verified/i
  );
  assert.equal(isProcessGroupRunning(session.pid), true);
});

test("shutdown rejects broker PID state that conflicts with the PID file", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  let session = null;
  t.after(async () => {
    if (session?.pid && isProcessGroupRunning(session.pid)) {
      terminateProcessTree(session.pid);
      await waitForProcessExit(session.pid);
    }
  });

  installFakeCodex(binDir);
  initGitRepo(repo);
  session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    killProcess: terminateProcessTree
  });
  assert.ok(session?.pid);

  await assert.rejects(
    shutdownBrokerSession(repo, {
      session: { ...session, pid: session.pid + 1 },
      killProcess: terminateProcessTree
    }),
    /PID mismatch/
  );
  assert.equal(isProcessGroupRunning(session.pid), true);
});

test("shutdown never force-kills when the broker token does not match", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  let session = null;
  t.after(async () => {
    if (session?.pid && isProcessGroupRunning(session.pid)) {
      terminateProcessTree(session.pid);
      await waitForProcessExit(session.pid);
    }
  });

  installFakeCodex(binDir);
  initGitRepo(repo);
  session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    killProcess: terminateProcessTree
  });
  assert.ok(session?.pid);
  let forceKills = 0;

  await assert.rejects(
    shutdownBrokerSession(repo, {
      session: { ...session, instanceToken: "wrong-instance-token" },
      killProcess() {
        forceKills += 1;
      }
    }),
    /rejected.*identity/i
  );
  assert.equal(forceKills, 0);
  assert.equal(isProcessGroupRunning(session.pid), true);
});

test("shutdown preserves a live mismatched endpoint when the persisted PID is stale", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  let session = null;
  t.after(async () => {
    if (session?.pid && isProcessGroupRunning(session.pid)) {
      terminateProcessTree(session.pid);
      await waitForProcessExit(session.pid);
    }
  });

  installFakeCodex(binDir);
  initGitRepo(repo);
  session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    killProcess: terminateProcessTree
  });
  assert.ok(session?.pid);
  const socketPath = session.endpoint.slice("unix:".length);

  await assert.rejects(
    shutdownBrokerSession(repo, {
      session: {
        ...session,
        pid: 999999,
        pidFile: null,
        instanceToken: "wrong-instance-token"
      },
      killProcess: terminateProcessTree
    }),
    /rejected.*identity/i
  );

  assert.equal(isProcessGroupRunning(session.pid), true);
  assert.equal(fs.existsSync(socketPath), true);
  assert.ok(loadBrokerSession(repo));
});

test("forced shutdown re-verifies broker ownership before signalling", { skip: process.platform === "win32" }, async (t) => {
  const sessionDir = makeTempDir("cxc-force-check-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const endpoint = `unix:${socketPath}`;
  const instanceToken = "instance-token-1234567890";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", () => {
      socket.write(`${JSON.stringify({ id: 1, result: { pid: 123, instanceToken } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });
  let forceKills = 0;

  await assert.rejects(
    shutdownBrokerSession(sessionDir, {
      session: { endpoint, pid: 123, pidFile: null, logFile: null, sessionDir, instanceToken },
      timeoutMs: 25,
      intervalMs: 5,
      killImpl() {},
      verifyProcess() {
        return false;
      },
      killProcess() {
        forceKills += 1;
      }
    }),
    /ownership changed/
  );
  assert.equal(forceKills, 0);
});

test("shutdown rejects an unverifiable broker without deleting its state", async () => {
  const cwd = makeTempDir();
  const sessionDir = makeTempDir("cxc-invalid-");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "123garbage\n", "utf8");
  fs.writeFileSync(logFile, "keep for diagnosis\n", "utf8");
  let killCalls = 0;

  await assert.rejects(
    shutdownBrokerSession(cwd, {
      session: { endpoint: null, pid: 0, pidFile, logFile, sessionDir },
      killProcess() {
        killCalls += 1;
      },
      timeoutMs: 25
    }),
    /did not exit/
  );
  assert.equal(killCalls, 0);
  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(logFile), true);
});

test("ensure preserves an unavailable persisted broker when ownership cannot be verified", async () => {
  const cwd = makeTempDir();
  const sessionDir = makeTempDir("cxc-unavailable-");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const session = {
    endpoint: `unix:${path.join(sessionDir, "missing.sock")}`,
    pid: 123,
    pidFile,
    logFile,
    sessionDir,
    instanceToken: "instance-token-unavailable-1234"
  };
  fs.writeFileSync(pidFile, "123\n", "utf8");
  fs.writeFileSync(logFile, "keep for diagnosis\n", "utf8");
  saveBrokerSession(cwd, session);

  await assert.rejects(
    ensureBrokerSession(cwd, {
      timeoutMs: 25,
      killImpl() {},
      verifyProcess() {
        return false;
      }
    }),
    /ownership.*could not be verified/i
  );

  assert.deepEqual(loadBrokerSession(cwd), session);
  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(logFile), true);
});
