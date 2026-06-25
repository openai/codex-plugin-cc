import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const BROKER = fileURLToPath(
  new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
);

// Drive the broker process directly over its unix socket. The broker connects to a `codex app-server`
// child on startup; we install the fake-codex fixture on PATH so the broker boots deterministically in
// CI (no real Codex login required). CODEX_BROKER_IDLE_SHUTDOWN_MS is set small so the idle path is
// exercised in milliseconds.

function brokerEnv(binDir, idleMs) {
  return { ...buildEnv(binDir), CODEX_BROKER_IDLE_SHUTDOWN_MS: String(idleMs) };
}

function spawnBroker(env, endpoint) {
  return spawn(process.execPath, [BROKER, "serve", "--endpoint", endpoint], {
    env,
    stdio: ["ignore", "ignore", "ignore"]
  });
}

async function waitForSocket(sockPath, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(sockPath)) {
      const ok = await new Promise((resolve) => {
        const c = net.createConnection({ path: sockPath });
        c.on("connect", () => { c.end(); resolve(true); });
        c.on("error", () => resolve(false));
      });
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
    child.on("exit", () => { if (!done) { done = true; clearTimeout(t); resolve(true); } });
  });
}

function setup(t, idleMs) {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  // Make `node` discoverable on the fixture PATH too (buildEnv prepends binDir; the broker spawns
  // with process.execPath directly, but the fake codex shebang needs node on PATH).
  try { fs.symlinkSync(process.execPath, path.join(binDir, "node")); } catch { /* may exist */ }
  const sockDir = makeTempDir("cxc-idle-");
  const sock = path.join(sockDir, "broker.sock");
  const endpoint = `unix:${sock}`;
  const child = spawnBroker(brokerEnv(binDir, idleMs), endpoint);
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    try { fs.rmSync(sockDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return { child, sock };
}

// Timing strategy (must be robust when the whole suite runs in parallel and saturates CPU):
//  - IDLE = 3s: large enough that the broker reliably stays up long enough to be observed before its
//    idle timer could fire, even under load. Small enough that the self-exit tests finish quickly.
//  - waitForSocket default 20s: broker boot = spawn fake-codex + app-server handshake, which can be
//    slow under contention; readiness must NOT be gated on the short side.
//  - exit waits are a generous multiple of IDLE so a loaded scheduler still observes the exit.
const IDLE = 3000;

test("broker self-exits after the idle window when no client ever connects", async (t) => {
  const { child, sock } = setup(t, IDLE);
  assert.equal(await waitForSocket(sock), true, "broker should come up with the fake codex on PATH");
  // Never connect a client -> the startup-armed idle timer fires and exits the process.
  assert.equal(
    await waitForExit(child, IDLE * 5),
    true,
    "broker should self-exit after the idle window with no client"
  );
});

test("a connected client cancels the idle timer (broker stays up)", async (t) => {
  const { child, sock } = setup(t, IDLE);
  assert.equal(await waitForSocket(sock), true);
  const client = net.createConnection({ path: sock });
  await new Promise((r) => client.on("connect", r));
  // Hold the client open well past the idle window; the broker must NOT exit while connected.
  const exitedWhileHeld = await waitForExit(child, IDLE * 2);
  client.end();
  assert.equal(exitedWhileHeld, false, "broker must not idle-exit while a client is connected");
});

test("broker re-arms and exits after a client connects then disconnects", async (t) => {
  const { child, sock } = setup(t, IDLE);
  assert.equal(await waitForSocket(sock), true);
  const client = net.createConnection({ path: sock });
  await new Promise((r) => client.on("connect", r));
  client.end();
  // After the last client leaves, the idle countdown re-arms and the broker reaps itself.
  assert.equal(
    await waitForExit(child, IDLE * 5),
    true,
    "broker should self-exit after the last client disconnects and the idle window elapses"
  );
});

test("idle shutdown is disabled when the window is <= 0", async (t) => {
  const { child, sock } = setup(t, 0);
  assert.equal(await waitForSocket(sock), true);
  assert.equal(
    await waitForExit(child, IDLE),
    false,
    "broker must stay up when idle shutdown is disabled (<=0)"
  );
});

test("unset env falls back to the (long) default, not disabled or instant-exit", async (t) => {
  // Spawn with CODEX_BROKER_IDLE_SHUTDOWN_MS unset: Number(undefined) -> NaN -> 30-min default.
  // The broker must stay up through a short window (proving it neither disabled nor used a tiny value).
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  try { fs.symlinkSync(process.execPath, path.join(binDir, "node")); } catch { /* may exist */ }
  const sockDir = makeTempDir("cxc-idle-");
  const sock = path.join(sockDir, "broker.sock");
  const env = buildEnv(binDir);
  delete env.CODEX_BROKER_IDLE_SHUTDOWN_MS; // ensure truly unset -> default path
  const child = spawnBroker(env, `unix:${sock}`);
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { fs.rmSync(sockDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  assert.equal(await waitForSocket(sock), true);
  assert.equal(
    await waitForExit(child, IDLE),
    false,
    "with the env unset the broker uses the long (30-min) default and must NOT exit quickly"
  );
});
