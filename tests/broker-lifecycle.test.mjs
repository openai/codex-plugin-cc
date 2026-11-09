import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { clearBrokerSessionIfCurrent, ensureBrokerSession, loadBrokerSession, saveBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { isProcessAlive, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
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

const alive = isProcessAlive;

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
    if (m.params && m.params.mode === 'interrupted') {
      send({ method: 'item/started', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'collabAgentToolCall', id: 'c1', status: 'inProgress' } } });
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'interrupted' } } }), 100);
    } else if (m.params && m.params.mode === 'final-only') {
      setTimeout(() => send({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm2', phase: 'final_answer', text: 'done' } } }), 100);
    } else if (process.env.TEST_COLLAB) {
      send({ method: 'item/started', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'collabAgentToolCall', id: 'c1', status: 'inProgress' } } });
      setTimeout(() => send({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'done' } } }), 100);
      setTimeout(() => send({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'collabAgentToolCall', id: 'c1', status: 'completed' } } }), 900);
    } else if (process.env.TEST_INFERRED) setTimeout(() => send({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'done' } } }), 100);
    else setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } }), 700);
  } else if (m.method === 'test/slow') {
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

test("a turn finished by its final answer alone does not pin the broker", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  f.env.TEST_INFERRED = "1";
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1" });
  client.socket.destroy();
  await waitFor(() => !alive(session.pid), 1500);
});

test("a final answer does not release the broker while a collaboration is still running", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  f.env.TEST_COLLAB = "1";
  const session = await f.start();
  const client = connect(session.endpoint);
  await client.request("turn/start", { threadId: "thr_1" });
  const childPid = Number(fs.readFileSync(f.env.TEST_STARTS, "utf8").trim());
  client.socket.destroy();
  // Final answer at ~100ms, collaboration completes at ~900ms; idle timeout is 200ms.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(alive(childPid), "app-server stays up while the collaboration runs");
  assert.ok(alive(session.pid), "broker stays up while the collaboration runs");
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

for (const file of ["pidFile", "logFile"]) {
  test(`replacement teardown tolerates concurrent removal of its ${file}`, (t) => {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, file);
    fs.writeFileSync(target, "old broker");
    const unlink = fs.unlinkSync;
    let raced = false;
    t.mock.method(fs, "unlinkSync", (candidate) => {
      if (candidate === target && !raced) {
        raced = true;
        // The draining broker removes the file just before replacement teardown does.
        unlink(candidate);
      }
      return unlink(candidate);
    });

    assert.doesNotThrow(() => teardownBrokerSession({ [file]: target }));
    assert.equal(raced, true, "exercise removal at the unlink boundary");
    assert.equal(fs.existsSync(target), false);
  });
}

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

test("startup recovers when a reclaimer died holding the reclaim guard", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const stateDir = resolveStateDir(f.root);
  const lockFile = path.join(stateDir, "broker.json.lock");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 1, token: "dead-owner" }));
  fs.writeFileSync(`${lockFile}.reclaim`, JSON.stringify({ pid: 2 ** 22 + 2, token: "dead-reclaimer" }));
  const session = await f.start();
  assert.ok(alive(session.pid));
  assert.equal(fs.existsSync(`${lockFile}.reclaim`), false);
});

test("a live reclaimer is not revoked however long it holds the guard", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const stateDir = resolveStateDir(f.root);
  const lockFile = path.join(stateDir, "broker.json.lock");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 1, token: "dead-owner" }));
  const guard = JSON.stringify({ pid: process.pid, token: "slow-reclaimer" });
  fs.writeFileSync(`${lockFile}.reclaim`, guard);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${lockFile}.reclaim`, old, old);
  await assert.rejects(ensureBrokerSession(f.root, { env: f.env, timeoutMs: 50 }), /Timed out waiting/);
  assert.equal(fs.readFileSync(`${lockFile}.reclaim`, "utf8"), guard, "guard untouched");
  assert.equal(fs.existsSync(lockFile), true, "stale lock left for the live reclaimer");
});

test("session-end hook still tears down its broker when the startup lock is held", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const lockFile = path.join(resolveStateDir(f.root), "broker.json.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "busy-starter" }));
  t.after(() => fs.rmSync(lockFile, { force: true }));
  const hook = fileURLToPath(new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url));
  const child = spawn(process.execPath, [hook, "SessionEnd"], { cwd: f.root, env: f.env, stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", cwd: f.root, session_id: "s1" }));
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(alive(session.pid), false);
  assert.equal(loadBrokerSession(f.root), null);
});

test("session-end cleanup keeps a replacement broker's saved state", () => {
  const root = makeTempDir();
  const replacement = { endpoint: "unix:/tmp/replacement.sock", pidFile: null, logFile: null, sessionDir: null, pid: 1 };
  saveBrokerSession(root, replacement);
  clearBrokerSessionIfCurrent(root, "unix:/tmp/old.sock");
  assert.deepEqual(loadBrokerSession(root), replacement);
  clearBrokerSessionIfCurrent(root, replacement.endpoint);
  assert.equal(loadBrokerSession(root), null);
  fs.rmSync(resolveStateDir(root), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup recovers a lock owned by an exited zombie process", { timeout: 6000, skip: !fs.existsSync("/proc/self/stat") || spawnSync("perl", ["-e", "1"]).error !== undefined }, async (t) => {
  const f = await fixture(t);
  // perl forks a child that exits at once, then sleeps without wait(), leaving a zombie.
  const parent = spawn("perl", ["-e", '$| = 1; my $p = fork; exit 0 unless $p; print "$p\\n"; sleep 30'], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill());
  const pid = await new Promise((resolve) => parent.stdout.once("data", (c) => resolve(Number(String(c).trim()))));
  await waitFor(() => fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] === "Z");
  assert.equal(isProcessAlive(pid), false, "zombie counts as exited");
  const stateDir = resolveStateDir(f.root);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "broker.json.lock"), JSON.stringify({ pid, token: "zombie-owner" }));
  const session = await f.start();
  assert.ok(alive(session.pid));
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
