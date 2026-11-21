import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

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

function shutdownBroker(repo, env) {
  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
}

test("consecutive invocations on a shared broker unsubscribe threads instead of accumulating them", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  try {
    const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
    assert.equal(review.status, 0, review.stderr);

    const afterFirst = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(afterFirst.loadedThreads, []);
    assert.equal(afterFirst.unsubscribedThreads.length, 1);

    const adversarial = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env });
    assert.equal(adversarial.status, 0, adversarial.stderr);

    const afterSecond = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(afterSecond.loadedThreads, []);
    assert.equal(afterSecond.unsubscribedThreads.length, 2);

    if (loadBrokerSession(repo)) {
      assert.equal(afterSecond.appServerStarts, 1);
    }
  } finally {
    shutdownBroker(repo, env);
  }
});

test("persisted task threads are unsubscribed after each turn and can still be resumed", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);

  try {
    const first = run("node", [SCRIPT, "task", "Inspect the repository"], { cwd: repo, env });
    assert.equal(first.status, 0, first.stderr);

    const afterFirst = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(afterFirst.loadedThreads, []);
    assert.equal(afterFirst.unsubscribedThreads.length, 1);

    const resumed = run("node", [SCRIPT, "task", "--resume", "Continue checking"], { cwd: repo, env });
    assert.equal(resumed.status, 0, resumed.stderr);

    const afterResume = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(afterResume.loadedThreads, []);
    assert.equal(afterResume.unsubscribedThreads.length, 2);
    assert.equal(afterResume.unsubscribedThreads[0], afterResume.unsubscribedThreads[1]);
  } finally {
    shutdownBroker(repo, env);
  }
});

test("broker unsubscribes leaked threads when a client disconnects abruptly", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  try {
    const session = await ensureBrokerSession(repo, { env });
    assert.ok(session?.endpoint, "expected broker session to start");

    const client = await CodexAppServerClient.connect(repo, {
      env,
      brokerEndpoint: session.endpoint
    });

    const started = await client.request("thread/start", {
      cwd: repo,
      model: null,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "claude_code_codex_plugin",
      ephemeral: true
    });
    assert.ok(started.thread.id);

    const whileConnected = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(whileConnected.loadedThreads, [started.thread.id]);

    // Disconnect without calling thread/unsubscribe (simulating a killed or crashed invocation).
    await client.close();

    const afterDisconnect = await waitFor(() => {
      const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      return state.loadedThreads.length === 0 ? state : null;
    });

    assert.deepEqual(afterDisconnect.loadedThreads, []);
    assert.ok(afterDisconnect.unsubscribedThreads.includes(started.thread.id));
  } finally {
    shutdownBroker(repo, env);
  }
});

test("invocations succeed when older Codex CLI does not support thread/unsubscribe", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();

  installFakeCodex(binDir, "unsubscribe-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  try {
    const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /No material issues found/);
  } finally {
    shutdownBroker(repo, env);
  }
});
