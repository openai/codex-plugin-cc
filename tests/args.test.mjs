import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";
import { makeTempDir, run, initGitRepo } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

test("parseArgs rejects unknown long options when configured", () => {
  const helped = parseArgs(["--help", "--cwd", "/tmp"], {
    booleanOptions: ["help"],
    valueOptions: ["cwd"],
    rejectUnknownOptions: true
  });
  assert.equal(helped.options.help, true);
  assert.equal(helped.options.cwd, "/tmp");
  assert.deepEqual(helped.positionals, []);

  assert.throws(
    () =>
      parseArgs(["--not-a-flag"], {
        booleanOptions: ["json"],
        rejectUnknownOptions: true
      }),
    /Unknown option: --not-a-flag/
  );
});

test("parseArgs keeps unknown options as positionals by default", () => {
  const { options, positionals } = parseArgs(["--not-a-flag", "hello"], {
    booleanOptions: ["json"]
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--not-a-flag", "hello"]);
});

test("task --help prints usage and does not dispatch a Codex thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");

  const result = run("node", [SCRIPT, "task", "--help", "--cwd", repo, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /codex-companion\.mjs task/);
  assert.equal(result.stderr.trim(), "");

  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  if (fs.existsSync(fakeStatePath)) {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal((state.threads ?? []).length, 0);
  }
});

test("task unknown --flag errors without dispatching a Codex thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");

  const result = run("node", [SCRIPT, "task", "--not-a-real-flag", "--cwd", repo], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option: --not-a-real-flag/);

  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  if (fs.existsSync(fakeStatePath)) {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal((state.threads ?? []).length, 0);
  }
});
