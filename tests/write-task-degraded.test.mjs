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
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function readLatestJob(workspace) {
  const stateDir = resolveStateDir(workspace);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const jobFile = path.join(stateDir, "jobs", `${state.jobs[0].id}.json`);
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

test("write task that lands zero workspace writes finishes failed with a zero-write notice", () => {
  const repo = setupRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--write", "please implement the fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "zero-write write task should exit non-zero");
  assert.match(result.stdout, /zero workspace writes/i);
  const job = readLatestJob(repo);
  assert.equal(job.status, "failed");
  assert.equal(job.result.degraded, "zero-writes");
});

test("write task with apply_patch file changes stays completed", () => {
  const repo = setupRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-write-file-change");

  const result = run("node", [SCRIPT, "task", "--write", "please implement the fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const job = readLatestJob(repo);
  assert.equal(job.status, "completed");
  assert.equal(job.result.degraded ?? null, null);
});

test("write task with shell-only writes stays completed", () => {
  const repo = setupRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-shell-write");

  const result = run("node", [SCRIPT, "task", "--write", "please implement the fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(repo, "shell-write.txt")), "fixture should have written into the workspace");
  const job = readLatestJob(repo);
  assert.equal(job.status, "completed");
  assert.equal(job.result.degraded ?? null, null);
});

test("write task that only modifies an already-dirty tracked file stays completed", () => {
  const repo = setupRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "dirty before task\n");
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-shell-write-existing");

  const result = run("node", [SCRIPT, "task", "--write", "please implement the fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const job = readLatestJob(repo);
  assert.equal(job.status, "completed");
  assert.equal(job.result.degraded ?? null, null);
});

test("read-only task with zero writes stays completed", () => {
  const repo = setupRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "summarize the repo"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const job = readLatestJob(repo);
  assert.equal(job.status, "completed");
  assert.equal(job.result.degraded ?? null, null);
});

test("write task in a non-git workspace skips zero-write detection", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--write", "please implement the fix"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const job = readLatestJob(workspace);
  assert.equal(job.status, "completed");
  assert.equal(job.result.degraded ?? null, null);
});
