import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { interruptAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";

test("interruptAppServerTurn tears down a connect wedged during initialize", async (t) => {
  if (process.platform === "win32") {
    return;
  }

  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  // The availability probe runs against the test process's own PATH.
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

  // A broker that accepts connections but never answers `initialize`.
  const sockPath = path.join(makeTempDir(), "wedged-broker.sock");
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(sockPath, resolve));
  t.after(() => server.close());

  saveBrokerSession(repo, {
    endpoint: `unix:${sockPath}`,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    pid: null
  });

  const started = Date.now();
  const result = await interruptAppServerTurn(repo, {
    threadId: "thr_1",
    turnId: "turn_1",
    timeoutMs: 500
  });

  // The timeout must both return promptly and destroy the wedged in-progress
  // client — a lingering socket would keep this test process alive forever.
  assert.equal(result.interrupted, false);
  assert.match(result.detail, /Timed out/);
  assert.ok(Date.now() - started < 5000, "the interrupt must return within its budget");
});
