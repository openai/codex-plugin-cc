import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const FAKE_BROKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-broker-fixture.mjs");

function makeTempDir(prefix = "codex-broker-lifecycle-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopBroker(session) {
  if (session?.pid) {
    try {
      process.kill(session.pid);
    } catch {
      // already gone
    }
  }
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

async function withIsolatedState(fn) {
  const pluginDataDir = makeTempDir();
  const cwd = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    await fn(cwd);
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    fs.rmSync(pluginDataDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function startSession(cwd, { codexHome, recordFile, busy } = {}) {
  const env = { ...process.env };
  delete env.CODEX_HOME;
  delete env.FAKE_BROKER_BUSY;
  if (codexHome !== undefined) {
    env.CODEX_HOME = codexHome;
  }
  if (recordFile) {
    env.FAKE_BROKER_RECORD = recordFile;
  }
  if (busy) {
    env.FAKE_BROKER_BUSY = "1";
  }
  return ensureBrokerSession(cwd, { scriptPath: FAKE_BROKER, env, timeoutMs: 5000 });
}

test("ensureBrokerSession records CODEX_HOME and reuses the broker for the same account", async () => {
  await withIsolatedState(async (cwd) => {
    const homeA = makeTempDir("codex-home-a-");
    let session;
    try {
      session = await startSession(cwd, { codexHome: homeA });
      assert.ok(session, "broker session should start");
      assert.equal(session.codexHome, homeA);

      const reused = await startSession(cwd, { codexHome: homeA });
      assert.ok(reused);
      assert.equal(reused.pid, session.pid, "same account must reuse the live broker");
      assert.equal(reused.sessionDir, session.sessionDir);
    } finally {
      stopBroker(session);
      fs.rmSync(homeA, { recursive: true, force: true });
    }
  });
});

test("switching CODEX_HOME shuts down the old broker and spawns one with the new env", async () => {
  await withIsolatedState(async (cwd) => {
    const homeA = makeTempDir("codex-home-a-");
    const homeB = makeTempDir("codex-home-b-");
    const recordB = path.join(makeTempDir("codex-record-"), "spawned-env");
    let first;
    let second;
    try {
      first = await startSession(cwd, { codexHome: homeA });
      assert.ok(first);

      second = await startSession(cwd, { codexHome: homeB, recordFile: recordB });
      assert.ok(second, "broker for the new account should start");
      assert.equal(second.codexHome, homeB);
      assert.notEqual(second.sessionDir, first.sessionDir, "a fresh broker must be spawned");

      // the new broker process really inherited the new CODEX_HOME
      assert.equal(fs.readFileSync(recordB, "utf8"), homeB);

      // the old broker received broker/shutdown and exited
      await waitFor(() => !isPidAlive(first.pid));

      // persisted state points at the new account
      assert.equal(loadBrokerSession(cwd)?.codexHome, homeB);
    } finally {
      stopBroker(first);
      stopBroker(second);
      for (const dir of [homeA, homeB, path.dirname(recordB)]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

test("account switch never kills a busy broker — falls back to null and keeps it serving", async () => {
  await withIsolatedState(async (cwd) => {
    const homeA = makeTempDir("codex-home-a-");
    const homeB = makeTempDir("codex-home-b-");
    let first;
    try {
      // Broker for account A that reports itself busy (mid-turn).
      first = await startSession(cwd, { codexHome: homeA, busy: true });
      assert.ok(first);

      // A caller with account B must NOT shut it down: null means "run direct".
      const second = await startSession(cwd, { codexHome: homeB });
      assert.equal(second, null, "busy broker must not be rotated");

      // The busy broker is untouched and still owned by account A.
      assert.equal(isPidAlive(first.pid), true, "busy broker must stay alive");
      assert.equal(loadBrokerSession(cwd)?.codexHome, homeA);

      // Same-account callers keep reusing it as before.
      const sameAccount = await startSession(cwd, { codexHome: homeA });
      assert.equal(sameAccount?.pid, first.pid);
    } finally {
      stopBroker(first);
      for (const dir of [homeA, homeB]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

test("legacy broker.json without codexHome is treated as the default account", async () => {
  await withIsolatedState(async (cwd) => {
    let session;
    try {
      session = await startSession(cwd, {});
      assert.ok(session);
      assert.equal(session.codexHome, "");

      // simulate a session persisted by a pre-fix plugin version
      const { codexHome: _omitted, ...legacy } = session;
      saveBrokerSession(cwd, legacy);

      const reused = await startSession(cwd, {});
      assert.ok(reused);
      assert.equal(reused.pid, session.pid, "default-account caller must reuse a legacy session");
    } finally {
      stopBroker(session);
    }
  });
});
