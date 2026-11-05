import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const LIFECYCLE_URL = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for broker lifecycle transition");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function connect(endpoint) {
  const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    }
  });
  return {
    socket,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    }
  };
}

async function fixture(t) {
  const root = makeTempDir();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.TEST_STARTS, process.pid + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
if (process.env.TEST_SLOW_EXIT) process.on('SIGTERM', () => {});
const rl = readline.createInterface({ input: process.stdin });
if (process.env.TEST_SLOW_EXIT) rl.on('close', () => setTimeout(() => process.exit(0), 800));
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => send({ id: m.id, result });
  if (m.method === 'turn/start') {
    reply({ turn: { id: 'turn_1' } });
    send({ method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } }), 700);
  } else if (m.method === 'test/slow') {
    setTimeout(() => reply({ done: true }), 700);
  } else reply({});
});
`);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TEST_STARTS: path.join(root, "starts"),
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "200"
  };
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) {
      if (alive(session.pid)) terminateProcessTree(session.pid);
    }
    await waitFor(() => sessions.every((s) => !alive(s.pid)));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(resolveStateDir(root), { recursive: true, force: true });
    for (const session of sessions) fs.rmSync(session.sessionDir, { recursive: true, force: true });
  });
  return { root, env, sessions, start: async () => {
    const session = await ensureBrokerSession(root, { env });
    assert.ok(session);
    sessions.push(session);
    return session;
  } };
}

test("idle broker exits and releases its app-server after the client disconnects", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("initialize");
  const childPid = Number(fs.readFileSync(f.env.TEST_STARTS, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(alive(session.pid), "connected clients keep the broker alive");
  client.socket.destroy();
  await waitFor(() => !alive(session.pid) && !alive(childPid), 1500);
  const replacement = await f.start();
  assert.notEqual(replacement.pid, session.pid, "next command can start a replacement broker");
});

test("disconnecting a client does not expire an active turn", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1" });
  client.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(alive(session.pid), "turn outlives both the socket and idle timeout");
  await waitFor(() => !alive(session.pid), 1800);
});

test("disconnecting a client does not expire an in-flight RPC", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  client.request("test/slow");
  await new Promise((resolve) => client.socket.write("", resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(alive(session.pid), "pending request outlives idle timeout");
  await waitFor(() => !alive(session.pid), 1800);
});

test("concurrent processes start only one broker for a workspace", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.env.CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS = "3000";
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { ensureBrokerSession } from ${JSON.stringify(LIFECYCLE_URL)};
      const session = await ensureBrokerSession(process.cwd());
      console.log(JSON.stringify(session));
    `], { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(stderr));
      const session = JSON.parse(stdout);
      if (session) f.sessions.push(session);
      resolve(session);
    });
  });
  const sessions = await Promise.all([launch(), launch()]);
  assert.ok(sessions.every(Boolean));
  assert.equal(sessions[0].endpoint, sessions[1].endpoint);
  assert.equal(fs.readFileSync(f.env.TEST_STARTS, "utf8").trim().split("\n").length, 1);
});

test("shutdown is bounded when a broker accepts a connection but never replies", { timeout: 3000 }, async (t) => {
  const root = makeTempDir();
  const endpoint = process.platform === "win32" ? `pipe:\\\\.\\pipe\\${path.basename(root)}` : `unix:${path.join(root, "broker.sock")}`;
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await sendBrokerShutdown(endpoint, { timeoutMs: 100 });
});

test("startup recovers a lock left by a process that exited", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  const stateDir = resolveStateDir(f.root);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "broker.json.lock"), JSON.stringify({ pid: child.pid, token: "dead-owner" }));
  const session = await f.start();
  assert.ok(alive(session.pid));
  assert.equal(fs.existsSync(path.join(stateDir, "broker.json.lock")), false);
});

test("startup recovers a lock whose owner write was cut short", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const stateDir = resolveStateDir(f.root);
  const lockFile = path.join(stateDir, "broker.json.lock");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockFile, '{"pid":12');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, old, old);
  const session = await f.start();
  assert.ok(alive(session.pid));
  assert.equal(fs.existsSync(lockFile), false);
});

test("a broker draining after idle expiry stops admitting clients", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  f.env.TEST_SLOW_EXIT = "1";
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("initialize");
  client.socket.destroy();
  // Idle expiry has fired; the fake app-server holds the broker open for ~800ms more.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(alive(session.pid), "broker is still draining");
  const late = connect(session.endpoint);
  const outcome = await new Promise((resolve) => {
    late.socket.on("connect", () => resolve("connected"));
    late.socket.on("error", () => resolve("refused"));
  });
  late.socket.destroy();
  assert.equal(outcome, "refused");
});

test("reuse-existing callers recover when the saved broker expired while idle", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  await waitFor(() => !alive(session.pid), 1500);
  const client = await CodexAppServerClient.connect(f.root, { env: f.env, reuseExistingBroker: true });
  t.after(() => client.close());
  assert.equal(client.transport, "direct");
});
