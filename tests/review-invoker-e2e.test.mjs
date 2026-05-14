import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir };
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
}

test("review invoker persists to state and status JSON", () => {
  const { repo, binDir } = setupRepo();
  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review", "--invoker", "claude-subagent", "--scope", "working-tree"], {
    cwd: repo,
    env
  });

  assert.equal(review.status, 0, review.stderr);
  assert.equal(readState(repo).jobs[0].invoker, "claude-subagent");

  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.latestFinished.invoker, "claude-subagent");
  assert.equal(payload.reviewInvokerBreakdown.byInvoker["claude-subagent"], 1);
});

test("review rejects invalid invoker values", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "review", "--invoker", "bogus"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr,
    "Invalid --invoker value: bogus. Expected one of: user-slash, claude-subagent, claude-bash, hook.\n"
  );
});

test("review rate limit refuses non-user invocations but never user-slash", () => {
  const { repo, binDir } = setupRepo();
  const env = {
    ...buildEnv(binDir),
    CODEX_PLUGIN_REVIEW_RATE_LIMIT: "1/60min"
  };

  const first = run("node", [SCRIPT, "review", "--invoker", "claude-subagent", "--scope", "working-tree"], {
    cwd: repo,
    env
  });
  assert.equal(first.status, 0, first.stderr);

  const second = run("node", [SCRIPT, "review", "--invoker", "claude-subagent", "--scope", "working-tree"], {
    cwd: repo,
    env
  });
  assert.notEqual(second.status, 0);
  assert.equal(
    second.stderr,
    "Codex review rate limit exceeded: 1/60min for invoker claude-subagent. Run `/codex:adversarial-review` (user-slash) to bypass.\n"
  );

  const userSlash = run("node", [SCRIPT, "review", "--scope", "working-tree"], {
    cwd: repo,
    env
  });
  assert.equal(userSlash.status, 0, userSlash.stderr);
});
