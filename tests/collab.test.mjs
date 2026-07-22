import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";

const COLLAB_CLI = path.resolve("plugins/codex/scripts/collab.mjs");

function makeRepo() {
  const repo = path.join(makeTempDir(), "mainrepo");
  fs.mkdirSync(repo, { recursive: true });
  run("git", ["-C", repo, "init", "-q", "-b", "main"]);
  run("git", ["-C", repo, "config", "user.email", "test@test"]);
  run("git", ["-C", repo, "config", "user.name", "test"]);
  run("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function collab(repo, args) {
  return run("node", [COLLAB_CLI, ...args], { cwd: repo });
}

test("init creates the shared workspace and excludes it from git", () => {
  const repo = makeRepo();
  const result = collab(repo, ["init"]);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(repo, ".codex-claude", "mailbox.jsonl")), true);
  assert.equal(fs.existsSync(path.join(repo, ".codex-claude", "decisions.md")), true);
  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /\.codex-claude\//);
  const gitState = run("git", ["-C", repo, "status", "--porcelain"]);
  assert.equal(gitState.stdout.trim(), "");
});

test("post and inbox deliver peer messages once, own messages never", () => {
  const repo = makeRepo();
  collab(repo, ["init"]);
  collab(repo, ["post", "--from", "codex", "--type", "status", "--body", "step one done"]);
  collab(repo, ["post", "--from", "claude", "--type", "status", "--body", "own note"]);

  const first = collab(repo, ["inbox", "--for", "claude"]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /step one done/);
  assert.doesNotMatch(first.stdout, /own note/);

  const second = collab(repo, ["inbox", "--for", "claude"]);
  assert.match(second.stdout, /No new messages/);
});

test("inbox --peek does not advance the cursor", () => {
  const repo = makeRepo();
  collab(repo, ["init"]);
  collab(repo, ["post", "--from", "codex", "--type", "question", "--body", "which schema?"]);
  const peek = collab(repo, ["inbox", "--for", "claude", "--peek"]);
  assert.match(peek.stdout, /which schema\?/);
  const again = collab(repo, ["inbox", "--for", "claude"]);
  assert.match(again.stdout, /which schema\?/);
});

test("overlapping claims from both agents are reported as conflicts", () => {
  const repo = makeRepo();
  collab(repo, ["init"]);
  collab(repo, ["claim", "--agent", "codex", "--issue", "a", "--paths", "src/auth/,src/db.ts"]);
  const result = collab(repo, ["claim", "--agent", "claude", "--issue", "b", "--paths", "src/auth/login.ts"]);
  assert.match(result.stdout, /CONFLICT/);
  const conflicts = collab(repo, ["conflicts"]);
  assert.match(conflicts.stdout, /src\/auth/);
});

test("assign creates a worktree, branch, and registry entry", () => {
  const repo = makeRepo();
  const result = collab(repo, ["assign", "--agent", "codex", "--issue", "fix-auth", "--title", "Fix auth"]);
  assert.equal(result.status, 0);
  const worktree = path.join(path.dirname(repo), "mainrepo--codex-fix-auth");
  assert.equal(fs.existsSync(worktree), true);
  const branches = run("git", ["-C", repo, "branch", "--list", "codex/fix-auth"]);
  assert.match(branches.stdout, /codex\/fix-auth/);
  const assignments = JSON.parse(fs.readFileSync(path.join(repo, ".codex-claude", "assignments.json"), "utf8"));
  assert.equal(assignments["fix-auth"].agent, "codex");
  assert.equal(assignments["fix-auth"].base, "main");
  const duplicate = collab(repo, ["assign", "--agent", "claude", "--issue", "fix-auth"]);
  assert.notEqual(duplicate.status, 0);
});

test("merge requires an approving review from the non-author agent", () => {
  const repo = makeRepo();
  collab(repo, ["assign", "--agent", "codex", "--issue", "feat-x", "--title", "Feature X"]);
  const worktree = path.join(path.dirname(repo), "mainrepo--codex-feat-x");
  fs.writeFileSync(path.join(worktree, "x.txt"), "x\n", "utf8");
  run("git", ["-C", worktree, "add", "x.txt"]);
  run("git", ["-C", worktree, "-c", "user.email=test@test", "-c", "user.name=test", "commit", "-q", "-m", "add x"]);

  const blocked = collab(repo, ["merge", "--issue", "feat-x"]);
  assert.notEqual(blocked.status, 0);

  collab(repo, ["post", "--from", "claude", "--type", "review", "--issue", "feat-x", "--body", "needs work: rename x"]);
  const stillBlocked = collab(repo, ["merge", "--issue", "feat-x"]);
  assert.notEqual(stillBlocked.status, 0);

  collab(repo, ["post", "--from", "claude", "--type", "review", "--issue", "feat-x", "--body", "approve — verified x.txt lands"]);
  const merged = collab(repo, ["merge", "--issue", "feat-x"]);
  assert.equal(merged.status, 0);
  assert.equal(fs.existsSync(path.join(repo, "x.txt")), true);
  assert.equal(fs.existsSync(worktree), false);
});

test("decision messages are appended to decisions.md", () => {
  const repo = makeRepo();
  collab(repo, ["init"]);
  collab(repo, [
    "post",
    "--from",
    "claude",
    "--type",
    "decision",
    "--issue",
    "feat-x",
    "--body",
    "Contested: retry semantics. Codex favors idempotency keys; I favor dedup table. Default: idempotency keys."
  ]);
  const decisions = fs.readFileSync(path.join(repo, ".codex-claude", "decisions.md"), "utf8");
  assert.match(decisions, /feat-x/);
  assert.match(decisions, /idempotency keys/);
});
