import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { collectTestCommandContext } from "../plugins/codex/scripts/lib/test-context.mjs";
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

test("collectTestCommandContext ignores symlinked test directories outside the repo", () => {
  const cwd = makeTempDir();
  const externalTests = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "README.md"), "# Sample project\n");
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 1;\n");
  fs.mkdirSync(path.join(externalTests, "nested"));
  fs.writeFileSync(path.join(externalTests, "nested", "app.test.mjs"), "import test from 'node:test';\n");
  fs.symlinkSync(externalTests, path.join(cwd, "tests"));
  run("git", ["add", "README.md", "src/app.js", "tests"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 2;\n");

  assert.throws(() => collectTestCommandContext(cwd), /No test layout detected/i);
});

test("collectTestCommandContext ignores nested worktree directories inside the workspace", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 1;\n");

  const nestedWorktreeDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedWorktreeDir, { recursive: true });
  initGitRepo(nestedWorktreeDir);
  fs.mkdirSync(path.join(nestedWorktreeDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(nestedWorktreeDir, "tests", "app.test.js"), "test('nested', () => {});\n");

  run("git", ["add", "README.md", "src/app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 2;\n");

  assert.throws(() => collectTestCommandContext(cwd), /No test layout detected/i);
});

test("collectTestCommandContext ignores root-level nested checkouts inside the workspace", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 1;\n");

  const nestedRepoDir = path.join(cwd, "nestedrepo");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);
  fs.mkdirSync(path.join(nestedRepoDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(nestedRepoDir, "tests", "app.test.js"), "test('nested', () => {});\n");

  run("git", ["add", "README.md", "src/app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 2;\n");

  assert.throws(() => collectTestCommandContext(cwd), /No test layout detected/i);
});

test("collectTestCommandContext ignores symlinked guidance files outside the repo", () => {
  const cwd = makeTempDir();
  const externalDir = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tests"));
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "tests", "app.test.mjs"), "import test from 'node:test';\n");
  fs.writeFileSync(path.join(externalDir, "README.md"), "# external guidance\n");
  fs.symlinkSync(path.join(externalDir, "README.md"), path.join(cwd, "README.md"));
  run("git", ["add", "README.md", "src/app.js", "tests/app.test.mjs"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 2;\n");

  assert.throws(
    () => collectTestCommandContext(cwd),
    /No project guidance found: expected at least one of CLAUDE\.md, AGENTS\.md, README\.md\./i
  );
});

test("collectTestCommandContext matches javascript test stems by boundary", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tests"));
  fs.writeFileSync(path.join(cwd, "README.md"), "# Sample project\n");
  fs.writeFileSync(path.join(cwd, "src", "id.js"), "export const id = 1;\n");
  fs.writeFileSync(path.join(cwd, "tests", "userid.test.js"), "test('userid', () => {});\n");
  run("git", ["add", "README.md", "src/id.js", "tests/userid.test.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "id.js"), "export const id = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "src/id.js",
      targets: [{ path: "tests/id.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext creates JS tests under the nearest package-local test root", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "packages", "a", "tests"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# monorepo\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "tests", "shared.test.js"), "test('a', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "tests", "existing.test.js"), "test('b', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "src", "new.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "packages", "b", "src", "new.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "packages/b/src/new.js",
      targets: [{ path: "packages/b/tests/new.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext scopes direct JS test matches to the nearest package", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "packages", "a", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "a", "tests"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# monorepo\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "src", "id.js"), "export const id = 'a';\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "tests", "id.test.js"), "test('a', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "src", "id.js"), "export const id = 'b';\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "tests", "id.test.js"), "test('b', () => {});\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "packages", "b", "src", "id.js"), "export const id = 'b2';\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "packages/b/src/id.js",
      targets: [{ path: "packages/b/tests/id.test.js", action: "update" }]
    }
  ]);
});

test("collectTestCommandContext skips deleted source files when inferring targets", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tests"));
  fs.writeFileSync(path.join(cwd, "README.md"), "# Sample project\n");
  fs.writeFileSync(path.join(cwd, "src", "old.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "tests", "old.test.js"), "test('old', () => {});\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.rmSync(path.join(cwd, "src", "old.js"));

  assert.throws(() => collectTestCommandContext(cwd), /Unable to infer test targets from changed files/i);
});

test("collectTestCommandContext preserves source subdirectories for new Python tests", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# python project\n");
  fs.writeFileSync(path.join(cwd, "tests", "pkg", "test_existing.py"), "def test_existing():\n    assert True\n");
  fs.writeFileSync(path.join(cwd, "src", "pkg", "foo.py"), "VALUE = 1\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "pkg", "foo.py"), "VALUE = 2\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "src/pkg/foo.py",
      targets: [{ path: "tests/pkg/test_foo.py", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext caps guidance files in large monorepos", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "tests"));
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# root agents\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# root readme\n");
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "tests", "app.test.js"), "test('app', () => {});\n");
  for (let index = 0; index < 10; index += 1) {
    const packageDir = path.join(cwd, "packages", `pkg-${index}`);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "README.md"), `# package ${index}\n${"docs\n".repeat(1024)}`);
  }
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.ok(context.guidanceFiles.length < 12);
  assert.deepEqual(
    context.guidanceFiles.slice(0, 2).map((file) => file.path),
    ["AGENTS.md", "README.md"]
  );
  assert.ok(!context.guidanceFiles.some((file) => file.path === "packages/pkg-9/README.md"));
});

test("collectTestCommandContext fails closed when no package-local test root matches the source", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "tools"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "a", "tests"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# monorepo\n");
  fs.writeFileSync(path.join(cwd, "tools", "gen.js"), "export const generate = () => 1;\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "tests", "a.test.js"), "test('a', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "tests", "b.test.js"), "test('b', () => {});\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "tools", "gen.js"), "export const generate = () => 2;\n");

  assert.throws(() => collectTestCommandContext(cwd), /Unable to infer test targets from changed files/i);
});

test("collectTestCommandContext fails closed when direct test matches only exist outside the source scope", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "tools"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "a", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# monorepo\n");
  fs.writeFileSync(path.join(cwd, "tools", "gen.js"), "export const generate = () => 1;\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "tests", "gen.test.js"), "test('a', () => {});\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "tools", "gen.js"), "export const generate = () => 2;\n");

  assert.throws(() => collectTestCommandContext(cwd), /Unable to infer test targets from changed files/i);
});

