import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  shutdownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  getProcessIdentity,
  isProcessRunning,
  isProcessTreeRunning,
  terminateProcessTree,
  waitForProcessExit
} from "../plugins/codex/scripts/lib/process.mjs";
import {
  acquireLock,
  releaseLock
} from "../plugins/codex/scripts/lib/locking.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

test("concurrent ensureBrokerSession calls share a single authenticated broker", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const [left, right] = await Promise.all([
    ensureBrokerSession(workspace, { env }),
    ensureBrokerSession(workspace, { env })
  ]);

  assert.ok(left, "first ensureBrokerSession returned no session");
  assert.ok(right, "second ensureBrokerSession returned no session");
  assert.equal(left.endpoint, right.endpoint);
  assert.equal(left.pid, right.pid);
  assert.equal(left.instanceToken, right.instanceToken);

  const persisted = loadBrokerSession(workspace);
  assert.ok(persisted);
  assert.equal(persisted.endpoint, left.endpoint);
  assert.equal(persisted.instanceToken, left.instanceToken);

  const outcome = await shutdownBrokerSession(workspace, {
    killProcess: terminateProcessTree
  });
  assert.equal(outcome.exited, true);
  assert.equal(loadBrokerSession(workspace), null);
});

test("shutdown waits for the broker lock and reloads persisted state", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = await acquireLock(path.join(stateDir, ".broker.lock"));
  let settled = false;

  try {
    const shutdown = shutdownBrokerSession(workspace);
    shutdown.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "shutdown bypassed the broker lifecycle lock");

    saveBrokerSession(workspace, {
      endpoint: `unix:${path.join(workspace, "missing.sock")}`,
      pid: null,
      pidFile: null,
      logFile: null,
      sessionDir: null
    });
    releaseLock(lock);

    const outcome = await shutdown;
    assert.equal(outcome.found, true);
    assert.equal(loadBrokerSession(workspace), null);
  } finally {
    releaseLock(lock);
  }
});

test("broker rejects a shutdown token that does not identify its instance", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  assert.ok(session?.pid);

  t.after(async () => {
    if (loadBrokerSession(workspace)) {
      await shutdownBrokerSession(workspace, {
        killProcess: terminateProcessTree
      });
    }
  });

  const response = await sendBrokerShutdown(session.endpoint, {
    instanceToken: "wrong-instance-token",
    timeoutMs: 500
  });

  assert.match(response?.error?.message ?? "", /identity did not match/i);
  assert.equal(isProcessTreeRunning(session.pid), true);
  assert.ok(loadBrokerSession(workspace));
});

test("shutdown closes idle half-open broker clients", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  const idleClient = net.createConnection({
    path: session.endpoint.slice("unix:".length),
    allowHalfOpen: true
  });
  idleClient.on("end", () => {});
  await new Promise((resolve, reject) => {
    idleClient.once("connect", resolve);
    idleClient.once("error", reject);
  });
  t.after(() => idleClient.destroy());

  const outcome = await shutdownBrokerSession(workspace, {
    timeoutMs: 500,
    intervalMs: 10,
    killProcess: terminateProcessTree
  });

  assert.equal(outcome.exited, true);
  assert.equal(outcome.forced, false);
  assert.equal(loadBrokerSession(workspace), null);
});

