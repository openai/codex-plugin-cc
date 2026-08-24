import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BROKER = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await delay(intervalMs);
  }
  return false;
}

function startBroker({ idleTimeout } = {}) {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("codex-broker-idle-");
  const cwd = makeTempDir("codex-broker-cwd-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");

  const args = [BROKER, "serve", "--endpoint", `unix:${socketPath}`, "--cwd", cwd, "--pid-file", pidFile];
  if (idleTimeout !== undefined) {
    args.push("--idle-timeout", String(idleTimeout));
  }

  const child = spawn(process.execPath, args, { env: buildEnv(binDir), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const alive = () => child.exitCode === null && child.signalCode === null;

  // Bounded: a broker that never exits must turn into a RED test, not a hung run.
  // Awaiting `exited` unbounded is what made this file hang against an unpatched broker.
  const exitedWithin = (timeoutMs) =>
    Promise.race([exited, delay(timeoutMs).then(() => null)]);

  const dispose = () => {
    if (alive()) {
      child.kill("SIGKILL");
    }
  };

  return {
    child,
    socketPath,
    pidFile,
    exited,
    exitedWithin,
    dispose,
    stderr: () => stderr,
    alive,
    listening: () => waitFor(() => fs.existsSync(socketPath))
  };
}

function connectTo(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.on("connect", () => resolve(socket));
    socket.on("error", reject);
  });
}

test("broker shuts itself down once it has been idle for the timeout", async (t) => {
  const broker = startBroker({ idleTimeout: 400 });
  t.after(() => broker.dispose());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const result = await broker.exitedWithin(8000);
  assert.ok(result, `broker never exited after the idle timeout, stderr: ${broker.stderr()}`);
  assert.equal(result.code, 0, `expected a clean idle exit, stderr: ${broker.stderr()}`);
  // shutdown() must still clean up after itself on the idle path, or the next
  // ensureBrokerSession would find a stale socket and a stale pidfile.
  assert.equal(fs.existsSync(broker.socketPath), false, "idle shutdown left the socket behind");
  assert.equal(fs.existsSync(broker.pidFile), false, "idle shutdown left the pidfile behind");
});

test("broker stays alive while a client is connected, then exits after it disconnects", async (t) => {
  const broker = startBroker({ idleTimeout: 400 });
  t.after(() => broker.dispose());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const socket = await connectTo(broker.socketPath);
  // Well past the idle timeout: an open connection must hold the broker open, which is
  // what stops a long streaming turn from being cut off mid-flight.
  await delay(1600);
  assert.equal(broker.alive(), true, "broker exited while a client was still connected");

  socket.destroy();
  const result = await broker.exitedWithin(8000);
  assert.ok(result, `broker never exited after the client disconnected, stderr: ${broker.stderr()}`);
  assert.equal(result.code, 0, `expected a clean idle exit after disconnect, stderr: ${broker.stderr()}`);
});

test("broker with --idle-timeout 0 never idles out", async (t) => {
  const broker = startBroker({ idleTimeout: 0 });
  t.after(() => broker.dispose());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  await delay(1600);
  assert.equal(broker.alive(), true, "idle shutdown ran even though it was disabled");

  // SIGTERM shares shutdown() with the idle path, so this also covers the ordering there.
  broker.child.kill("SIGTERM");
  const result = await broker.exitedWithin(8000);
  assert.ok(result, "broker did not exit on SIGTERM");
  assert.equal(fs.existsSync(broker.socketPath), false, "SIGTERM shutdown left the socket behind");
  assert.equal(fs.existsSync(broker.pidFile), false, "SIGTERM shutdown left the pidfile behind");
});

test("broker rejects a non-numeric --idle-timeout instead of silently never expiring", async (t) => {
  const broker = startBroker({ idleTimeout: "not-a-number" });
  t.after(() => broker.dispose());
  const result = await broker.exitedWithin(8000);
  assert.ok(result, "broker did not exit on an invalid idle timeout");
  assert.equal(result.code, 1);
  assert.match(broker.stderr(), /Invalid idle timeout/);
});

