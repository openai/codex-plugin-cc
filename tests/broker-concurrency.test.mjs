import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateRoot } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function installConcurrentFakeCodex(binDir) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0 };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  process.exit(1);
}

const boot = loadState();
boot.appServerStarts += 1;
saveState(boot);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  const state = loadState();

  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake-concurrent-app-server" } });
      break;
    case "initialized":
      break;
    case "thread/start": {
      const id = "thr_" + state.nextThreadId++;
      saveState(state);
      send({ id: message.id, result: { thread: { id, cwd: message.params.cwd || process.cwd() } } });
      break;
    }
    case "turn/start": {
      const threadId = message.params.threadId;
      const turnId = "turn_" + state.nextTurnId++;
      const text = (message.params.input || []).map((entry) => entry.text || "").join("");
      const spawnSubagent = text.includes("with-subagent");
      const broadcastGlobal = text.includes("broadcast-global");
      const delayMs = text.includes("slow") ? 350 : 120;
      let subThreadId = null;
      if (spawnSubagent) {
        subThreadId = "thr_" + state.nextThreadId++;
      }
      saveState(state);

      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });

      if (subThreadId) {
        setTimeout(() => {
          send({
            method: "thread/started",
            params: { thread: { id: subThreadId, parentThreadId: threadId, name: "sub-worker" } }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThreadId,
              turnId: "sub_" + turnId,
              item: { type: "agentMessage", id: "sub_msg_" + turnId, text: "subagent-output-for-" + threadId }
            }
          });
          send({
            method: "turn/completed",
            params: { threadId: subThreadId, turn: { id: "sub_" + turnId, status: "completed", items: [], error: null } }
          });
        }, 40);
      }

      if (broadcastGlobal) {
        setTimeout(() => {
          send({ method: "externalAgentConfig/import/completed", params: {} });
        }, 60);
      }

      setTimeout(() => {
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { type: "agentMessage", id: "msg_" + turnId, text: "reply:" + text }
          }
        });
        send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } }
        });
      }, delayMs);
      break;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
      break;
  }
});
`;
  writeExecutable(scriptPath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%~dp0codex" %*\r\n`, "utf8");
  }
  return statePath;
}

function buildIsolatedEnv(binDir, pluginDataDir, extra = {}) {
  return {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  };
}

test("concurrent ensureBrokerSession across two workspaces shares one broker and one app-server", async () => {
  const workspaceA = makeTempDir("cxc-ws-a-");
  const workspaceB = makeTempDir("cxc-ws-b-");
  const binDir = makeTempDir("cxc-bin-");
  const pluginDataDir = makeTempDir("cxc-data-");
  const statePath = installConcurrentFakeCodex(binDir);
  const env = buildIsolatedEnv(binDir, pluginDataDir);

  let sessionA = null;
  try {
    const [first, second] = await Promise.all([
      ensureBrokerSession(workspaceA, { env }),
      ensureBrokerSession(workspaceB, { env })
    ]);
    sessionA = first;

    assert.ok(first?.endpoint, "workspaceA should obtain a broker session");
    assert.ok(second?.endpoint, "workspaceB should obtain a broker session");
    assert.equal(first.endpoint, second.endpoint, "both workspaces must share one broker endpoint");
    assert.equal(
      fs.existsSync(path.join(resolveStateRoot(env), "broker.json")),
      true,
      "broker.json should live in the shared state root"
    );

    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(fakeState.appServerStarts, 1, "only one app-server should be spawned");
  } finally {
    if (sessionA?.endpoint) {
      await sendBrokerShutdown(sessionA.endpoint);
      teardownBrokerSession(sessionA);
      clearBrokerSession(workspaceA, env);
    }
  }
});