test("shutdown request always uses a finite deadline", { skip: process.platform === "win32" }, async (t) => {
  const sessionDir = makeTempDir("cxc-unresponsive-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      // Deliberately never answer.
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  for (const timeoutMs of [0, 40]) {
    const startedAt = Date.now();
    const response = await sendBrokerShutdown(`unix:${socketPath}`, {
      instanceToken: "instance-token-1234567890",
      timeoutMs
    });
    assert.equal(response, null);
    assert.ok(Date.now() - startedAt < 500, "shutdown request exceeded its deadline");
  }
  assert.equal(fs.existsSync(socketPath), true);
});

test("shutdown preserves an unowned endpoint and its persisted state", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-unowned-");
  const socketPath = path.join(sessionDir, "fake-broker.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  const session = {
    endpoint: `unix:${socketPath}`,
    pid: null,
    pidFile: null,
    logFile: null,
    sessionDir
  };
  saveBrokerSession(workspace, session);

  await assert.rejects(
    shutdownBrokerSession(workspace, {
      timeoutMs: 40,
      killProcess: terminateProcessTree
    }),
    /ownership could not be verified/i
  );

  assert.equal(fs.existsSync(socketPath), true);
  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("shutdown never removes artifacts outside a private broker session", async () => {
  const workspace = makeTempDir();
  const externalDir = makeTempDir("not-a-broker-session-");
  const externalFile = path.join(externalDir, "preserve.txt");
  fs.writeFileSync(externalFile, "preserve me\n");
  saveBrokerSession(workspace, {
    endpoint: `unix:${path.join(externalDir, "missing.sock")}`,
    pid: null,
    pidFile: externalFile,
    logFile: null,
    sessionDir: externalDir
  });

  const outcome = await shutdownBrokerSession(workspace);

  assert.equal(outcome.exited, true);
  assert.equal(fs.readFileSync(externalFile, "utf8"), "preserve me\n");
  assert.equal(loadBrokerSession(workspace), null);
});

test("shutdown never follows a private-session symlink", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const externalDir = makeTempDir("not-a-broker-session-");
  const externalPidFile = path.join(externalDir, "broker.pid");
  const sessionLink = makeTempDir("cxc-");
  fs.writeFileSync(externalPidFile, "preserve me\n");
  fs.rmdirSync(sessionLink);
  fs.symlinkSync(externalDir, sessionLink, "dir");
  t.after(() => fs.unlinkSync(sessionLink));

  saveBrokerSession(workspace, {
    endpoint: `unix:${path.join(sessionLink, "missing.sock")}`,
    pid: null,
    pidFile: path.join(sessionLink, "broker.pid"),
    logFile: null,
    sessionDir: sessionLink
  });

  const outcome = await shutdownBrokerSession(workspace);

  assert.equal(outcome.exited, true);
  assert.equal(fs.readFileSync(externalPidFile, "utf8"), "preserve me\n");
  assert.equal(loadBrokerSession(workspace), null);
});

async function spawnLegacyBroker(t, { socketPath, pidFile, endpoint, cwdArg, ackShutdown = true }) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const net = require("node:net");
       const socketPath = ${JSON.stringify(socketPath)};
       const pidFile = ${JSON.stringify(pidFile)};
       const ackShutdown = ${JSON.stringify(ackShutdown)};
       fs.writeFileSync(pidFile, String(process.pid));
       const server = net.createServer((socket) => {
         socket.setEncoding("utf8");
         let buffer = "";
         socket.on("data", (chunk) => {
           buffer += chunk;
           if (!buffer.includes("\\n")) return;
           const request = JSON.parse(buffer.slice(0, buffer.indexOf("\\n")));
           if (request.method !== "broker/shutdown" || !ackShutdown) return;
           socket.end(JSON.stringify({ id: request.id, result: {} }) + "\\n", () => {
             server.close(() => process.exit(0));
           });
         });
       });
       server.listen(socketPath, () => process.stdout.write("ready\\n"));`,
      "serve",
      "--endpoint",
      endpoint,
      "--cwd",
      cwdArg,
      "--pid-file",
      pidFile
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("legacy broker exited before binding")));
  });
  t.after(() => {
    if (isProcessTreeRunning(child.pid)) {
      terminateProcessTree(child.pid);
    }
  });
  return child;
}

test("shutdown retires a live tokenless broker left by the previous version", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-legacy-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = `unix:${socketPath}`;
  const child = await spawnLegacyBroker(t, { socketPath, pidFile, endpoint, cwdArg: workspace });

  const session = {
    endpoint,
    pid: child.pid,
    pidFile,
    logFile: null,
    sessionDir
  };
  saveBrokerSession(workspace, session);

  const outcome = await shutdownBrokerSession(workspace, {
    timeoutMs: 500,
    intervalMs: 10,
    killProcess: terminateProcessTree
  });

  assert.equal(outcome.exited, true);
  assert.equal(outcome.forced, false);
  assert.equal(loadBrokerSession(workspace), null);
  assert.equal(fs.existsSync(socketPath), false);
});

test("shutdown retires a legacy broker launched from a different workspace path", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-legacy-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = `unix:${socketPath}`;
  // The previous plugin version may have launched the broker with a --cwd
  // that addressed this workspace through another path (subdirectory,
  // symlink). Ownership must not depend on the current invocation path.
  const originalCwd = path.join(workspace, "nested", "launch-dir");
  fs.mkdirSync(originalCwd, { recursive: true });
  const child = await spawnLegacyBroker(t, { socketPath, pidFile, endpoint, cwdArg: originalCwd });

  saveBrokerSession(workspace, {
    endpoint,
    pid: child.pid,
    pidFile,
    logFile: null,
    sessionDir
  });

  const outcome = await shutdownBrokerSession(workspace, {
    timeoutMs: 500,
    intervalMs: 10,
    killProcess: terminateProcessTree
  });

  assert.equal(outcome.exited, true);
  assert.equal(loadBrokerSession(workspace), null);
  assert.equal(fs.existsSync(socketPath), false);
});

test("shutdown force-kills a verified legacy broker that ignores shutdown requests", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-legacy-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = `unix:${socketPath}`;
  const child = await spawnLegacyBroker(t, {
    socketPath,
    pidFile,
    endpoint,
    cwdArg: workspace,
    ackShutdown: false
  });

  saveBrokerSession(workspace, {
    endpoint,
    pid: child.pid,
    pidFile,
    logFile: null,
    sessionDir
  });

  const outcome = await shutdownBrokerSession(workspace, {
    timeoutMs: 500,
    intervalMs: 10,
    killProcess: terminateProcessTree
  });

  assert.equal(outcome.exited, true);
  assert.equal(outcome.forced, true);
  assert.equal(loadBrokerSession(workspace), null);
  assert.equal(fs.existsSync(socketPath), false);
});

test("shutdown does not retire an authenticated broker whose persisted token was lost", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const authenticatedSession = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  assert.ok(authenticatedSession?.instanceToken);
  t.after(async () => {
    saveBrokerSession(workspace, authenticatedSession);
    await shutdownBrokerSession(workspace, {
      killProcess: terminateProcessTree
    });
  });

  const { instanceToken: _lostToken, ...tokenlessState } = authenticatedSession;
  saveBrokerSession(workspace, tokenlessState);

  await assert.rejects(
    shutdownBrokerSession(workspace, {
      timeoutMs: 200,
      killProcess: terminateProcessTree
    }),
    /rejected shutdown identity/i
  );

  assert.equal(isProcessTreeRunning(authenticatedSession.pid), true);
  assert.deepEqual(loadBrokerSession(workspace), tokenlessState);
});

test("broker metadata, pid, and log files are private", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  assert.ok(session);

  const persistedStateFile = path.join(resolveStateDir(workspace), "broker.json");

  assert.equal(fs.statSync(session.sessionDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(session.pidFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(session.logFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(persistedStateFile).mode & 0o777, 0o600);

  await shutdownBrokerSession(workspace, {
    killProcess: terminateProcessTree
  });
});

async function spawnSocketHolder(socketPath) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net");
       const server = net.createServer();
       server.listen(${JSON.stringify(socketPath)}, () => process.stdout.write("ready\\n"));
       setInterval(() => {}, 60000);`
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("socket holder exited before binding")));
  });
  return child;
}

