import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
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

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
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

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext routes 2-file changes to self-collect (inline cap is 1)", () => {
  // Regression guard: a 2-file change used to slip into inline-diff because
  // the cap was 2, embedding both files into a single-turn schema-pinned
  // prompt — and the model often responded with a tool-call stub instead
  // of the review JSON. Two files now go through the two-phase self-collect
  // path which tolerates exploratory turns.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "self-collect",
    "2-file changes must NOT be inlined; they hit the schema-pinned single-turn bug otherwise");
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext routes larger adversarial reviews to self-collect with the diff fed", () => {
  // Routing guard: >1 changed file must never take the single-shot inline path.
  // The diff itself is still embedded — it is well under the investigation
  // budget, and re-deriving it would cost the reviewer an expensive first turn.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.equal(context.investigationInline, true);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  assert.match(context.content, /SELF_COLLECT_MARKER_A/);
});

test("collectReviewContext falls back to self-collect for oversized single-file diffs", () => {
  // The two budgets are independent: exceeding the single-shot byte cap moves
  // the review off the inline-diff path, but the diff still fits the (much
  // larger) investigation budget, so it is fed to the multi-turn prompt.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /xxx/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  // Blind working-tree path (diff over the investigation budget): untracked
  // files never appear in `git diff`, so their contents must still be embedded
  // or the summary hides them entirely.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { investigationInlineMaxBytes: 10 });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.equal(context.investigationInline, false);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("collectReviewContext routes a single oversized untracked file to self-collect", () => {
  // An untracked file never shows up in `git diff`, so its size does not count
  // toward diffBytes. A single untracked file >24 KiB therefore looked like a
  // 1-file, 0-byte diff and slipped onto the inline path — where the prompt
  // embeds only a `(skipped: ...)` marker AND forbids shell. The reviewer could
  // then only approve/guess. Skipped untracked content must fall through to
  // self-collect so Codex can read the file with read-only commands.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // One untracked file, contents exceed MAX_UNTRACKED_BYTES (24 KiB).
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), "x".repeat(30 * 1024));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect",
    "a skipped untracked file must NOT be inlined; the prompt would embed only a (skipped) marker while forbidding shell");
});

test("collectReviewContext routes a single binary untracked file to self-collect", () => {
  // Same hazard as the oversized case: a small binary untracked file is within
  // the byte/file caps but its contents are skipped as `(skipped: binary file)`,
  // so the inline prompt would show nothing useful while forbidding shell.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // Untracked binary file: NUL bytes make isProbablyText() false.
  fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 4, 0]));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect",
    "a binary untracked file must NOT be inlined; its contents are skipped in the embedded prompt");
});

test("collectReviewContext still inlines a single small text untracked file", () => {
  // Guard the fix from over-reaching: an untracked file whose contents ARE
  // embeddable (small, text) must stay on the inline path.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "small-new.js"), "export const v = 'INLINE_UNTRACKED_MARKER';\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /INLINE_UNTRACKED_MARKER/);
});

test("mid-size branch diff self-collects WITH the full diff embedded (investigation inline)", () => {
  // The multi-turn path used to be handed a stat-only summary, so the reviewer
  // burned its first (very expensive) reasoning turns re-deriving the diff with
  // `git diff`. Anything under the investigation budget is now fed inline while
  // still routing to the multi-turn path.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));
  run("git", ["add", "doc-one.md", "doc-two.md"], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /## Branch Diff/);
  assert.match(context.content, /diff --git/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
});

test("diff above the investigation budget self-collects blind (lightweight summary)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));
  run("git", ["add", "doc-one.md", "doc-two.md"], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES = "10";
  try {
    const context = collectReviewContext(cwd, target);
    assert.equal(context.inputMode, "self-collect");
    assert.equal(context.investigationInline, false);
    assert.match(context.content, /## Changed Files/);
    assert.doesNotMatch(context.content, /diff --git/);
    assert.match(context.collectionGuidance, /lightweight summary/i);
    assert.match(context.collectionGuidance, /read-only git commands/i);
  } finally {
    delete process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES;
  }
});

test("tiny single-file diff still routes to inline-diff (single-shot path unchanged)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.investigationInline, false);
  assert.match(context.collectionGuidance, /primary evidence/i);
});

test("explicit includeDiff:false still forces blind self-collect", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('OVERRIDE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { includeDiff: false });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, false);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.doesNotMatch(context.content, /OVERRIDE_MARKER/);
});

test("mid-size working-tree diff also gets investigation inline", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "STAGED_FED_MARKER";\n');
  run("git", ["add", "a.js"], { cwd });
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "UNSTAGED_FED_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true);
  assert.match(context.content, /## Staged Diff/);
  assert.match(context.content, /## Unstaged Diff/);
  assert.match(context.content, /diff --git/);
  assert.match(context.content, /STAGED_FED_MARKER/);
  assert.match(context.content, /UNSTAGED_FED_MARKER/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  // Nothing was skipped, so the guidance must NOT hedge about untracked files.
  assert.doesNotMatch(context.collectionGuidance, /could not be embedded/i);
});

test("fed working-tree guidance warns when untracked content could not be embedded", () => {
  // An untracked file never appears in `git diff`, and oversized/binary ones are
  // reduced to a `(skipped: ...)` marker. Telling the model "the full diff is
  // embedded — do not re-derive it" would then assert complete evidence while
  // discouraging the one action that recovers the missing content: reading the
  // file. The fed wording must own that gap.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SKIPPED_CASE_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SKIPPED_CASE_MARKER_B";\n');
  // Untracked and over MAX_UNTRACKED_BYTES (24 KiB), so its contents are skipped.
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), "x".repeat(30 * 1024));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.investigationInline, true, "routing is unchanged: this still takes the fed path");
  assert.match(context.content, /SKIPPED_CASE_MARKER_A/);
  assert.match(context.content, /skipped: 30720 bytes/);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  assert.match(context.collectionGuidance, /read them directly with read-only commands/i);
});

test("fed branch-mode guidance keeps the unqualified wording (no untracked concept)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "export const value = 'seed';\n");
  run("git", ["add", "seed.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "doc-one.md"), "# planning doc\n".repeat(50));
  fs.writeFileSync(path.join(cwd, "doc-two.md"), "# spec doc\n".repeat(50));
  run("git", ["add", "doc-one.md", "doc-two.md"], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });
  // An untracked file that WOULD be skipped in working-tree mode. A branch diff
  // does not consider the working tree at all, so the wording must not hedge.
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), "x".repeat(30 * 1024));

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(context.investigationInline, true);
  assert.match(context.collectionGuidance, /full diff is embedded below/i);
  assert.doesNotMatch(context.collectionGuidance, /could not be embedded/i);
});
