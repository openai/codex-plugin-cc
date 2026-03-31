import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, estimateDiffBytes, MAX_REVIEW_CONTENT_CHARS, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext truncates oversized working-tree diffs to stat summaries", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);

  // Create an initial commit so the repo has a HEAD.
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  // Generate a large unstaged change that exceeds MAX_REVIEW_CONTENT_CHARS.
  const bigContent = "x".repeat(MAX_REVIEW_CONTENT_CHARS + 1000);
  fs.writeFileSync(path.join(cwd, "big.txt"), bigContent);
  run("git", ["add", "big.txt"], { cwd });
  run("git", ["commit", "-m", "add big file"], { cwd });
  // Now modify it so it shows up as an unstaged diff.
  fs.writeFileSync(path.join(cwd, "big.txt"), "y".repeat(MAX_REVIEW_CONTENT_CHARS + 1000));

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.ok(
    context.content.length <= MAX_REVIEW_CONTENT_CHARS,
    `content length (${context.content.length}) should be at most ${MAX_REVIEW_CONTENT_CHARS}`
  );
  assert.match(context.content, /stat only/);
  assert.match(context.content, /full diff too large/);
});

test("collectReviewContext truncates oversized branch diffs to stat summaries", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);

  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  run("git", ["checkout", "-b", "feature/big"], { cwd });
  const bigContent = "x".repeat(MAX_REVIEW_CONTENT_CHARS + 1000);
  fs.writeFileSync(path.join(cwd, "big.txt"), bigContent);
  run("git", ["add", "big.txt"], { cwd });
  run("git", ["commit", "-m", "add big file"], { cwd });

  const target = resolveReviewTarget(cwd, { scope: "branch" });
  const context = collectReviewContext(cwd, target);

  assert.ok(
    context.content.length <= MAX_REVIEW_CONTENT_CHARS,
    `content length (${context.content.length}) should be at most ${MAX_REVIEW_CONTENT_CHARS}`
  );
  assert.match(context.content, /stat only/);
  assert.match(context.content, /full diff too large/);
});

test("estimateDiffBytes parses typical numstat output", () => {
  const numstat = "150\t10\tsrc/app.js\n20\t5\tsrc/lib.js";
  const result = estimateDiffBytes(numstat);
  assert.equal(result.bytes, (150 + 10 + 20 + 5) * 80);
  assert.equal(result.hasBinaryFiles, false);
});

test("estimateDiffBytes handles single file", () => {
  const result = estimateDiffBytes("42\t0\tfile.txt");
  assert.equal(result.bytes, 42 * 80);
  assert.equal(result.hasBinaryFiles, false);
});

test("estimateDiffBytes skips binary files in byte estimate and flags them", () => {
  const numstat = "10\t5\tsrc/app.js\n-\t-\tbinary.png";
  const result = estimateDiffBytes(numstat);
  // Only text file contributes to bytes; binary is skipped.
  assert.equal(result.bytes, (10 + 5) * 80);
  assert.equal(result.hasBinaryFiles, true);
});

test("estimateDiffBytes returns zero bytes and no binary flag for empty input", () => {
  const empty = estimateDiffBytes("");
  assert.equal(empty.bytes, 0);
  assert.equal(empty.hasBinaryFiles, false);

  const whitespace = estimateDiffBytes("   ");
  assert.equal(whitespace.bytes, 0);
  assert.equal(whitespace.hasBinaryFiles, false);
});