test("shutdown reclaims the socket of an owned broker that died without acking", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-stale-");
  const socketPath = path.join(sessionDir, "broker.sock");

  // Killing the holder with SIGKILL skips its cleanup, so the socket file stays
  // on disk with nothing listening — exactly what a crashed broker leaves behind.
  const holder = await spawnSocketHolder(socketPath);
  const deadPid = holder.pid;
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.equal(fs.existsSync(socketPath), true, "stale socket should survive the kill");

  const session = {
    endpoint: `unix:${socketPath}`,
    pid: deadPid,
    pidFile: null,
    logFile: null,
    sessionDir,
    instanceToken: "stale-instance-token"
  };
  saveBrokerSession(workspace, session);

  const outcome = await shutdownBrokerSession(workspace, {
    timeoutMs: 40,
    killProcess: terminateProcessTree
  });

  assert.equal(outcome.exited, true);
  assert.equal(outcome.reclaimedStaleEndpoint, true);
  assert.equal(fs.existsSync(socketPath), false, "stale socket should be unlinked");
  assert.equal(loadBrokerSession(workspace), null);
});

test("ensureBrokerSession recovers from a stale socket instead of failing", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-stale-ensure-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const holder = await spawnSocketHolder(socketPath);
  const deadPid = holder.pid;
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));

  saveBrokerSession(workspace, {
    endpoint: `unix:${socketPath}`,
    pid: deadPid,
    pidFile: null,
    logFile: null,
    sessionDir,
    instanceToken: "stale-instance-token"
  });

  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  t.after(async () => {
    if (session) {
      await shutdownBrokerSession(workspace, { killProcess: terminateProcessTree });
    }
  });

  assert.ok(session, "a stale socket must not block the replacement broker");
  assert.notEqual(session.endpoint, `unix:${socketPath}`);
});

