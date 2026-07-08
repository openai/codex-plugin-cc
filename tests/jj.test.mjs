import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectDefaultBranch,
  getCurrentBranch,
  getWorkingTreeState,
  resolveReviewTarget,
  collectReviewContext
} from "../plugins/codex/scripts/lib/jj.mjs";
import { binaryAvailable } from "../plugins/codex/scripts/lib/process.mjs";
import { initJjRepo, initJjRepoWithCommit, commitJjChange, makeTempDir, run } from "./helpers.mjs";

const JJ_SKIP = !binaryAvailable("jj").available && "jj binary not available";

// ─── getWorkingTreeState ──────────────────────────────────────────────────────

test("getWorkingTreeState — clean working copy returns empty staged and isDirty false", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-wts-clean-");
  initJjRepoWithCommit(cwd);
  const state = getWorkingTreeState(cwd);
  assert.deepEqual(state.staged, [], "staged should be empty for clean working copy");
  assert.deepEqual(state.unstaged, [], "unstaged is always empty in jj");
  assert.deepEqual(state.untracked, [], "untracked is always empty in jj");
  assert.equal(state.isDirty, false, "isDirty should be false when working copy is clean");
});

test("getWorkingTreeState — modified file returns staged and isDirty true", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-wts-dirty-");
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "hello\n");
  const state = getWorkingTreeState(cwd);
  assert.ok(state.staged.includes("app.js"), `staged should include 'app.js', got: ${JSON.stringify(state.staged)}`);
  assert.deepEqual(state.unstaged, [], "unstaged is always empty in jj");
  assert.deepEqual(state.untracked, [], "untracked is always empty in jj");
  assert.equal(state.isDirty, true, "isDirty should be true when working copy has modifications");
});

// ─── getCurrentBranch ────────────────────────────────────────────────────────

test("getCurrentBranch — returns change ID when no bookmarks", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-branch-");
  initJjRepo(cwd);
  const branch = getCurrentBranch(cwd);
  assert.match(branch, /^[a-z]{8}$/, "should return 8-char change ID when no bookmarks");
  assert.notEqual(branch, "HEAD", "should never return 'HEAD' (meaningless in jj)");
});

// ─── detectDefaultBranch ─────────────────────────────────────────────────────

test("detectDefaultBranch — throws when trunk() is root() and no bookmarks", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-trunk-root-");
  initJjRepo(cwd); // fresh repo, no remote — trunk() resolves to root()
  assert.throws(
    () => detectDefaultBranch(cwd),
    /Unable to detect the repository default branch/,
    "should throw when trunk() resolves to root() and no candidate bookmarks exist"
  );
});

test("detectDefaultBranch — falls back to main bookmark when trunk() is root()", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-trunk-fallback-main-");
  initJjRepoWithCommit(cwd);
  // Create a 'main' bookmark on the initial commit (trunk() still resolves to root)
  run("jj", ["bookmark", "create", "main", "-r", "@-"], { cwd });
  const base = detectDefaultBranch(cwd);
  assert.equal(base, "main", "should fall back to 'main' bookmark when trunk() resolves to root()");
});

// ─── resolveReviewTarget ─────────────────────────────────────────────────────

test("resolveReviewTarget — auto-detect selects working-tree when dirty", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-resolve-auto-dirty-");
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('hello');\n");
  const target = resolveReviewTarget(cwd, {});
  assert.equal(target.mode, "working-tree", "should select working-tree mode when dirty");
  assert.equal(target.explicit, false, "auto-detect sets explicit to false");
});

test("resolveReviewTarget — explicit working-tree scope works", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-resolve-explicit-wt-");
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('hello');\n");
  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  assert.equal(target.mode, "working-tree", "explicit working-tree scope should yield working-tree mode");
  assert.equal(target.explicit, true, "explicit scope sets explicit to true");
});

test("resolveReviewTarget — unsupported scope throws", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-resolve-invalid-scope-");
  initJjRepo(cwd);
  assert.throws(
    () => resolveReviewTarget(cwd, { scope: "invalid" }),
    /Unsupported review scope/,
    "should throw for unsupported scope"
  );
});

