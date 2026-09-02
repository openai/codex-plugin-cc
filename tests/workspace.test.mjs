import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";

function makeNestedWorkspace(gitMarker) {
  const workspace = makeTempDir();
  const nested = path.join(workspace, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  if (gitMarker === "directory") {
    fs.mkdirSync(path.join(workspace, ".git"));
  } else {
    const gitDirectory = path.join(workspace, "metadata.git");
    fs.mkdirSync(gitDirectory);
    fs.writeFileSync(path.join(workspace, ".git"), "gitdir: metadata.git\n", "utf8");
  }
  return { workspace: fs.realpathSync.native(workspace), nested };
}

test("resolveWorkspaceRoot honors an environment-configured work tree without a .git marker", () => {
  const worktree = makeTempDir();
  const gitDirectory = makeTempDir();
  const nested = path.join(worktree, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(
    resolveWorkspaceRoot(nested, { GIT_DIR: gitDirectory, GIT_WORK_TREE: "../.." }),
    fs.realpathSync.native(worktree)
  );
});

test("resolveWorkspaceRoot honors GIT_WORK_TREE alone after finding the current repository", () => {
  const outer = makeNestedWorkspace("directory");
  const configuredWorktree = makeTempDir();
  assert.equal(
    resolveWorkspaceRoot(outer.nested, { GIT_WORK_TREE: configuredWorktree }),
    fs.realpathSync.native(configuredWorktree)
  );
});

test("resolveWorkspaceRoot ignores an environment work tree with a missing GIT_DIR", () => {
  const outer = makeNestedWorkspace("directory");
  assert.equal(
    resolveWorkspaceRoot(outer.nested, { GIT_DIR: "missing.git", GIT_WORK_TREE: "../.." }),
    outer.workspace
  );
});

test("resolveWorkspaceRoot uses invocation directory for GIT_DIR alone", () => {
  const outer = makeNestedWorkspace("directory");
  const gitDirectory = makeTempDir();
  assert.equal(resolveWorkspaceRoot(outer.nested, { GIT_DIR: gitDirectory }), fs.realpathSync.native(outer.nested));
});

test("resolveWorkspaceRoot honors core.worktree from GIT_DIR config", () => {
  const cwd = makeTempDir();
  const gitDirectory = makeTempDir();
  const worktree = makeTempDir();
  fs.writeFileSync(path.join(gitDirectory, "config"), `[core]\n  worktree = ${worktree}\n`, "utf8");
  assert.equal(resolveWorkspaceRoot(cwd, { GIT_DIR: gitDirectory }), fs.realpathSync.native(worktree));
});

test("resolveWorkspaceRoot strips inline comments outside quoted core.worktree values", () => {
  const root = makeTempDir();
  const cwd = path.join(root, "metadata", "nested");
  const gitDirectory = path.join(root, "metadata", ".git");
  const worktree = path.join(root, "work tree");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(gitDirectory);
  fs.mkdirSync(worktree);
  fs.writeFileSync(
    path.join(gitDirectory, "config"),
    `[core]\n  worktree = "../../work tree" # external tree\n`,
    "utf8"
  );
  assert.equal(resolveWorkspaceRoot(cwd, { GIT_DIR: gitDirectory }), fs.realpathSync.native(worktree));
});

test("resolveWorkspaceRoot preserves comment characters inside quoted core.worktree values", () => {
  const root = makeTempDir();
  const cwd = path.join(root, "metadata");
  const gitDirectory = path.join(cwd, ".git");
  const worktree = path.join(root, "work#tree");
  fs.mkdirSync(gitDirectory, { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(gitDirectory, "config"), `[core]\n  worktree = "../../work#tree"\n`, "utf8");
  assert.equal(resolveWorkspaceRoot(cwd, { GIT_DIR: gitDirectory }), fs.realpathSync.native(worktree));
});

test("resolveWorkspaceRoot uses the final core.worktree value", () => {
  const root = makeTempDir();
  const cwd = path.join(root, "metadata");
  const gitDirectory = path.join(cwd, ".git");
  const staleWorktree = path.join(root, "stale");
  const finalWorktree = path.join(root, "final");
  fs.mkdirSync(gitDirectory, { recursive: true });
  fs.mkdirSync(staleWorktree);
  fs.mkdirSync(finalWorktree);
  fs.writeFileSync(
    path.join(gitDirectory, "config"),
    `[core]\n  worktree = ${staleWorktree}\n  worktree = ${finalWorktree}\n`,
    "utf8"
  );
  assert.equal(resolveWorkspaceRoot(cwd, { GIT_DIR: gitDirectory }), fs.realpathSync.native(finalWorktree));
});

for (const comment of ["# core options", "; core options"]) {
  test(`resolveWorkspaceRoot accepts a comment after the core section header: ${comment}`, () => {
    const root = makeTempDir();
    const cwd = path.join(root, "metadata");
    const gitDirectory = path.join(cwd, ".git");
    const worktree = path.join(root, "external");
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[user]\n  name = Example\n[core] ${comment}\n  worktree = ${worktree}\n`,
      "utf8"
    );
    assert.equal(resolveWorkspaceRoot(cwd, { GIT_DIR: gitDirectory }), fs.realpathSync.native(worktree));
  });
}

test("resolveWorkspaceRoot honors core.worktree from a marker git directory", () => {
  const metadata = makeTempDir();
  const gitDirectory = path.join(metadata, ".git");
  const nested = path.join(metadata, "sub");
  const worktree = makeTempDir();
  fs.mkdirSync(gitDirectory);
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(gitDirectory, "config"), `[core]\n  worktree = ${worktree}\n`, "utf8");
  assert.equal(resolveWorkspaceRoot(nested, {}), fs.realpathSync.native(worktree));
});

test("resolveWorkspaceRoot follows a gitfile supplied through GIT_DIR", () => {
  const cwd = makeTempDir();
  const metadata = makeTempDir();
  const gitDirectory = path.join(metadata, "actual.git");
  const gitfile = path.join(metadata, "linked.git");
  const worktree = makeTempDir();
  fs.mkdirSync(gitDirectory);
  fs.writeFileSync(gitfile, "gitdir: actual.git\n", "utf8");

  assert.equal(
    resolveWorkspaceRoot(cwd, { GIT_DIR: gitfile, GIT_WORK_TREE: worktree }),
    fs.realpathSync.native(worktree)
  );
});

test("resolveWorkspaceRoot ignores GIT_WORK_TREE alone outside a repository", () => {
  const cwd = makeTempDir();
  const configuredWorktree = makeTempDir();
  assert.equal(resolveWorkspaceRoot(cwd, { GIT_WORK_TREE: configuredWorktree }), cwd);
});

test("resolveWorkspaceRoot discovers a checkout without starting a child process", () => {
  const { workspace, nested } = makeNestedWorkspace("directory");
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = () => {
    throw new Error("workspace resolution must not start a child process");
  };
  syncBuiltinESMExports();

  try {
    assert.equal(resolveWorkspaceRoot(nested), workspace);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});

test("resolveWorkspaceRoot accepts a linked-worktree gitfile", () => {
  const { workspace, nested } = makeNestedWorkspace("file");

  assert.equal(resolveWorkspaceRoot(nested), workspace);
});

test("resolveWorkspaceRoot ignores an ordinary file named .git", () => {
  const outer = makeNestedWorkspace("directory");
  const nestedWorkspace = path.join(outer.workspace, "vendor", "not-a-repo");
  const cwd = path.join(nestedWorkspace, "src");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(nestedWorkspace, ".git"), "not a gitfile\n", "utf8");

  assert.equal(resolveWorkspaceRoot(cwd), outer.workspace);
});

for (const invalidMarker of ["gitdir:/tmp/metadata\n", "gitdir:\t/tmp/metadata\n", "metadata\ngitdir: /tmp/metadata\n", "gitdir: missing.git\n", "gitdir: metadata.git\ntrailing-data"]) {
  test(`resolveWorkspaceRoot rejects malformed gitfile ${JSON.stringify(invalidMarker)}`, () => {
    const outer = makeNestedWorkspace("directory");
    const nestedWorkspace = path.join(outer.workspace, "vendor", "not-a-repo");
    const cwd = path.join(nestedWorkspace, "src");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(nestedWorkspace, ".git"), invalidMarker, "utf8");

    assert.equal(resolveWorkspaceRoot(cwd), outer.workspace);
  });
}

test("resolveWorkspaceRoot follows a symlinked git directory", () => {
  const workspace = makeTempDir();
  const gitDirectory = makeTempDir();
  const nested = path.join(workspace, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync(gitDirectory, path.join(workspace, ".git"), process.platform === "win32" ? "junction" : "dir");

  assert.equal(resolveWorkspaceRoot(nested), fs.realpathSync.native(workspace));
});

test("resolveWorkspaceRoot selects the nearest nested working tree", () => {
  const { workspace } = makeNestedWorkspace("directory");
  const nestedWorkspace = path.join(workspace, "vendor", "nested");
  const cwd = path.join(nestedWorkspace, "src");
  fs.mkdirSync(path.join(nestedWorkspace, ".git"), { recursive: true });
  fs.mkdirSync(cwd);

  assert.equal(resolveWorkspaceRoot(cwd), fs.realpathSync.native(nestedWorkspace));
});

test("resolveWorkspaceRoot starts at a file cwd's parent", () => {
  const { workspace, nested } = makeNestedWorkspace("directory");
  const file = path.join(nested, "index.js");
  fs.writeFileSync(file, "export {};\n", "utf8");

  assert.equal(resolveWorkspaceRoot(file), workspace);
});

test("workspace aliases resolve to the same canonical root and state identity", (t) => {
  const { workspace } = makeNestedWorkspace("directory");
  const nested = path.join(workspace, "packages", "app");
  const alias = `${workspace}-alias`;
  try {
    fs.symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      t.skip(`junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const aliasedNested = path.join(alias, "packages", "app");

  assert.equal(resolveWorkspaceRoot(aliasedNested), workspace);
  assert.equal(resolveWorkspaceRoot(aliasedNested), resolveWorkspaceRoot(nested));
  assert.equal(resolveStateDir(aliasedNested), resolveStateDir(nested));
});

test("resolveWorkspaceRoot preserves a non-repository cwd", () => {
  const cwd = makeTempDir();

  assert.equal(resolveWorkspaceRoot(cwd), cwd);
});

test("resolveWorkspaceRoot preserves an inaccessible or missing cwd", () => {
  const cwd = path.join(makeTempDir(), "missing", "directory");

  assert.equal(resolveWorkspaceRoot(cwd), cwd);
});