test("ensureBrokerSession fails cleanly when the broker process cannot spawn", async () => {
  const workspace = makeTempDir();
  // spawn() launches the broker with `cwd` as the child's working directory.
  // Deleting it after makeTempDir() reproduces a workspace that vanishes
  // between the caller's check and the spawn: Node cannot fail synchronously
  // here, it emits an asynchronous "error" event (ENOENT) instead.
  fs.rmSync(workspace, { recursive: true, force: true });

  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("cxc-")));

  await assert.rejects(() => ensureBrokerSession(workspace, { env: process.env }), /failed to spawn/);

  assert.equal(
    loadBrokerSession(workspace),
    null,
    "a spawn failure must never persist a tokenized session with pid: null, or shutdown wedges permanently"
  );

  const after = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("cxc-")));
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], "the failed attempt's temporary session directory must not be left behind");
});

test("shutdown still refuses to unlink an endpoint someone is listening on", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-live-listener-");
  const socketPath = path.join(sessionDir, "broker.sock");

  // Dead PID, but a live listener owns the path: reclaiming would delete the
  // socket of an unrelated process, so the shutdown must keep failing.
  const holder = await spawnSocketHolder(socketPath);
  const stalePid = holder.pid;
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
  // A listener that accepts but never answers — the shape of a hung broker. Its
  // sockets must be tracked: server.close() waits for every accepted connection
  // to end, and the shutdown request leaves one open.
  const accepted = new Set();
  const server = net.createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of accepted) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  const session = {
    endpoint: `unix:${socketPath}`,
    pid: stalePid,
    pidFile: null,
    logFile: null,
    sessionDir,
    instanceToken: "stale-instance-token"
  };
  saveBrokerSession(workspace, session);

  await assert.rejects(
    shutdownBrokerSession(workspace, {
      timeoutMs: 40,
      killProcess: terminateProcessTree
    }),
    /ownership could not be verified/i
  );

  assert.equal(fs.existsSync(socketPath), true);
  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("a refused endpoint alone does not justify reclaiming while the owner lives", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-live-owner-");
  const socketPath = path.join(sessionDir, "broker.sock");

  // Live owner, refused endpoint: the socket file exists but nothing listens on
  // it, which on its own looks exactly like the stale case. The recorded PID is
  // still running, so the shutdown must not unlink anything.
  const holder = await spawnSocketHolder(socketPath);
  t.after(() => {
    holder.kill("SIGKILL");
  });
  fs.unlinkSync(socketPath);
  fs.writeFileSync(socketPath, "");

  const session = {
    endpoint: `unix:${socketPath}`,
    pid: holder.pid,
    pidFile: null,
    logFile: null,
    sessionDir,
    instanceToken: "live-owner-token"
  };
  saveBrokerSession(workspace, session);

  await assert.rejects(
    shutdownBrokerSession(workspace, {
      timeoutMs: 40,
      killProcess: () => {}
    }),
    /ownership could not be verified|did not exit/i
  );

  assert.equal(fs.existsSync(socketPath), true);
  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("an endpoint outside the plugin session directory is never reclaimed", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-outside-");
  const elsewhere = makeTempDir("not-a-session-dir-");
  const socketPath = path.join(elsewhere, "broker.sock");

  const holder = await spawnSocketHolder(socketPath);
  const deadPid = holder.pid;
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.equal(fs.existsSync(socketPath), true);

  // Everything else looks reclaimable — dead PID, refused connect — but the
  // endpoint does not live under the session directory we created.
  const session = {
    endpoint: `unix:${socketPath}`,
    pid: deadPid,
    pidFile: null,
    logFile: null,
    sessionDir,
    instanceToken: "outside-token"
  };
  saveBrokerSession(workspace, session);

  await assert.rejects(
    shutdownBrokerSession(workspace, {
      timeoutMs: 40,
      killProcess: terminateProcessTree
    }),
    /ownership could not be verified/i
  );

  assert.equal(fs.existsSync(socketPath), true, "foreign socket must survive");
  fs.unlinkSync(socketPath);
});

