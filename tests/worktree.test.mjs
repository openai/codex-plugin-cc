import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorktreeSession,
  diffWorktreeSession,
  cleanupWorktreeSession
} from "../plugins/codex/scripts/lib/worktree.mjs";
import { getWorktreeDiff } from "../plugins/codex/scripts/lib/git.mjs";
import { renderWorktreeTaskResult } from "../plugins/codex/scripts/lib/render.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function gitStdout(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitFile(cwd, fileName = "app.js", contents = "export const value = 1;\n") {
  fs.writeFileSync(path.join(cwd, fileName), contents);
  assert.equal(run("git", ["add", fileName], { cwd }).status, 0);
  const commit = run("git", ["commit", "-m", "init"], { cwd });
  assert.equal(commit.status, 0, commit.stderr);
}

function createRepoWithInitialCommit() {
  const repoRoot = makeTempDir();
  initGitRepo(repoRoot);
  commitFile(repoRoot);
  return { repoRoot };
}

function cleanupSession(session) {
  if (!session || !fs.existsSync(session.worktreePath)) {
    return;
  }

  try {
    cleanupWorktreeSession(session, { keep: false });
  } catch {
    // Best-effort cleanup for temp test repositories.
  }
}

test("createWorktreeSession returns session with worktreePath, branch, repoRoot, baseCommit", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    assert.equal(session.repoRoot, repoRoot);
    assert.match(session.branch, /^codex\/\d+$/);
    assert.equal(session.worktreePath, path.join(repoRoot, ".worktrees", `codex-${session.timestamp}`));
    assert.ok(session.baseCommit);
    assert.ok(fs.existsSync(session.worktreePath));
  } finally {
    cleanupSession(session);
  }
});

test("createWorktreeSession baseCommit matches repo HEAD at creation time", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const headAtCreation = gitStdout(repoRoot, ["rev-parse", "HEAD"]);
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(repoRoot, "app.js"), "export const value = 2;\n");
    assert.equal(run("git", ["add", "app.js"], { cwd: repoRoot }).status, 0);
    const commit = run("git", ["commit", "-m", "repo-root change"], { cwd: repoRoot });
    assert.equal(commit.status, 0, commit.stderr);

    const newHead = gitStdout(repoRoot, ["rev-parse", "HEAD"]);
    assert.equal(session.baseCommit, headAtCreation);
    assert.notEqual(newHead, session.baseCommit);
  } finally {
    cleanupSession(session);
  }
});

test("diffWorktreeSession captures uncommitted changes in the worktree", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");

    const diff = diffWorktreeSession(session);

    assert.deepEqual(diff, getWorktreeDiff(session.worktreePath, session.baseCommit));
    assert.notEqual(diff.stat, "");
    assert.match(diff.stat, /app\.js/);
  } finally {
    cleanupSession(session);
  }
});

test("diffWorktreeSession captures committed changes in the worktree", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");
    assert.equal(run("git", ["add", "app.js"], { cwd: session.worktreePath }).status, 0);
    const commit = run("git", ["commit", "-m", "worktree change"], { cwd: session.worktreePath });
    assert.equal(commit.status, 0, commit.stderr);

    const diff = diffWorktreeSession(session);

    assert.deepEqual(diff, getWorktreeDiff(session.worktreePath, session.baseCommit));
    assert.notEqual(diff.stat, "");
    assert.match(diff.stat, /app\.js/);
  } finally {
    cleanupSession(session);
  }
});

test("diffWorktreeSession returns empty when no changes made", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    const diff = diffWorktreeSession(session);

    assert.deepEqual(diff, { stat: "", patch: "" });
    assert.deepEqual(diff, getWorktreeDiff(session.worktreePath, session.baseCommit));
  } finally {
    cleanupSession(session);
  }
});

test("diffWorktreeSession captures new untracked files in the worktree", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "newfile.js"), "export const added = true;\n");

    const diff = diffWorktreeSession(session);

    assert.notEqual(diff.stat, "");
    assert.match(diff.stat, /newfile\.js/);
    assert.match(diff.patch, /added = true/);
  } finally {
    cleanupSession(session);
  }
});

test("cleanupWorktreeSession with keep=true applies new untracked files to repoRoot", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "newfile.js"), "export const added = true;\n");

    const result = cleanupWorktreeSession(session, { keep: true });

    assert.equal(result.applied, true);
    assert.ok(fs.existsSync(path.join(repoRoot, "newfile.js")));
    assert.match(fs.readFileSync(path.join(repoRoot, "newfile.js"), "utf8"), /added = true/);
  } finally {
    cleanupSession(session);
  }
});

test("cleanupWorktreeSession with keep=true applies uncommitted worktree changes to repoRoot as staged changes", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");

    const result = cleanupWorktreeSession(session, { keep: true });
    const stagedStat = gitStdout(repoRoot, ["diff", "--cached", "--stat"]);

    assert.equal(result.applied, true);
    assert.match(stagedStat, /app\.js/);
    assert.equal(fs.existsSync(session.worktreePath), false);
  } finally {
    cleanupSession(session);
  }
});

test("cleanupWorktreeSession with keep=false discards worktree and returns applied:false", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");

    const result = cleanupWorktreeSession(session, { keep: false });
    const stagedStat = gitStdout(repoRoot, ["diff", "--cached", "--stat"]);

    assert.equal(result.applied, false);
    assert.match(result.detail, /Worktree discarded\./);
    assert.equal(stagedStat, "");
    assert.equal(fs.existsSync(session.worktreePath), false);
  } finally {
    cleanupSession(session);
  }
});

test("cleanupWorktreeSession with keep=true preserves worktree when apply fails", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");
    fs.writeFileSync(path.join(repoRoot, "app.js"), "export const value = 3;\n");
    assert.equal(run("git", ["add", "app.js"], { cwd: repoRoot }).status, 0);

    const result = cleanupWorktreeSession(session, { keep: true });
    const branchList = gitStdout(repoRoot, ["branch", "--list", session.branch]);

    assert.equal(result.applied, false);
    assert.ok(result.detail);
    assert.equal(fs.existsSync(session.worktreePath), true);
    assert.match(branchList, new RegExp(session.branch));
  } finally {
    cleanupSession(session);
  }
});

test("renderWorktreeTaskResult includes jobId in cleanup commands when provided", () => {
  const output = renderWorktreeTaskResult(
    { rendered: "# Task Result\n" },
    { branch: "codex/123", worktreePath: "/tmp/worktree-123" },
    { stat: " app.js | 1 +", patch: "" },
    { jobId: "job-123" }
  );

  assert.match(output, /worktree-cleanup job-123 --action keep/);
  assert.match(output, /worktree-cleanup job-123 --action discard/);
  assert.doesNotMatch(output, /worktree-cleanup JOB_ID/);
});

test("renderWorktreeTaskResult falls back to JOB_ID when jobId is null", () => {
  const output = renderWorktreeTaskResult(
    { rendered: "" },
    { branch: "codex/123", worktreePath: "/tmp/worktree-123" },
    { stat: "", patch: "" },
    { jobId: null }
  );

  assert.match(output, /worktree-cleanup JOB_ID --action keep/);
  assert.match(output, /worktree-cleanup JOB_ID --action discard/);
});
