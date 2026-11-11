import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { collectReviewContext, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

for (const [mode, options] of [["inline", {}], ["lightweight", { maxInlineFiles: 0 }]]) {
  test(`branch review keeps one commit snapshot when HEAD and base change during ${mode} collection`, (t) => {
    const cwd = makeTempDir();
    const git = (args) => {
      const result = run("git", args, { cwd, shell: false });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    initGitRepo(cwd);
    fs.writeFileSync(path.join(cwd, "base.js"), "export const base = true;\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    git(["checkout", "-b", "feature/reviewed"]);
    fs.writeFileSync(path.join(cwd, "reviewed.js"), "export const value = 'REVIEWED_CHANGE';\n");
    git(["add", "."]);
    git(["commit", "-m", "reviewed change"]);
    const reviewedHead = git(["rev-parse", "HEAD"]);
    git(["checkout", "-b", "feature/other"]);
    fs.writeFileSync(path.join(cwd, "reviewed.js"), "export const value = 'OTHER_BRANCH_CONTEXT';\n");
    fs.writeFileSync(path.join(cwd, "other.js"), "export const value = 'OTHER_BRANCH_CHANGE';\n");
    git(["add", "."]);
    git(["commit", "-m", "other branch change"]);
    git(["checkout", "feature/reviewed"]);

    const spawnSync = childProcess.spawnSync;
    let switched = false;
    t.mock.method(childProcess, "spawnSync", (command, args, commandOptions) => {
      const result = spawnSync(command, args, commandOptions);
      if (!switched && command === "git" && args[0] === "diff" && args[1] === "--name-only") {
        switched = true;
        const checkout = spawnSync("git", ["checkout", "feature/other"], {
          cwd, encoding: "utf8", shell: false, windowsHide: true
        });
        assert.equal(checkout.status, 0, checkout.stderr);
        const updateBase = spawnSync("git", ["update-ref", "refs/heads/main", "HEAD"], {
          cwd, encoding: "utf8", shell: false, windowsHide: true
        });
        assert.equal(updateBase.status, 0, updateBase.stderr);
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const context = collectReviewContext(cwd, { mode: "branch", baseRef: "main" }, options);

    assert.equal(switched, true);
    assert.equal(git(["branch", "--show-current"]), "feature/other");
    assert.deepEqual(context.changedFiles, ["reviewed.js"]);
    assert.equal(git(["diff", "--name-only", context.comparison.reviewRange]), "reviewed.js");
    assert.equal(context.branch, "feature/reviewed");
    assert.match(context.summary, /Reviewing branch feature\/reviewed /);
    assert.doesNotMatch(context.content, /other branch change|other\.js|OTHER_BRANCH_CHANGE|OTHER_BRANCH_CONTEXT/);
    assert.match(fs.readFileSync(path.join(cwd, "reviewed.js"), "utf8"), /OTHER_BRANCH_CONTEXT/);
    assert.ok(context.collectionGuidance.includes(context.comparison.commitRange));
    assert.ok(context.collectionGuidance.includes(`git show ${reviewedHead}:<path>`));
    assert.equal(context.comparison.headCommit, reviewedHead);
    assert.match(git(["show", `${context.comparison.headCommit}:reviewed.js`]), /REVIEWED_CHANGE/);
    assert.doesNotMatch(git(["show", `${context.comparison.headCommit}:reviewed.js`]), /OTHER_BRANCH_CONTEXT/);
    if (mode === "inline") {
      assert.match(context.content, /REVIEWED_CHANGE/);
    }
  });
}

test("branch review peels annotated base tags to commit snapshots", () => {
  const cwd = makeTempDir();
  const git = (args) => {
    const result = run("git", args, { cwd, shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  const baseCommit = git(["rev-parse", "HEAD"]);
  git(["tag", "-a", "review-base", "-m", "annotated base"]);
  const tagObject = git(["rev-parse", "review-base"]);
  assert.notEqual(tagObject, baseCommit);
  assert.equal(git(["cat-file", "-t", tagObject]), "tag");
  git(["checkout", "-b", "feature/reviewed"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('reviewed');\n");
  git(["add", "."]);
  git(["commit", "-m", "reviewed change"]);
  const headCommit = git(["rev-parse", "HEAD"]);

  const context = collectReviewContext(cwd, { mode: "branch", baseRef: "review-base" }, { maxInlineFiles: 0 });

  assert.equal(context.comparison.reviewRange, `${baseCommit}...${headCommit}`);
  assert.equal(context.comparison.commitRange, `${baseCommit}..${headCommit}`);
  assert.equal(git(["cat-file", "-t", context.comparison.reviewRange.split("...")[0]]), "commit");
  assert.equal(git(["diff", "--name-only", context.comparison.reviewRange]), "app.js");
});

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

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
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
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
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
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
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
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});