test("shutdown aborts instead of silently skipping an unreadable pid file", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-unreadable-pid-");
  const pidFile = path.join(sessionDir, "broker.pid");
  // A directory at the pid file path makes the read fail with EISDIR instead
  // of ENOENT, exercising the "any other failure must abort" branch of
  // resolveBrokerPid() rather than the "file genuinely absent" branch.
  fs.mkdirSync(pidFile);

  // Deliberately no instanceToken: this session can never be cleaned up
  // through shutdownBrokerSession() (the unreadable pid file always aborts
  // it, by design), so it must stay invisible to the global owned-broker
  // teardown in tests/helpers.mjs, which only acts on sessions carrying one.
  const session = {
    endpoint: `unix:${path.join(sessionDir, "broker.sock")}`,
    pid: null,
    pidFile,
    logFile: null,
    sessionDir
  };
  saveBrokerSession(workspace, session);

  await assert.rejects(
    shutdownBrokerSession(workspace, { timeoutMs: 40 }),
    (error) => error?.code === "EISDIR"
  );

  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("ensureBrokerSession tears down a spawned child when persisting the session fails", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  // Occupies the broker.json path with a directory so saveBrokerSession's
  // rename-into-place fails with EISDIR only after the child has already
  // spawned successfully.
  const brokerStateFile = path.join(stateDir, "broker.json");
  fs.mkdirSync(brokerStateFile);

  const killedPids = [];
  const killProcess = (pid) => {
    killedPids.push(pid);
    return terminateProcessTree(pid);
  };

  // Capture the exact session directory ensureBrokerSessionLocked creates
  // via the same injection point other tests use, instead of diffing
  // os.tmpdir() -- concurrent test files also create cxc-* directories, so a
  // tmpdir-wide before/after snapshot races with them.
  let capturedSessionDir = null;
  const createBrokerEndpointSpy = (sessionDir, platform) => {
    capturedSessionDir = sessionDir;
    return createBrokerEndpoint(sessionDir, platform);
  };

  await assert.rejects(
    ensureBrokerSession(workspace, { env: buildEnv(binDir), killProcess, createBrokerEndpoint: createBrokerEndpointSpy })
  );

  assert.equal(killedPids.length, 1, "the spawned child must be killed exactly once");
  assert.ok(Number.isSafeInteger(killedPids[0]) && killedPids[0] > 0);

  assert.ok(capturedSessionDir, "ensureBrokerSession must have created a session directory");
  assert.equal(
    fs.existsSync(capturedSessionDir),
    false,
    "the session directory of the failed persist must not be left behind"
  );

  assert.equal(loadBrokerSession(workspace), null);
  assert.equal(fs.existsSync(brokerStateFile), true, "the blocking directory itself is left untouched");
  assert.equal(fs.statSync(brokerStateFile).isDirectory(), true);
});

