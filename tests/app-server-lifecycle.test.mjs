import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

function settleWithin(promise, timeoutMs = 250) {
  let timer;
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("a request made after the app-server child exits rejects instead of hanging", async () => {
  const binDir = makeTempDir("codex-plugin-lifecycle-");
  installFakeCodex(binDir, "exit-after-initialize");

  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: buildEnv(binDir)
  });

  await client.terminalPromise;
  const outcome = await settleWithin(
    Promise.resolve().then(() => client.request("account/read", { refreshToken: false }))
  );

  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reason.message, /connection closed|exited|stdout closed/i);
  await client.close();
});

test("a JSON null protocol line rejects initialization instead of crashing the host", async () => {
  const binDir = makeTempDir("codex-plugin-null-line-");
  installFakeCodex(binDir, "null-on-initialize");

  await assert.rejects(
    CodexAppServerClient.connect(binDir, {
      disableBroker: true,
      env: buildEnv(binDir)
    }),
    /invalid codex app-server JSONL message/i
  );
});

test("protocol EOF rejects initialization and reaps the live child", { skip: process.platform === "win32" }, async () => {
  const binDir = makeTempDir("codex-plugin-stdout-eof-");
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "stdout-eof-on-initialize");
  let pid = null;

  try {
    const outcome = await settleWithin(
      CodexAppServerClient.connect(binDir, {
        disableBroker: true,
        env: buildEnv(binDir)
      }),
      2000
    );
    pid = JSON.parse(fs.readFileSync(statePath, "utf8")).pid;

    assert.equal(outcome.status, "rejected");
    assert.match(outcome.reason.message, /stdout closed|connection closed/i);
    assert.equal(processIsAlive(pid), false);
  } finally {
    if (pid && processIsAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});

test("a broken app-server stdin becomes the single terminal cause", { skip: process.platform === "win32" }, async () => {
  const binDir = makeTempDir("codex-plugin-stdin-eof-");
  installFakeCodex(binDir, "stdin-eof-after-initialize");
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: buildEnv(binDir)
  });

  try {
    const outcome = await settleWithin(client.terminalPromise, 2000);
    assert.equal(outcome.status, "fulfilled");
    assert.match(client.terminalCause.message, /EPIPE|broken pipe|write/i);
    assert.throws(() => client.request("account/read", {}), (error) => error === client.terminalCause);
  } finally {
    await client.close();
  }
});

test("close is idempotent when terminal listeners re-enter teardown", async () => {
  const binDir = makeTempDir("codex-plugin-close-reentry-");
  installFakeCodex(binDir);
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: buildEnv(binDir)
  });
  let listenerClose = null;
  client.onTerminal(() => {
    listenerClose = client.close();
  });

  await client.close();
  await listenerClose;
  assert.equal(processIsAlive(client.proc.pid), false);
});

test("close lets a cooperative app-server finish before escalation", { skip: process.platform === "win32" }, async () => {
  const binDir = makeTempDir("codex-plugin-clean-exit-");
  installFakeCodex(binDir, "slow-clean-exit");
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: buildEnv(binDir)
  });
  const exited = new Promise((resolve) => {
    client.proc.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await client.close();
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("initialization failure reaps the owned app-server child before rejecting", async () => {
  const binDir = makeTempDir("codex-plugin-init-reap-");
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "malformed-on-initialize");
  let pid = null;

  try {
    await assert.rejects(
      CodexAppServerClient.connect(binDir, {
        disableBroker: true,
        env: buildEnv(binDir)
      }),
      /Failed to parse codex app-server JSONL/
    );
    pid = JSON.parse(fs.readFileSync(statePath, "utf8")).pid;
    assert.equal(processIsAlive(pid), false);
  } finally {
    if (pid && processIsAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});

test("forced teardown reaps an uncooperative launcher and its descendant", { skip: process.platform === "win32" }, async () => {
  const binDir = makeTempDir("codex-plugin-force-reap-");
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "uncooperative-tree-on-initialize");
  let launcherPid = null;
  let descendantPid = null;

  try {
    const outcome = await settleWithin(
      CodexAppServerClient.connect(binDir, {
        disableBroker: true,
        env: buildEnv(binDir)
      }),
      3000
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    launcherPid = state.pid;
    descendantPid = state.descendantPid;

    assert.equal(outcome.status, "rejected");
    assert.match(outcome.reason.message, /failed to parse/i);
    assert.equal(processIsAlive(launcherPid), false);
    assert.equal(processIsAlive(descendantPid), false);
  } finally {
    for (const pid of [launcherPid, descendantPid]) {
      if (pid && processIsAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  }
});

test("silent initialization is bounded and reaps the owned child", { timeout: 22000 }, async () => {
  const binDir = makeTempDir("codex-plugin-silent-init-");
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "silent-on-initialize");
  let pid = null;

  try {
    const outcome = await settleWithin(
      CodexAppServerClient.connect(binDir, {
        disableBroker: true,
        env: buildEnv(binDir)
      }),
      18000
    );
    pid = JSON.parse(fs.readFileSync(statePath, "utf8")).pid;
    assert.equal(outcome.status, "rejected");
    assert.match(outcome.reason.message, /initialization timed out/i);
    assert.equal(processIsAlive(pid), false);
  } finally {
    if (pid && processIsAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});
