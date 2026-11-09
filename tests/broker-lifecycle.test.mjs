import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
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
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => send({ id: m.id, result });
  if (m.method === 'turn/start') {
    reply({ turn: { id: 'turn_1' } });
    send({ method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } }), 700);
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