test("shutdown treats a reused PID as exited once the recorded identity stops matching", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-reused-pid-");
  const socketPath = path.join(sessionDir, "broker.sock");

  // A detached process is its own process-group leader (unlike this test's
  // own process under `node --test`, which is not) -- exactly the shape of
  // an impostor that reused a dead broker's PID and became an unrelated new
  // group leader. Its real identity can never equal the bogus one recorded
  // below, so liveness must be resolved from session.processIdentity rather
  // than group membership alone, which would otherwise read it as running.
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    dummy.once("spawn", resolve);
    dummy.once("error", reject);
  });
  t.after(async () => {
    if (!isProcessTreeRunning(dummy.pid)) {
      return;
    }
    terminateProcessTree(dummy.pid);
    let exited = await waitForProcessExit(dummy.pid, { timeoutMs: 2000 });
    if (!exited) {
      try {
        process.kill(-dummy.pid, "SIGKILL");
      } catch {
        // Already gone between the check above and here.
      }
      exited = await waitForProcessExit(dummy.pid, { timeoutMs: 2000 });
    }
    assert.equal(exited, true, "cleanup must confirm the test process exited");
  });

  const session = {
    endpoint: `unix:${socketPath}`,
    pid: dummy.pid,
    pidFile: null,
    logFile: null,
    sessionDir,
    instanceToken: "reused-pid-token",
    processIdentity: "reused-pid-identity-mismatch"
  };
  saveBrokerSession(workspace, session);

  const outcome = await shutdownBrokerSession(workspace, { timeoutMs: 40 });

  assert.equal(outcome.found, true);
  assert.equal(outcome.exited, true);
  assert.equal(outcome.forced, false);
  assert.equal(loadBrokerSession(workspace), null);
});

test("ensureBrokerSession preserves session artifacts when the killed child does not actually exit", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  // Same EISDIR trigger as the sibling test above, just paired here with a
  // killProcess that does not actually stop the child, to exercise the
  // "kill was denied or too slow" branch of the failed-persist unwind.
  const brokerStateFile = path.join(stateDir, "broker.json");
  fs.mkdirSync(brokerStateFile);

  let killedPid = null;
  const killProcess = (pid) => {
    killedPid = pid;
    // Deliberately a no-op: simulates a kill signal that was denied or did
    // not land in time. The child stays alive.
  };

  // Capture the exact session directory via the same injection point other
  // tests use, instead of diffing os.tmpdir() -- concurrent test files also
  // create cxc-* directories, so a tmpdir-wide before/after snapshot races
  // with them.
  let sessionDir = null;
  const createBrokerEndpointSpy = (dir, platform) => {
    sessionDir = dir;
    return createBrokerEndpoint(dir, platform);
  };

  try {
    await assert.rejects(
      ensureBrokerSession(workspace, {
        env: buildEnv(binDir),
        killProcess,
        timeoutMs: 150,
        createBrokerEndpoint: createBrokerEndpointSpy
      }),
      /did not exit.*artifacts were preserved/i
    );

    assert.ok(Number.isSafeInteger(killedPid) && killedPid > 0, "killProcess must have been invoked with the child pid");
    assert.equal(isProcessTreeRunning(killedPid), true, "the child must still be alive for this branch to be exercised");

    assert.ok(sessionDir, "ensureBrokerSession must have created a session directory");
    assert.equal(fs.existsSync(sessionDir), true, "the session directory must not be torn down while the child is still alive");

    assert.equal(fs.existsSync(brokerStateFile), true, "the blocking directory itself is left untouched");
    assert.equal(fs.statSync(brokerStateFile).isDirectory(), true);
  } finally {
    // The injected killProcess deliberately did nothing, so the real child is
    // still running: terminate and reap it for real before the test exits,
    // then remove the preserved session directory ourselves so this test's
    // deliberate leak does not confuse the leak-detection windows of other
    // tests running in the same tmpdir. Only rmSync after confirming exit --
    // otherwise a still-alive process could recreate files under sessionDir
    // after we remove it.
    if (killedPid) {
      terminateProcessTree(killedPid);
      let exited = await waitForProcessExit(killedPid, { timeoutMs: 2000 });
      if (!exited) {
        try {
          process.kill(-killedPid, "SIGKILL");
        } catch {
          // Already gone between the check above and here.
        }
        exited = await waitForProcessExit(killedPid, { timeoutMs: 2000 });
      }
      assert.equal(exited, true, "cleanup must confirm the test process exited");
    }
    if (sessionDir) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
});