test("collectReviewContext — branch mode works when base ref has multiple bookmarks", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-multi-bookmark-review-");
  initJjRepoWithCommit(cwd);
  // Create two bookmarks on the same commit — verifies that passing a
  // bookmark name as --base doesn't break when the commit has siblings.
  run("jj", ["bookmark", "create", "main", "-r", "@-"], { cwd });
  run("jj", ["bookmark", "create", "origin/main", "-r", "@-"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature.js"), "// feature\n");
  commitJjChange(cwd, "feature change");

  // Use explicit base to bypass trunk() resolution (requires remote in jj 0.40+)
  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.equal(context.mode, "branch", "should produce branch context without error");
  assert.ok(context.content.includes("## Commit Log"), "should have Commit Log section");
});

// ─── collectReviewContext — working copy ─────────────────────────────────────

test("collectReviewContext — working copy inline mode has correct sections and shape", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-wt-inline-");
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  // inputMode and mode checks
  assert.equal(context.inputMode, "inline-diff", "small diff should use inline-diff mode");
  assert.equal(context.fileCount, 1, "fileCount should be 1");
  assert.equal(context.mode, "working-tree", "mode should be working-tree");

  // Section headers
  assert.ok(context.content.includes("## Git Status"), "content must include '## Git Status' section");
  assert.ok(context.content.includes("## Staged Diff"), "content must include '## Staged Diff' section");
  assert.ok(context.content.includes("## Unstaged Diff"), "content must include '## Unstaged Diff' section");
  assert.ok(context.content.includes("## Untracked Files"), "content must include '## Untracked Files' section");

  // Actual diff content
  assert.ok(context.content.includes("INLINE_MARKER"), "content must contain actual diff content");

  // collectionGuidance check
  assert.match(context.collectionGuidance, /primary evidence/i, "collectionGuidance should mention 'primary evidence' for inline mode");

  // changedFiles check
  assert.ok(context.changedFiles.includes("app.js"), `changedFiles should include 'app.js', got: ${JSON.stringify(context.changedFiles)}`);

  // All required fields
  const requiredFields = [
    "cwd", "repoRoot", "branch", "target", "fileCount",
    "diffBytes", "inputMode", "collectionGuidance", "mode", "summary", "content", "changedFiles"
  ];
  for (const field of requiredFields) {
    assert.ok(field in context, `context missing required field: ${field}`);
  }
});

test("collectReviewContext — no ANSI escape codes in content", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-ansi-");
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "check.js"), "// test file\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.ok(
    !/\u001b\[/.test(context.content),
    "ANSI escape codes found in content — --color=never should prevent them"
  );
});

test("collectReviewContext — self-collect mode when forced", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-wt-self-");
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('self-collect');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { includeDiff: false });

  assert.equal(context.inputMode, "self-collect", "forced includeDiff=false should yield self-collect mode");
  assert.ok(
    context.content.includes("## Staged Diff Stat"),
    "self-collect content must include '## Staged Diff Stat' section"
  );
  assert.match(
    context.collectionGuidance,
    /lightweight summary/i,
    "collectionGuidance should mention 'lightweight summary' for self-collect mode"
  );
  assert.ok(
    !context.collectionGuidance.includes("jj diff"),
    "self-collect guidance must NOT suggest running jj commands (sandbox-unsafe)"
  );
  assert.match(
    context.collectionGuidance,
    /do not attempt to run jj commands/i,
    "self-collect guidance must explicitly warn against running jj commands"
  );
});

// ─── collectReviewContext — range mode ───────────────────────────────────────

function setupRepoWithBranch(cwd) {
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "// base\n");
  commitJjChange(cwd, "first change");
  run("jj", ["bookmark", "create", "main", "-r", "@-"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature.js"), "// feature\n");
  commitJjChange(cwd, "second change");
}

function setupDivergedRepoWithAdvancedBase(cwd) {
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "// base\n");
  commitJjChange(cwd, "base change");
  const baseId = run("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id.short(8)"], { cwd }).stdout.trim();
  run("jj", ["bookmark", "create", "main", "-r", "@-"], { cwd });

  fs.writeFileSync(path.join(cwd, "feature.js"), "// feature\n");
  commitJjChange(cwd, "feature change");
  const featureId = run("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id.short(8)"], { cwd }).stdout.trim();

  run("jj", ["new", baseId], { cwd });
  fs.writeFileSync(path.join(cwd, "main-only.js"), "// main advance\n");
  commitJjChange(cwd, "main advance");
  run("jj", ["bookmark", "move", "main", "--to", "@-"], { cwd });
  run("jj", ["edit", featureId], { cwd });
}

test("collectReviewContext — range mode with inline diff", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-range-inline-");
  setupRepoWithBranch(cwd);

  // Use explicit base to bypass trunk() (requires remote in jj 0.40+)
  const target = resolveReviewTarget(cwd, { base: "main" });
  assert.equal(target.mode, "branch", "resolveReviewTarget with explicit base should yield branch mode");

  const context = collectReviewContext(cwd, target);

  assert.equal(context.mode, "branch", "collectReviewContext mode should be 'branch'");

  // Section headers
  assert.ok(context.content.includes("## Commit Log"), "range content must include '## Commit Log' section");
  assert.ok(context.content.includes("## Diff Stat"), "range content must include '## Diff Stat' section");
  assert.ok(context.content.includes("## Branch Diff"), "range content must include '## Branch Diff' section");

  // All required fields
  const requiredFields = [
    "cwd", "repoRoot", "branch", "target", "fileCount",
    "diffBytes", "inputMode", "collectionGuidance", "mode", "summary", "content", "changedFiles"
  ];
  for (const field of requiredFields) {
    assert.ok(field in context, `context missing required field: ${field}`);
  }
});