test("shared broker multiplexes concurrent turns, routes subagent threads to owner, and broadcasts thread-less notifications", async () => {
  const workspaceA = makeTempDir("cxc-ws-a-");
  const workspaceB = makeTempDir("cxc-ws-b-");
  const binDir = makeTempDir("cxc-bin-");
  const pluginDataDir = makeTempDir("cxc-data-");
  const statePath = installConcurrentFakeCodex(binDir);
  const env = buildIsolatedEnv(binDir, pluginDataDir);

  let clientA = null;
  let clientB = null;
  try {
    [clientA, clientB] = await Promise.all([
      CodexAppServerClient.connect(workspaceA, { env }),
      CodexAppServerClient.connect(workspaceB, { env })
    ]);

    assert.equal(clientA.transport, "broker");
    assert.equal(clientB.transport, "broker");

    const notificationsA = [];
    const notificationsB = [];

    let resolveDoneA;
    let resolveDoneB;
    const doneA = new Promise((resolve) => {
      resolveDoneA = resolve;
    });
    const doneB = new Promise((resolve) => {
      resolveDoneB = resolve;
    });

    const threadA = (await clientA.request("thread/start", { cwd: workspaceA })).thread.id;
    const threadB = (await clientB.request("thread/start", { cwd: workspaceB })).thread.id;

    clientA.setNotificationHandler((msg) => {
      notificationsA.push(msg);
      if (msg.method === "turn/completed" && msg.params?.threadId === threadA) {
        resolveDoneA();
      }
    });
    clientB.setNotificationHandler((msg) => {
      notificationsB.push(msg);
      if (msg.method === "turn/completed" && msg.params?.threadId === threadB) {
        resolveDoneB();
      }
    });

    await Promise.all([
      clientA.request("turn/start", {
        threadId: threadA,
        input: [{ type: "text", text: "job-a with-subagent broadcast-global" }]
      }),
      clientB.request("turn/start", {
        threadId: threadB,
        input: [{ type: "text", text: "job-b slow" }]
      })
    ]);

    await Promise.all([doneA, doneB]);

    // Client A received its own turn + its subagent's notifications, and NONE of Client B's thread notifications.
    assert.equal(
      notificationsA.some((m) => m.params?.threadId === threadB),
      false,
      "clientA must not receive clientB thread notifications"
    );
    assert.equal(
      notificationsA.some((m) => m.method === "item/completed" && m.params?.item?.text === `subagent-output-for-${threadA}`),
      true,
      "clientA must receive its subagent notifications"
    );

    // Client B received its own turn notifications, and NONE of Client A's or Client A's subagent notifications.
    assert.equal(
      notificationsB.some((m) => m.params?.threadId === threadA),
      false,
      "clientB must not receive clientA thread notifications"
    );
    assert.equal(
      notificationsB.some((m) => m.method === "item/completed" && String(m.params?.item?.text ?? "").includes("subagent-output")),
      false,
      "clientB must not receive clientA subagent notifications"
    );

    // Both clients received the thread-less broadcast notification.
    assert.equal(
      notificationsA.some((m) => m.method === "externalAgentConfig/import/completed"),
      true,
      "clientA should receive thread-less broadcast notification"
    );
    assert.equal(
      notificationsB.some((m) => m.method === "externalAgentConfig/import/completed"),
      true,
      "clientB should receive thread-less broadcast notification"
    );

    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(fakeState.appServerStarts, 1);
  } finally {
    await clientA?.close().catch(() => {});
    await clientB?.close().catch(() => {});
    const brokerSession = loadBrokerSession(workspaceA, env);
    if (brokerSession?.endpoint) {
      await sendBrokerShutdown(brokerSession.endpoint);
      teardownBrokerSession(brokerSession);
      clearBrokerSession(workspaceA, env);
    }
  }
});

test("SessionEnd drains shared broker without killing another client's active turn", async () => {
  const workspaceA = makeTempDir("cxc-ws-a-");
  const workspaceB = makeTempDir("cxc-ws-b-");
  const binDir = makeTempDir("cxc-bin-");
  const pluginDataDir = makeTempDir("cxc-data-");
  installConcurrentFakeCodex(binDir);
  const env = buildIsolatedEnv(binDir, pluginDataDir);

  const clientA = await CodexAppServerClient.connect(workspaceA, { env });
  const brokerSession = loadBrokerSession(workspaceA, env);
  assert.ok(brokerSession?.endpoint);

  try {
    const threadA = (await clientA.request("thread/start", { cwd: workspaceA })).thread.id;

    let completedText = null;
    const doneA = new Promise((resolve) => {
      clientA.setNotificationHandler((msg) => {
        if (msg.method === "item/completed" && msg.params?.threadId === threadA) {
          completedText = msg.params.item?.text ?? null;
        }
        if (msg.method === "turn/completed" && msg.params?.threadId === threadA) {
          resolve();
        }
      });
    });

    await clientA.request("turn/start", {
      threadId: threadA,
      input: [{ type: "text", text: "keep-running slow" }]
    });

    // SessionEnd for workspaceB runs while workspaceA's client still has an active turn.
    const hookResult = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: workspaceB,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: workspaceB
      })
    });
    assert.equal(hookResult.status, 0, hookResult.stderr);

    // Client A must still complete its in-flight turn cleanly.
    await doneA;
    assert.equal(completedText, "reply:keep-running slow");

    await clientA.close();

    // Once the last client leaves, the draining broker exits on its own.
    await waitFor(() => !isProcessAlive(brokerSession.pid), { timeoutMs: 5000 });
  } finally {
    await clientA.close().catch(() => {});
    clearBrokerSession(workspaceA, env);
  }
});

test("broker exits automatically after idle timeout when no clients are connected", async () => {
  const workspace = makeTempDir("cxc-ws-idle-");
  const binDir = makeTempDir("cxc-bin-");
  const pluginDataDir = makeTempDir("cxc-data-");
  installFakeCodex(binDir);
  const env = buildIsolatedEnv(binDir, pluginDataDir, {
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "250"
  });

  const session = await ensureBrokerSession(workspace, { env });
  assert.ok(session?.endpoint);
  assert.ok(Number.isFinite(session.pid));

  try {
    await waitFor(() => !isProcessAlive(session.pid), { timeoutMs: 5000 });
    assert.equal(await waitForBrokerEndpoint(session.endpoint, 150), false);
  } finally {
    teardownBrokerSession(session);
    clearBrokerSession(workspace, env);
  }
});

test("ensureBrokerSession recovers from a stale broker.lock directory", async () => {
  const workspace = makeTempDir("cxc-ws-stale-lock-");
  const binDir = makeTempDir("cxc-bin-");
  const pluginDataDir = makeTempDir("cxc-data-");
  installFakeCodex(binDir);
  const env = buildIsolatedEnv(binDir, pluginDataDir);

  const stateRoot = resolveStateRoot(env);
  const lockDir = path.join(stateRoot, "broker.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, staleTime, staleTime);

  let session = null;
  try {
    session = await ensureBrokerSession(workspace, { env });
    assert.ok(session?.endpoint, "should recover from stale lock and start broker");
    assert.equal(fs.existsSync(lockDir), false, "lock dir should be released after startup");
  } finally {
    if (session?.endpoint) {
      await sendBrokerShutdown(session.endpoint);
      teardownBrokerSession(session);
      clearBrokerSession(workspace, env);
    }
  }
});
