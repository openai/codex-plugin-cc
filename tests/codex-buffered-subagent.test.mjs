import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { runAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";

test("runAppServerTurn replays buffered subagent lifecycle without leaking unrelated thread output", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-buffered-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const progress = [];
  const env = buildEnv(binDir);
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;

  try {
    const result = await runAppServerTurn(repo, {
      prompt: "challenge the current design",
      onProgress(update) {
        progress.push(typeof update === "string" ? { message: update } : update);
      }
    });

    assert.equal(result.status, 0);
    assert.equal(result.finalMessage, "Handled the requested task.\nTask prompt accepted.");

    const messages = progress.map((update) => update.message ?? "").join("\n");
    const logBodies = progress.map((update) => update.logBody ?? "").join("\n");

    assert.match(messages, /Starting subagent design-challenger via collaboration tool: wait\./);
    assert.match(messages, /Subagent design-challenger reasoning:/);
    assert.match(logBodies, /The design assumes retries are harmless/);
    assert.doesNotMatch(messages, /off-turn-agent/);
    assert.doesNotMatch(logBodies, /Off-turn thread output should stay out of this capture\./);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});
