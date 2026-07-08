import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

function spawnBroker({ cwd, endpoint, env, idleTimeoutMs }) {
  const args = [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", cwd];
  if (idleTimeoutMs !== undefined) {
    args.push("--idle-timeout", String(idleTimeoutMs));
  }
  return spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function waitForExit(child, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Timed out waiting for broker process to exit."));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

function connectClient(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.path });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("broker self-terminates after the idle timeout when no client is connected", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({ cwd: sessionDir, endpoint, env: buildEnv(binDir), idleTimeoutMs: 300 });

  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true, "broker should accept connections before it times out");

    const start = Date.now();
    const result = await waitForExit(child, { timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    assert.equal(result.code, 0, "broker should exit cleanly on idle timeout");
    assert.ok(elapsed >= 200, `broker exited too early (${elapsed}ms)`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});

test("broker stays alive while a client is connected and exits after it disconnects", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({ cwd: sessionDir, endpoint, env: buildEnv(binDir), idleTimeoutMs: 300 });

  let socket = null;
  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true);

    socket = await connectClient(endpoint);

    // Hold the connection open well past the idle timeout; the broker must not
    // self-terminate while a client is still connected.
    await delay(900);
    assert.equal(child.exitCode, null, "broker must stay alive while a client is connected");

    socket.end();
    socket = null;

    const result = await waitForExit(child, { timeoutMs: 5000 });
    assert.equal(result.code, 0, "broker should exit once the client disconnects and it goes idle");
  } finally {
    if (socket) {
      socket.destroy();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});

test("broker with the idle timeout disabled keeps running while idle", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({ cwd: sessionDir, endpoint, env: buildEnv(binDir), idleTimeoutMs: 0 });

  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true);

    await delay(700);
    assert.equal(child.exitCode, null, "broker must not self-terminate when the idle timeout is disabled");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});
