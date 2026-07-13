import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";

function spawnTestBroker({ idleTimeoutMs }) {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("codex-plugin-broker-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const endpoint = `unix:${socketPath}`;
  const pidFile = path.join(sessionDir, "broker.pid");
  installFakeCodex(binDir);

  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", workspace, "--pid-file", pidFile],
    {
      cwd: workspace,
      env: {
        ...buildEnv(binDir),
        [IDLE_TIMEOUT_ENV]: String(idleTimeoutMs)
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  return { child, endpoint, pidFile, socketPath };
}

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for broker to exit.")), timeoutMs))
  ]);
}

function terminateBroker(child) {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
  }
}

test("broker exits and removes runtime files after its last client stays disconnected", async (t) => {
  const broker = spawnTestBroker({ idleTimeoutMs: 150 });
  t.after(() => terminateBroker(broker.child));

  assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
  await waitForExit(broker.child);

  assert.equal(broker.child.exitCode, 0);
  assert.equal(fs.existsSync(broker.socketPath), false);
  assert.equal(fs.existsSync(broker.pidFile), false);
});

test("broker idle shutdown waits until a connected client disconnects", async (t) => {
  const broker = spawnTestBroker({ idleTimeoutMs: 150 });
  t.after(() => terminateBroker(broker.child));

  assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
  const socket = net.createConnection({ path: broker.socketPath });
  await once(socket, "connect");

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(broker.child.exitCode, null);
  assert.equal(broker.child.signalCode, null);

  socket.end();
  await once(socket, "close");
  await waitForExit(broker.child);
  assert.equal(broker.child.exitCode, 0);
});

test("broker idle timeout can be disabled", async (t) => {
  const broker = spawnTestBroker({ idleTimeoutMs: 0 });
  t.after(() => terminateBroker(broker.child));

  assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(broker.child.exitCode, null);
  assert.equal(broker.child.signalCode, null);

  terminateBroker(broker.child);
  await waitForExit(broker.child);
});

test("broker shuts down cleanly while new clients race to connect", async (t) => {
  const broker = spawnTestBroker({ idleTimeoutMs: 0 });
  t.after(() => terminateBroker(broker.child));

  assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
  const reconnects = Array.from(
    { length: 50 },
    () =>
      new Promise((resolve) => {
        const socket = net.createConnection({ path: broker.socketPath });
        const timer = setTimeout(() => socket.destroy(), 1000);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.on("connect", () => socket.end());
        socket.on("error", finish);
        socket.on("close", finish);
      })
  );

  await Promise.all([sendBrokerShutdown(broker.endpoint), ...reconnects]);
  await waitForExit(broker.child);
  assert.equal(broker.child.exitCode, 0);
});
