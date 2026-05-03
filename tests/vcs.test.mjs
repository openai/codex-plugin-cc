import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { detectVcs, ensureGitRepository } from "../plugins/codex/scripts/lib/vcs.mjs";
import { binaryAvailable } from "../plugins/codex/scripts/lib/process.mjs";
import { initJjRepo, makeMockJjDir, makeTempDir } from "./helpers.mjs";

test("detectVcs returns jj when .jj directory is present", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".jj"), { recursive: true });
  assert.equal(detectVcs(cwd), "jj");
});

test("detectVcs returns git when only .git directory is present", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  assert.equal(detectVcs(cwd), "git");
});

test("detectVcs prefers jj in colocated repos", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".jj"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  assert.equal(detectVcs(cwd), "jj");
});

test("detectVcs walks up parent directories to find .jj", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".jj"), { recursive: true });
  const nested = path.join(cwd, "src", "components");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(detectVcs(nested), "jj");
});

test("detectVcs walks up parent directories to find .git", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  const nested = path.join(cwd, "src", "components");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(detectVcs(nested), "git");
});

test("detectVcs throws when neither .jj nor .git found", () => {
  const cwd = makeTempDir();
  assert.throws(() => detectVcs(cwd), /Git or Jujutsu repository/);
});

test("detectVcs prefers closer .git over ancestor .jj (nested Git inside JJ)", () => {
  const outer = makeTempDir();
  fs.mkdirSync(path.join(outer, ".jj"), { recursive: true });
  const inner = path.join(outer, "nested-git-repo");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  assert.equal(detectVcs(inner), "git");
});

test("detectVcs prefers closer .jj over ancestor .git (nested JJ inside Git)", () => {
  const outer = makeTempDir();
  fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
  const inner = path.join(outer, "nested-jj-repo");
  fs.mkdirSync(path.join(inner, ".jj"), { recursive: true });
  assert.equal(detectVcs(inner), "jj");
});

test("detectVcs prefers closer .git from subdirectory of nested Git repo", () => {
  const outer = makeTempDir();
  fs.mkdirSync(path.join(outer, ".jj"), { recursive: true });
  const inner = path.join(outer, "nested-git-repo");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  const deep = path.join(inner, "src", "lib");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(detectVcs(deep), "git");
});

test("detectVcs caches result for same resolved path", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".jj"), { recursive: true });
  assert.equal(detectVcs(cwd), "jj");

  // Remove .jj — cached result should still return "jj"
  fs.rmSync(path.join(cwd, ".jj"), { recursive: true });
  assert.equal(detectVcs(cwd), "jj");
});

test("detectVcs resolves relative and absolute paths to same cache entry", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".jj"), { recursive: true });
  assert.equal(detectVcs(cwd), "jj");
  assert.equal(detectVcs(path.resolve(cwd)), "jj");
});

test("ensureGitRepository returns jj workspace root for jj repos", { skip: !binaryAvailable("jj").available && "jj binary not available" }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  const root = ensureGitRepository(cwd);
  assert.equal(root, fs.realpathSync(cwd));
});

test("ensureGitRepository resolves workspace root from subdirectory", { skip: !binaryAvailable("jj").available && "jj binary not available" }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  const sub = path.join(cwd, "src");
  fs.mkdirSync(sub, { recursive: true });
  const root = ensureGitRepository(sub);
  assert.equal(root, fs.realpathSync(cwd));
});

test("ensureGitRepository throws when jj binary is missing and .jj exists", { skip: binaryAvailable("jj").available && "jj binary is available — cannot test missing binary path" }, () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".jj"), { recursive: true });
  assert.throws(() => ensureGitRepository(cwd), /jj is not installed/);
});