// Spawns a detached leader (its own process group) that binds the broker
// endpoint socket and spawns a non-detached grandchild -- inheriting the
// leader's process group, per standard POSIX fork/exec -- so the grandchild
// keeps the group alive long after the leader itself is killed. This is the
// exact "abandoned orphaned tree" shape CHANGE 1/2 exist to reclaim from: a
// dead leader whose launch-token proof died with it, but whose process group
// still has live, unrelated-looking members.
async function spawnOrphanLeader(socketPath) {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net");
       const { spawn } = require("node:child_process");
       const socketPath = ${JSON.stringify(socketPath)};
       const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
       grandchild.unref();
       grandchild.once("spawn", () => {
         const server = net.createServer();
         server.listen(socketPath, () => {
           process.stdout.write("ready " + grandchild.pid + "\\n");
         });
       });
       setInterval(() => {}, 60000);`
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  const grandchildPid = await new Promise((resolve, reject) => {
    leader.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/ready (\d+)/);
      if (match) {
        resolve(Number(match[1]));
      }
    });
    leader.once("error", reject);
    leader.once("exit", () => reject(new Error("orphan leader exited before binding")));
  });
  return { leader, grandchildPid };
}

// Builds the abandoned-orphan fixture and persists a session for it. Passing
// no instanceToken produces a legacy session (the key is omitted entirely,
// matching how genuinely legacy sessions are built elsewhere in this file).
async function setupOrphanedSession(workspace, { instanceToken } = {}) {
  const sessionDir = makeTempDir("cxc-orphan-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");

  const { leader, grandchildPid } = await spawnOrphanLeader(socketPath);
  const leaderPid = leader.pid;
  fs.writeFileSync(pidFile, String(leaderPid));

  // Captured while the leader is alive -- this is what
  // ensureBrokerSessionLocked would have persisted at spawn time.
  const recordedIdentity = getProcessIdentity(leaderPid);
  assert.ok(recordedIdentity, "expected a recordable identity while the leader is alive");

  const session = {
    endpoint: `unix:${socketPath}`,
    pid: leaderPid,
    pidFile,
    logFile: null,
    sessionDir,
    processIdentity: recordedIdentity,
    ...(instanceToken !== undefined ? { instanceToken } : {})
  };
  saveBrokerSession(workspace, session);

  // Kill only the leader: SIGKILL skips its own cleanup, so the socket file
  // stays on disk with nothing listening, exactly like a crashed broker.
  leader.kill("SIGKILL");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessRunning(leaderPid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(isProcessRunning(leaderPid), false, "the leader should have exited by now");
  assert.equal(fs.existsSync(socketPath), true, "the stale socket must survive the leader's death");
  assert.equal(isProcessTreeRunning(leaderPid), true, "the grandchild must keep the process group alive");

  return { sessionDir, socketPath, pidFile, session, leaderPid, grandchildPid };
}

async function cleanupOrphanGroup(leaderPid, grandchildPid) {
  try {
    process.kill(-leaderPid, "SIGTERM");
  } catch {
    // Group may already be gone.
  }
  // The grandchild, not the (already dead) leader, is what a plain
  // isProcessTreeRunning(grandchildPid) cannot see -- it inherited the
  // leader's pgid rather than being a group leader itself -- so poll its own
  // liveness directly (tree: false) instead.
  let exited = await waitForProcessExit(grandchildPid, { timeoutMs: 2000, tree: false });
  if (!exited) {
    try {
      process.kill(-leaderPid, "SIGKILL");
    } catch {
      // Already gone between the check above and here.
    }
    exited = await waitForProcessExit(grandchildPid, { timeoutMs: 2000, tree: false });
  }
  assert.equal(exited, true, "cleanup must confirm the test process exited");
}

test("shutdown reclaims a tokened session whose dead leader left an orphaned group", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const { socketPath, pidFile, leaderPid, grandchildPid } = await setupOrphanedSession(workspace, {
    instanceToken: "orphan-leader-token"
  });

  let killProcessCalled = false;
  const killProcess = () => {
    killProcessCalled = true;
  };

  try {
    const outcome = await shutdownBrokerSession(workspace, { timeoutMs: 40, killProcess });

    assert.equal(killProcessCalled, false, "an abandoned orphaned tree must never be signaled");
    assert.deepEqual(outcome, { found: true, exited: true, forced: false, reclaimedStaleEndpoint: true });
    assert.equal(isProcessRunning(grandchildPid), true, "the grandchild must be left running untouched");
    assert.equal(fs.existsSync(socketPath), false, "the stale socket must be removed");
    assert.equal(fs.existsSync(pidFile), false, "the pid file must be removed");
    assert.equal(loadBrokerSession(workspace), null);
  } finally {
    await cleanupOrphanGroup(leaderPid, grandchildPid);
  }
});

test("ensureBrokerSession recovers after reclaiming an orphaned group", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const {
    sessionDir: oldSessionDir,
    socketPath: oldSocketPath,
    session: oldSession,
    leaderPid,
    grandchildPid
  } = await setupOrphanedSession(workspace, { instanceToken: "orphan-leader-token" });

  try {
    const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });

    assert.ok(session, "ensureBrokerSession must recover instead of wedging on the orphaned tree");
    assert.notEqual(session.pid, leaderPid);
    assert.notEqual(session.sessionDir, oldSessionDir);
    assert.notEqual(session.endpoint, oldSession.endpoint);

    const probe = net.createConnection({ path: session.endpoint.slice("unix:".length) });
    await new Promise((resolve, reject) => {
      probe.once("connect", resolve);
      probe.once("error", reject);
    });
    probe.destroy();

    await shutdownBrokerSession(workspace, { killProcess: terminateProcessTree });
    assert.equal(loadBrokerSession(workspace), null);

    assert.equal(fs.existsSync(oldSocketPath), false, "the reclaimed stale socket must have been removed");
    assert.equal(isProcessRunning(grandchildPid), true, "the orphaned grandchild must be left running throughout");
  } finally {
    await cleanupOrphanGroup(leaderPid, grandchildPid);
  }
});

test("a legacy orphaned group still preserves state", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  // No instanceToken: pins the CHANGE 1/2 relaxation strictly to the tokened
  // path -- a legacy session hitting the identical dead-leader/live-group
  // shape must still refuse and preserve state.
  const { socketPath, leaderPid, grandchildPid } = await setupOrphanedSession(workspace);

  try {
    await assert.rejects(
      shutdownBrokerSession(workspace, { timeoutMs: 40, killProcess: terminateProcessTree }),
      /ownership could not be verified/i
    );

    assert.equal(fs.existsSync(socketPath), true, "the socket must be preserved for a legacy orphaned group");
    assert.ok(loadBrokerSession(workspace), "broker.json must be preserved for a legacy orphaned group");
  } finally {
    await cleanupOrphanGroup(leaderPid, grandchildPid);
  }
});
