import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { clearBrokerSessionIfCurrent, ensureBrokerSession, loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

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
const finalAnswer = { method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'done' } } };
const collab = (method, status, id = 'c1') => ({ method, params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'collabAgentToolCall', id, status } } });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => send({ id: m.id, result });
  if (m.method === 'turn/start') {
    reply({ turn: { id: 'turn_1' } });
    send({ method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } });
    if (m.params.mode === 'interrupted') {
      send(collab('item/started', 'inProgress'));
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'interrupted' } } }), 100);
    } else if (m.params.mode === 'final-only') {
      setTimeout(() => send(finalAnswer), 100);
    } else if (m.params.mode === 'final-with-repeated-drains') {
      send(collab('item/started', 'inProgress'));
      setTimeout(() => send(finalAnswer), 50);
      setTimeout(() => send(collab('item/completed', 'completed')), 100);
      setTimeout(() => send(collab('item/started', 'inProgress', 'c2')), 150);
      setTimeout(() => send(collab('item/completed', 'completed', 'c2')), 200);
      setTimeout(() => send(collab('item/started', 'inProgress', 'c3')), 400);
      setTimeout(() => send(collab('item/completed', 'completed', 'c3')), 1100);
    } else if (m.params.mode === 'final-with-collab') {
      send(collab('item/started', 'inProgress'));
      setTimeout(() => send(finalAnswer), 100);
      setTimeout(() => send(collab('item/completed', 'completed')), 900);
    } else setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } }), 700);
  } else if (m.method === 'test/slow') {
    fs.writeFileSync(process.env.TEST_SLOW_SEEN, '1');
    setTimeout(() => reply({ done: true }), 700);
  } else reply({});
});
`);
  // Same Windows wrapper as fake-codex-fixture.mjs: spawn with shell: true resolves codex.cmd.
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\nnode "%~dp0codex" %*\r\n`, "utf8");
  }
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TEST_STARTS: path.join(root, "starts"),
    TEST_SLOW_SEEN: path.join(root, "slow-seen"),
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
  // The app-server seeing the request proves the broker has registered it as pending.
  await waitFor(() => fs.existsSync(f.env.TEST_SLOW_SEEN), 2000);
  client.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(alive(session.pid), "pending request outlives idle timeout");
  await waitFor(() => !alive(session.pid), 1800);
});

test("reuse-existing callers recover when the saved broker expired while idle", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  await waitFor(() => !alive(session.pid), 1500);
  const client = await CodexAppServerClient.connect(f.root, { env: f.env, reuseExistingBroker: true });
  t.after(() => client.close());
  assert.equal(client.transport, "direct");
});

test("a turn finished by its final answer alone does not pin the broker", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1", mode: "final-only" });
  client.socket.destroy();
  await waitFor(() => !alive(session.pid), 1500);
});

test("a final answer does not release the broker while a collaboration is still running", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1", mode: "final-with-collab" });
  const childPid = Number(fs.readFileSync(f.env.TEST_STARTS, "utf8").trim());
  client.socket.destroy();
  // Final answer at ~100ms, collaboration completes at ~900ms; idle timeout is 200ms.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(alive(childPid), "app-server stays up while the collaboration runs");
  assert.ok(alive(session.pid), "broker stays up while the collaboration runs");
  await waitFor(() => !alive(session.pid), 2500);
});

test("repeated collaboration drains share one grace timer, so a later collaboration keeps the turn open", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1", mode: "final-with-repeated-drains" });
  const childPid = Number(fs.readFileSync(f.env.TEST_STARTS, "utf8").trim());
  client.socket.destroy();
  // The first drain's timer would fire at ~350ms and release the turn before the third
  // collaboration starts at 400ms; the 200ms idle timeout would then close the app-server.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(alive(childPid), "app-server stays up while the third collaboration runs");
  await waitFor(() => !alive(session.pid), 2500);
});

test("a resumed thread does not inherit an interrupted turn's collaboration", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1", mode: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.request("turn/start", { threadId: "thr_1", mode: "final-only" });
  client.socket.destroy();
  await waitFor(() => !alive(session.pid), 2500);
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

test("draining broker tolerates replacement teardown removing its pid file", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const hook = path.join(f.root, "cleanup-race.cjs");
  const marker = path.join(f.root, "cleanup-raced");
  // Inject the race inside the real detached broker, without timing sleeps or production hooks.
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const path = require('node:path');
if (path.basename(process.argv[1] || '') === 'app-server-broker.mjs') {
  const unlink = fs.unlinkSync;
  for (const method of ['unlinkSync', 'rmSync']) {
    const remove = fs[method];
    fs[method] = function(file, ...args) {
      if (path.basename(String(file)) === 'broker.pid' && !fs.existsSync(${JSON.stringify(marker)})) {
        unlink(file);
        fs.writeFileSync(${JSON.stringify(marker)}, 'removed by replacement');
      }
      return remove.call(this, file, ...args);
    };
  }
}
`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(hook)}`;
  const session = await f.start();
  const client = connect(session.endpoint);
  t.after(() => client.socket.destroy());
  await client.request("broker/shutdown");
  await waitFor(() => !alive(session.pid));

  assert.equal(fs.readFileSync(marker, "utf8"), "removed by replacement");
  assert.doesNotMatch(fs.readFileSync(session.logFile, "utf8"), /ENOENT/);
  assert.equal(fs.existsSync(session.pidFile), false);
});

test("an expired broker clears its saved session so SessionEnd never signals a reused pid", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  assert.equal(loadBrokerSession(f.root)?.pid, session.pid);
  await waitFor(() => !alive(session.pid), 1500);
  assert.equal(loadBrokerSession(f.root), null);
});

test("clearing a saved session keeps a replacement broker's state", (t) => {
  const f = { root: makeTempDir() };
  t.after(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(resolveStateDir(f.root), { recursive: true, force: true });
  });
  saveBrokerSession(f.root, { endpoint: "unix:/tmp/new.sock", pid: 2 });
  clearBrokerSessionIfCurrent(f.root, "unix:/tmp/old.sock");
  assert.equal(loadBrokerSession(f.root)?.pid, 2);
  clearBrokerSessionIfCurrent(f.root, "unix:/tmp/new.sock");
  assert.equal(loadBrokerSession(f.root), null);
});