test("blank --idle-timeout falls back to the default instead of silently disabling", async (t) => {
  // Number("  ") === 0, so a whitespace value must NOT be read as "never expire".
  // Only an explicit 0 disables idle shutdown.
  const broker = startBroker({ idleTimeout: "  " });
  t.after(() => broker.dispose());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  // The default is 30 minutes, so it must still be alive well past the short timeouts
  // used elsewhere in this file.
  await delay(1600);
  assert.equal(broker.alive(), true, "a blank idle timeout disabled idle shutdown");

  broker.child.kill("SIGTERM");
  await broker.exitedWithin(8000);
});

test("broker rejects an idle timeout beyond Node's timer range", async (t) => {
  // setTimeout() overflows above 2^31-1 and fires after 1ms, which would shut the broker
  // down almost immediately. Asking for ~30 days must fail loudly, not silently invert.
  const broker = startBroker({ idleTimeout: 30 * 24 * 60 * 60 * 1000 });
  t.after(() => broker.dispose());

  const result = await broker.exitedWithin(8000);
  assert.ok(result, "broker did not exit on an out-of-range idle timeout");
  assert.equal(result.code, 1);
  assert.match(broker.stderr(), /must be at most 2147483647 ms/);
});

test("broker accepts an idle timeout exactly at the Node timer limit", async (t) => {
  // Boundary: 2147483647 is valid, so the guard must not be off by one.
  const broker = startBroker({ idleTimeout: 2147483647 });
  t.after(() => broker.dispose());

  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);
  assert.equal(broker.alive(), true, "broker rejected a timeout that is exactly at the limit");

  broker.child.kill("SIGTERM");
  await broker.exitedWithin(8000);
});

function sendLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function readReply(socket, id) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === id) resolve(message);
      }
    });
    socket.on("error", reject);
  });
}

test("broker still idles out after a client abandons a streaming request", async (t) => {
  // A client can disconnect while turn/start is still awaiting its response. The close
  // handler arms the timer, but the response then assigns the already-closed socket to
  // activeStreamSocket, so the timer finds the broker "busy" and does not re-arm. When
  // turn/completed later clears that stale ownership nothing schedules again, and the
  // empty broker stays resident forever.
  const broker = startBroker({ idleTimeout: 400 });
  t.after(() => broker.dispose());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const socket = await connectTo(broker.socketPath);
  const started = readReply(socket, 1);
  sendLine(socket, { id: 1, method: "thread/start", params: { cwd: process.cwd(), ephemeral: true } });
  const threadId = (await started).result?.thread?.id;
  assert.ok(threadId, "fake codex did not start a thread");

  // Fire a streaming request and abandon it immediately, without reading the response.
  sendLine(socket, {
    id: 2,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "hello" }] }
  });
  socket.destroy();

  const result = await broker.exitedWithin(15000);
  assert.ok(result, `broker stayed resident after the client abandoned a stream: ${broker.stderr()}`);
  assert.equal(result.code, 0);
});

test("broker serves a reconnecting client after a stream was abandoned", async (t) => {
  // Releasing a dead owner only inside the idle check is not enough: the busy guard still
  // sees the non-null destroyed socket and answers every new client with BROKER_BUSY,
  // while that connected client also keeps the broker from ever idling out. The result is
  // a shared broker that is simultaneously "idle" and unusable.
  const broker = startBroker({ idleTimeout: 0 });
  t.after(() => broker.dispose());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const abandoned = await connectTo(broker.socketPath);
  const started = readReply(abandoned, 1);
  sendLine(abandoned, { id: 1, method: "thread/start", params: { cwd: process.cwd(), ephemeral: true } });
  const threadId = (await started).result?.thread?.id;
  assert.ok(threadId, "fake codex did not start a thread");

  sendLine(abandoned, {
    id: 2,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "hello" }] }
  });
  abandoned.destroy();

  // Let the abandoned response land and assign the destroyed socket as the stream owner.
  await delay(600);

  const reconnect = await connectTo(broker.socketPath);
  t.after(() => reconnect.destroy());
  const replied = readReply(reconnect, 10);
  sendLine(reconnect, { id: 10, method: "thread/start", params: { cwd: process.cwd(), ephemeral: true } });

  const reply = await Promise.race([replied, delay(10000).then(() => null)]);
  assert.ok(reply, "reconnecting client got no reply at all");
  assert.equal(
    reply.error?.message,
    undefined,
    `reconnecting client was rejected: ${reply.error?.message ?? ""}`
  );
  assert.ok(reply.result?.thread?.id, "reconnecting client did not get a usable thread");
});
