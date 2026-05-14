import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  getReviewSubagentTargets,
  materializeReviewSubagents,
  removeReviewSubagents,
  REVIEW_SUBAGENT_PROVENANCE_MARKER
} from "../plugins/codex/scripts/lib/review-subagents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

function snapshotFiles(filePaths) {
  return new Map(
    filePaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null
    ])
  );
}

function restoreFiles(snapshot) {
  for (const [filePath, content] of snapshot) {
    if (content == null) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function createSymlinkOrSkip(t, targetPath, linkPath) {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOTSUP") {
      t.skip("symlinks are not available in this environment");
      return false;
    }
    throw error;
  }
}

function withPatchedFs(method, replacement, callback) {
  const original = fs[method];
  fs[method] = replacement(original);
  try {
    return callback();
  } finally {
    fs[method] = original;
  }
}

function swapAgentsDirectory(pluginRoot) {
  const agentsDir = path.join(pluginRoot, "agents");
  const swappedDir = path.join(pluginRoot, `agents-swapped-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.renameSync(agentsDir, swappedDir);
  fs.mkdirSync(agentsDir);
  return swappedDir;
}

test("materializeReviewSubagents writes templates and removeReviewSubagents only removes review agents", () => {
  const pluginRoot = makeTempDir();
  const rescueAgent = path.join(pluginRoot, "agents", "codex-rescue.md");

  fs.mkdirSync(path.dirname(rescueAgent), { recursive: true });
  fs.writeFileSync(rescueAgent, "rescue\n", "utf8");

  const materialized = materializeReviewSubagents(pluginRoot);
  assert.deepEqual(
    materialized.map((target) => path.basename(target.targetPath)).sort(),
    ["codex-adversarial-review.md", "codex-review.md"]
  );

  for (const target of materialized) {
    assert.equal(fs.existsSync(target.targetPath), true);
    assert.equal(fs.readFileSync(target.targetPath, "utf8"), fs.readFileSync(target.templatePath, "utf8"));
    assert.match(fs.readFileSync(target.targetPath, "utf8").slice(0, 256), new RegExp(REVIEW_SUBAGENT_PROVENANCE_MARKER));
  }

  removeReviewSubagents(pluginRoot);

  for (const target of getReviewSubagentTargets(pluginRoot)) {
    assert.equal(fs.existsSync(target.targetPath), false);
  }
  assert.equal(fs.readFileSync(rescueAgent, "utf8"), "rescue\n");
});

test("materializeReviewSubagents refuses a symlink target", (t) => {
  const pluginRoot = makeTempDir();
  const [target] = getReviewSubagentTargets(pluginRoot);
  const victim = path.join(pluginRoot, "victim.md");

  fs.mkdirSync(path.dirname(target.targetPath), { recursive: true });
  fs.writeFileSync(victim, "victim\n", "utf8");
  if (!createSymlinkOrSkip(t, victim, target.targetPath)) {
    return;
  }

  assert.throws(() => materializeReviewSubagents(pluginRoot), /path is a symbolic link/);
  assert.equal(fs.readFileSync(victim, "utf8"), "victim\n");
  assert.equal(fs.lstatSync(target.targetPath).isSymbolicLink(), true);
});

test("removeReviewSubagents refuses a symlink target", (t) => {
  const pluginRoot = makeTempDir();
  const [target] = getReviewSubagentTargets(pluginRoot);
  const victim = path.join(pluginRoot, "victim.md");

  fs.mkdirSync(path.dirname(target.targetPath), { recursive: true });
  fs.writeFileSync(victim, "victim\n", "utf8");
  if (!createSymlinkOrSkip(t, victim, target.targetPath)) {
    return;
  }

  assert.throws(() => removeReviewSubagents(pluginRoot), /path is a symbolic link/);
  assert.equal(fs.readFileSync(victim, "utf8"), "victim\n");
  assert.equal(fs.lstatSync(target.targetPath).isSymbolicLink(), true);
});

test("review subagent materialize and remove refuse non-marker files", () => {
  const pluginRoot = makeTempDir();
  const targets = getReviewSubagentTargets(pluginRoot);
  const customTarget = targets[0].targetPath;

  fs.mkdirSync(path.dirname(customTarget), { recursive: true });
  fs.writeFileSync(customTarget, "custom review agent\n", "utf8");

  assert.throws(() => materializeReviewSubagents(pluginRoot), /not a Codex-managed review subagent/);
  assert.equal(fs.readFileSync(customTarget, "utf8"), "custom review agent\n");
  assert.equal(fs.existsSync(targets[1].targetPath), false);

  assert.throws(() => removeReviewSubagents(pluginRoot), /not a Codex-managed review subagent/);
  assert.equal(fs.readFileSync(customTarget, "utf8"), "custom review agent\n");
});

test("materialized review subagents surface failed Bash invocations", () => {
  const pluginRoot = makeTempDir();
  materializeReviewSubagents(pluginRoot);

  for (const target of getReviewSubagentTargets(pluginRoot)) {
    const source = fs.readFileSync(target.targetPath, "utf8");

    assert.match(source, /Use exactly one `Bash` call/);
    assert.match(source, /--invoker claude-subagent/);
    assert.match(source, /Return stdout .* verbatim, exactly as-is, with no commentary\./);
    assert.match(source, /Bash call exits nonzero or Codex cannot be invoked/);
    assert.match(source, /failure surface instead of an empty response/);
    assert.match(source, /codex-companion review subagent: command failed \(exit <N>\)/);
    assert.match(source, /return stderr and stdout .* verbatim, exactly as emitted/i);
    assert.match(source, /no paraphrasing, summarization, or extra commentary/i);
    assert.match(source, /Do not inspect files/);
    assert.doesNotMatch(source, /return nothing/i);
  }
});

test("materializeReviewSubagents refuses a symlinked agents directory", (t) => {
  const pluginRoot = makeTempDir();
  const actualAgents = path.join(pluginRoot, "actual-agents");
  const agentsLink = path.join(pluginRoot, "agents");

  fs.mkdirSync(actualAgents, { recursive: true });
  if (!createSymlinkOrSkip(t, actualAgents, agentsLink)) {
    return;
  }

  assert.throws(() => materializeReviewSubagents(pluginRoot), /agents directory is a symbolic link/);
  assert.deepEqual(fs.readdirSync(actualAgents), []);
});

test("removeReviewSubagents refuses a symlinked agents directory", (t) => {
  const pluginRoot = makeTempDir();
  const actualAgents = path.join(pluginRoot, "actual-agents");
  const agentsLink = path.join(pluginRoot, "agents");

  fs.mkdirSync(actualAgents, { recursive: true });
  fs.writeFileSync(path.join(actualAgents, "codex-review.md"), `${REVIEW_SUBAGENT_PROVENANCE_MARKER}\n`, "utf8");
  if (!createSymlinkOrSkip(t, actualAgents, agentsLink)) {
    return;
  }

  assert.throws(() => removeReviewSubagents(pluginRoot), /agents directory is a symbolic link/);
  assert.equal(fs.existsSync(path.join(actualAgents, "codex-review.md")), true);
});

test("materializeReviewSubagents refuses agents resolving outside the plugin root", (t) => {
  const pluginRoot = makeTempDir();
  const outsideAgents = makeTempDir();
  const agentsLink = path.join(pluginRoot, "agents");

  if (!createSymlinkOrSkip(t, outsideAgents, agentsLink)) {
    return;
  }

  assert.throws(() => materializeReviewSubagents(pluginRoot), /agents directory resolves outside the plugin root/);
  assert.deepEqual(fs.readdirSync(outsideAgents), []);
});

test("materializeReviewSubagents detects agents directory identity changes before rename", () => {
  const pluginRoot = makeTempDir();
  const agentsDir = path.join(pluginRoot, "agents");
  let agentsDirChecks = 0;
  let swappedDir = null;

  fs.mkdirSync(agentsDir, { recursive: true });

  withPatchedFs(
    "lstatSync",
    (original) =>
      function patchedLstatSync(filePath, ...args) {
        if (path.resolve(String(filePath)) === agentsDir) {
          agentsDirChecks += 1;
          if (agentsDirChecks === 3 && !swappedDir) {
            swappedDir = swapAgentsDirectory(pluginRoot);
          }
        }
        return original.call(fs, filePath, ...args);
      },
    () => {
      assert.throws(
        () => materializeReviewSubagents(pluginRoot),
        /Refusing to overwrite .*agents directory identity changed during materialization/
      );
    }
  );

  assert.ok(swappedDir);
  assert.equal(fs.existsSync(path.join(agentsDir, "codex-review.md")), false);
  assert.equal(fs.existsSync(path.join(swappedDir, "codex-review.md")), false);
});

test("removeReviewSubagents detects agents directory identity changes before unlink", () => {
  const pluginRoot = makeTempDir();
  const agentsDir = path.join(pluginRoot, "agents");
  let agentsDirChecks = 0;
  let swappedDir = null;

  materializeReviewSubagents(pluginRoot);

  withPatchedFs(
    "lstatSync",
    (original) =>
      function patchedLstatSync(filePath, ...args) {
        if (path.resolve(String(filePath)) === agentsDir) {
          agentsDirChecks += 1;
          if (agentsDirChecks === 2 && !swappedDir) {
            swappedDir = swapAgentsDirectory(pluginRoot);
          }
        }
        return original.call(fs, filePath, ...args);
      },
    () => {
      assert.throws(
        () => removeReviewSubagents(pluginRoot),
        /Refusing to remove .*agents directory identity changed during materialization/
      );
    }
  );

  assert.ok(swappedDir);
  assert.equal(fs.existsSync(path.join(agentsDir, "codex-review.md")), false);
  assert.equal(fs.existsSync(path.join(swappedDir, "codex-review.md")), true);
});

test("setup review-subagent flags materialize files and persist config", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const targets = getReviewSubagentTargets();
  const snapshot = snapshotFiles(targets.map((target) => target.targetPath));
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData
  };

  try {
    const enable = run(process.execPath, [SCRIPT, "setup", "--enable-review-subagents", "--json"], {
      cwd: workspace,
      env
    });
    assert.equal(enable.status, 0, enable.stderr);
    assert.equal(JSON.parse(enable.stdout).reviewSubagentsEnabled, true);

    for (const target of targets) {
      assert.equal(fs.existsSync(target.targetPath), true);
    }
    assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents", "codex-rescue.md")), true);

    const persistedEnabled = run(process.execPath, [SCRIPT, "setup", "--json"], {
      cwd: workspace,
      env
    });
    assert.equal(persistedEnabled.status, 0, persistedEnabled.stderr);
    assert.equal(JSON.parse(persistedEnabled.stdout).reviewSubagentsEnabled, true);

    const disable = run(process.execPath, [SCRIPT, "setup", "--disable-review-subagents", "--json"], {
      cwd: workspace,
      env
    });
    assert.equal(disable.status, 0, disable.stderr);
    assert.equal(JSON.parse(disable.stdout).reviewSubagentsEnabled, false);

    for (const target of targets) {
      assert.equal(fs.existsSync(target.targetPath), false);
    }
    assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents", "codex-rescue.md")), true);

    const persistedDisabled = run(process.execPath, [SCRIPT, "setup", "--json"], {
      cwd: workspace,
      env
    });
    assert.equal(persistedDisabled.status, 0, persistedDisabled.stderr);
    assert.equal(JSON.parse(persistedDisabled.stdout).reviewSubagentsEnabled, false);
  } finally {
    restoreFiles(snapshot);
  }
});

test("multi-workspace: setup --json reflects filesystem state across workspaces", () => {
  const workspaceA = makeTempDir();
  const workspaceB = makeTempDir();
  const pluginData = makeTempDir();
  const targets = getReviewSubagentTargets();
  const snapshot = snapshotFiles(targets.map((target) => target.targetPath));
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData
  };

  try {
    const enableFromA = run(process.execPath, [SCRIPT, "setup", "--enable-review-subagents", "--json"], {
      cwd: workspaceA,
      env
    });
    assert.equal(enableFromA.status, 0, enableFromA.stderr);
    assert.equal(JSON.parse(enableFromA.stdout).reviewSubagentsEnabled, true);

    const reportFromBEnabled = run(process.execPath, [SCRIPT, "setup", "--json"], {
      cwd: workspaceB,
      env
    });
    assert.equal(reportFromBEnabled.status, 0, reportFromBEnabled.stderr);
    assert.equal(JSON.parse(reportFromBEnabled.stdout).reviewSubagentsEnabled, true);

    const disableFromA = run(process.execPath, [SCRIPT, "setup", "--disable-review-subagents", "--json"], {
      cwd: workspaceA,
      env
    });
    assert.equal(disableFromA.status, 0, disableFromA.stderr);
    assert.equal(JSON.parse(disableFromA.stdout).reviewSubagentsEnabled, false);

    const reportFromBDisabled = run(process.execPath, [SCRIPT, "setup", "--json"], {
      cwd: workspaceB,
      env
    });
    assert.equal(reportFromBDisabled.status, 0, reportFromBDisabled.stderr);
    assert.equal(JSON.parse(reportFromBDisabled.stdout).reviewSubagentsEnabled, false);
  } finally {
    restoreFiles(snapshot);
  }
});

test("setup review-subagent flags are mutually exclusive", () => {
  const result = run(process.execPath, [
    SCRIPT,
    "setup",
    "--enable-review-subagents",
    "--disable-review-subagents"
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --enable-review-subagents or --disable-review-subagents\./);
});