test("collectTestCommandContext infers JS test extensions from the selected package root", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "packages", "a", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "a", "tests"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "b", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# mixed conventions\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "tests", "alpha.test.ts"), "test('alpha', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "a", "tests", "beta.test.ts"), "test('beta', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "tests", "existing.test.js"), "test('existing', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "src", "new.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "packages", "b", "src", "new.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "packages/b/src/new.js",
      targets: [{ path: "packages/b/tests/new.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext builds JS test paths relative to the selected test root", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "packages", "b", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# package layout without src\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "tests", "existing.test.js"), "test('existing', () => {});\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "new.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "packages", "b", "new.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "packages/b/new.js",
      targets: [{ path: "packages/b/tests/new.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext builds Python test paths relative to the selected test root", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "packages", "b", "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# python package layout without src\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "tests", "test_existing.py"), "def test_existing():\n    assert True\n");
  fs.writeFileSync(path.join(cwd, "packages", "b", "foo.py"), "VALUE = 1\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "packages", "b", "foo.py"), "VALUE = 2\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "packages/b/foo.py",
      targets: [{ path: "packages/b/tests/test_foo.py", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext accepts repo-wide spec directories as test roots", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "spec"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# spec layout\n");
  fs.writeFileSync(path.join(cwd, "spec", "existing.test.js"), "test('existing', () => {});\n");
  fs.writeFileSync(path.join(cwd, "src", "foo.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "foo.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "src/foo.js",
      targets: [{ path: "spec/foo.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext accepts repo-root test files as a valid layout", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# root tests\n");
  fs.writeFileSync(path.join(cwd, "foo.test.js"), "test('foo', () => {});\n");
  fs.writeFileSync(path.join(cwd, "src", "bar.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "bar.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "src/bar.js",
      targets: [{ path: "bar.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext prefers explicit test directories over repo-root test files on ties", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# mixed root layout\n");
  fs.writeFileSync(path.join(cwd, "foo.test.js"), "test('foo', () => {});\n");
  fs.writeFileSync(path.join(cwd, "tests", "existing.test.js"), "test('existing', () => {});\n");
  fs.writeFileSync(path.join(cwd, "src", "new.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "new.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "src/new.js",
      targets: [{ path: "tests/new.test.js", action: "create" }]
    }
  ]);
});

test("collectTestCommandContext ignores support files inside test directories when matching test targets", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# support files in tests\n");
  fs.writeFileSync(path.join(cwd, "tests", "config.js"), "export const shared = true;\n");
  fs.writeFileSync(path.join(cwd, "tests", "existing.test.js"), "test('existing', () => {});\n");
  fs.writeFileSync(path.join(cwd, "src", "config.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "config.js"), "export const value = 2;\n");

  const context = collectTestCommandContext(cwd);

  assert.deepEqual(context.testPlanEntries, [
    {
      sourcePath: "src/config.js",
      targets: [{ path: "tests/config.test.js", action: "create" }]
    }
  ]);
});