test("collectReviewContext — range mode self-collect with sandbox-safe guidance", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-range-self-");
  setupRepoWithBranch(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target, { includeDiff: false });

  assert.equal(context.mode, "branch", "range self-collect mode should be 'branch'");
  assert.ok(
    context.content.includes("## Changed Files"),
    "range self-collect content must include '## Changed Files' section (not 'Branch Diff')"
  );
  assert.equal(context.inputMode, "self-collect", "stat-only mode should be self-collect");
  assert.ok(
    !context.collectionGuidance.includes("jj diff"),
    "self-collect guidance must NOT suggest running jj commands"
  );
});

test("collectReviewContext — range mode no ANSI codes", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-range-ansi-");
  setupRepoWithBranch(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.ok(
    !/\u001b\[/.test(context.content),
    "ANSI escape codes found in range mode content"
  );
});

test("collectReviewContext — branch mode excludes unrelated base bookmark advances", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-diverged-base-");
  setupDivergedRepoWithAdvancedBase(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.ok(context.changedFiles.includes("feature.js"), "feature.js should be reviewed");
  assert.ok(!context.changedFiles.includes("main-only.js"), "base-only changes should not be included in the review diff");
  assert.match(context.summary, /fork point with main/, "summary should describe merge-base semantics");
});

// ─── collectReviewContext — custom base ref ──────────────────────────────────

function setupRepoWithMidCommit(cwd) {
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "// base\n");
  commitJjChange(cwd, "first change");
  run("jj", ["bookmark", "create", "main", "-r", "@-"], { cwd });
  // mid commit — between trunk and feature
  fs.writeFileSync(path.join(cwd, "mid.js"), "// mid\n");
  commitJjChange(cwd, "mid change");
  // Capture mid commit's change ID for use as custom --base
  const midId = run("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id.short(8)"], { cwd }).stdout.trim();
  // feature commit on top
  fs.writeFileSync(path.join(cwd, "feature.js"), "// feature\n");
  commitJjChange(cwd, "feature change");
  return { midId };
}

test("collectReviewContext — custom --base revset used in range diff", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-custom-base-");
  const { midId } = setupRepoWithMidCommit(cwd);

  const target = resolveReviewTarget(cwd, { base: midId });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, midId);

  const context = collectReviewContext(cwd, target);

  // Only feature.js should appear — mid.js is before the custom base
  assert.ok(context.changedFiles.includes("feature.js"), "feature.js should be in changedFiles");
  assert.ok(!context.changedFiles.includes("mid.js"), "mid.js should NOT be in changedFiles when using mid commit as base");
  assert.ok(!context.changedFiles.includes("base.js"), "base.js should NOT be in changedFiles");

  // Summary should reference the custom base, not trunk()
  assert.ok(context.summary.includes(midId), `summary should reference custom base '${midId}', got: ${context.summary}`);
  assert.ok(!context.summary.includes("trunk()"), "summary should NOT reference trunk() when custom base is used");

  assert.equal(context.mode, "branch");
  assert.ok(context.fileCount >= 1, "fileCount should be at least 1");
});

test("collectReviewContext — custom --base context has all required fields", { skip: JJ_SKIP }, () => {
  const cwd = makeTempDir("jj-test-collect-custom-base-shape-");
  const { midId } = setupRepoWithMidCommit(cwd);

  const target = resolveReviewTarget(cwd, { base: midId });
  const context = collectReviewContext(cwd, target);

  const requiredFields = [
    "cwd", "repoRoot", "branch", "target", "fileCount",
    "diffBytes", "inputMode", "collectionGuidance", "mode", "summary", "content", "changedFiles"
  ];
  for (const field of requiredFields) {
    assert.ok(field in context, `context missing required field: ${field}`);
  }

  // Verify types match git backend contract
  assert.equal(typeof context.cwd, "string");
  assert.equal(typeof context.repoRoot, "string");
  assert.equal(typeof context.branch, "string");
  assert.equal(typeof context.target, "object");
  assert.equal(typeof context.fileCount, "number");
  assert.equal(typeof context.diffBytes, "number");
  assert.equal(typeof context.inputMode, "string");
  assert.equal(typeof context.collectionGuidance, "string");
  assert.equal(typeof context.mode, "string");
  assert.equal(typeof context.summary, "string");
  assert.equal(typeof context.content, "string");
  assert.ok(Array.isArray(context.changedFiles), "changedFiles should be an array");

  // collectionGuidance should be set (adversarial review uses this)
  assert.ok(context.collectionGuidance.length > 0, "collectionGuidance should not be empty");
});
