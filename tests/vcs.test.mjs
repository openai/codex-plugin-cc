import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildArcEnv, installFakeArc, readArcCalls } from "./fake-arc-fixture.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  mapArcPathToScope,
  parseArcStatus
} from "../plugins/codex/scripts/lib/vcs/arc.mjs";
import {
  collectReviewContext,
  estimateReview,
  requireReviewWorkspace,
  resolveReviewTarget,
  resolveWorkspaceContext
} from "../plugins/codex/scripts/lib/vcs/index.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

function withProcessEnv(env, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function arcStatusPath(scopeRoot, relativePath) {
  return `${path.basename(path.dirname(scopeRoot))}/${path.basename(scopeRoot)}/${relativePath}`.replaceAll("\\", "/");
}

test("automatic detection selects Arc before Git and an explicit override selects Git", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeArc(binDir);
  initGitRepo(workspace);
  const env = buildArcEnv(binDir);

  withProcessEnv({ PATH: env.PATH }, () => {
    assert.equal(resolveWorkspaceContext(workspace).vcsKind, "arc");
    assert.equal(resolveWorkspaceContext(workspace, { vcs: "git" }).vcsKind, "git");
  });
});

test("Arc status parsing preserves section membership for duplicate paths", () => {
  const parsed = parseArcStatus(JSON.stringify({
    staged: [{ status: "M", type: "file", path: "project/file with spaces.js" }],
    changed: [{ status: "M", type: "file", path: "project/file with spaces.js" }],
    untracked: [{ status: "?", type: "file", path: "project/new.js" }]
  }));

  assert.equal(parsed.staged.length, 1);
  assert.equal(parsed.changed.length, 1);
  assert.equal(parsed.staged[0].path, parsed.changed[0].path);
  assert.equal(parsed.staged[0].section, "staged");
  assert.equal(parsed.changed[0].section, "changed");
  assert.throws(
    () => parseArcStatus('{"staged":[],"changed":[]}'),
    /missing the untracked array/
  );
});

test("Arc repository-relative paths map only when containment can be proven", () => {
  const parent = makeTempDir();
  const scopeRoot = path.join(parent, "project");
  fs.mkdirSync(scopeRoot);
  const filePath = path.join(scopeRoot, "src", "file.js");
  fs.mkdirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, "export const safe = true;\n");
  const safeArcPath = `${path.basename(parent)}/project/src/file.js`;

  assert.equal(mapArcPathToScope(scopeRoot, safeArcPath), filePath);
  assert.equal(mapArcPathToScope(scopeRoot, "../outside.js"), null);
  assert.equal(mapArcPathToScope(scopeRoot, "another-project/file.js"), null);
});

test("Arc working-tree context uses scoped staged and unstaged commands", () => {
  const parent = makeTempDir();
  const workspace = path.join(parent, "project");
  const binDir = makeTempDir();
  const { logPath } = installFakeArc(binDir);
  fs.mkdirSync(workspace);
  const untrackedPath = path.join(workspace, "new file.js");
  fs.writeFileSync(untrackedPath, "export const untracked = true;\n");
  const duplicatePath = arcStatusPath(workspace, "src/app.js");
  const untrackedArcPath = arcStatusPath(workspace, "new file.js");
  const status = {
    staged: [{ status: "M", type: "file", path: duplicatePath }],
    changed: [{ status: "M", type: "file", path: duplicatePath }],
    untracked: [{ status: "?", type: "file", path: untrackedArcPath }]
  };
  const env = buildArcEnv(binDir, {
    FAKE_ARC_STATUS_JSON: JSON.stringify(status),
    FAKE_ARC_STAGED_DIFF: "diff --git a/src/app.js b/src/app.js\n+staged\n",
    FAKE_ARC_UNSTAGED_DIFF: "diff --git a/src/app.js b/src/app.js\n+changed\n"
  });

  withProcessEnv(env, () => {
    const context = requireReviewWorkspace(workspace);
    const target = resolveReviewTarget(context, {});
    const reviewContext = collectReviewContext(context, target);

    assert.equal(context.vcsKind, "arc");
    assert.equal(target.mode, "working-tree");
    assert.equal(reviewContext.fileCount, 2);
    assert.match(reviewContext.content, /\[staged\].*src\/app\.js/);
    assert.match(reviewContext.content, /\[changed\].*src\/app\.js/);
    assert.match(reviewContext.content, /export const untracked = true/);
  });

  const calls = readArcCalls(logPath);
  assert.equal(calls.some((call) => call.args[0] === "root"), false);
  assert.equal(
    calls.some((call) =>
      JSON.stringify(call.args) === JSON.stringify(["diff", "--cached", "--git", "--relative=."])
    ),
    true
  );
  assert.equal(
    calls.some((call) =>
      JSON.stringify(call.args) === JSON.stringify(["diff", "--git", "--relative=."])
    ),
    true
  );
  assert.equal(
    calls
      .filter((call) => call.args[0] === "diff")
      .every((call) => fs.realpathSync(call.cwd) === fs.realpathSync(workspace)),
    true
  );
});

test("Arc branch context uses only scoped diff -B forms", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const { logPath } = installFakeArc(binDir);
  const env = buildArcEnv(binDir, {
    FAKE_ARC_STATUS_JSON: JSON.stringify({ staged: [], changed: [], untracked: [] }),
    FAKE_ARC_NAME_ONLY: "src/app.js\n",
    FAKE_ARC_DIFF_STAT: " src/app.js | 1 +\n",
    FAKE_ARC_BRANCH_DIFF: "diff --git a/src/app.js b/src/app.js\n+branch\n"
  });

  withProcessEnv(env, () => {
    const context = requireReviewWorkspace(workspace);
    const target = resolveReviewTarget(context, {});
    const reviewContext = collectReviewContext(context, target);
    const estimate = estimateReview(context, target);

    assert.equal(target.mode, "branch");
    assert.equal(target.baseRef, "trunk");
    assert.equal(reviewContext.fileCount, 1);
    assert.equal(estimate.vcs, "arc");
    assert.equal(estimate.recommendedMode, "wait");
  });

  const argSets = readArcCalls(logPath).map((call) => call.args);
  for (const flag of ["--git", "--name-only", "--stat"]) {
    assert.equal(
      argSets.some((args) =>
        JSON.stringify(args) === JSON.stringify(["diff", "-B", flag, "--relative=.", "trunk", "HEAD"])
      ),
      true
    );
  }
  assert.equal(argSets.some((args) => args[0] === "merge-base" || args[0] === "log"), false);
  assert.equal(argSets.some((args) => args[0] === "root"), false);
});

test("Arc branch values with shell metacharacters are passed as one literal argument", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const { logPath } = installFakeArc(binDir);
  const suspiciousBase = "trunk;touch arc-should-not-run";
  const env = buildArcEnv(binDir, {
    FAKE_ARC_STATUS_JSON: JSON.stringify({ staged: [], changed: [], untracked: [] }),
    FAKE_ARC_NAME_ONLY: "src/app.js\n",
    FAKE_ARC_BRANCH_DIFF: "diff --git a/src/app.js b/src/app.js\n+branch\n"
  });

  withProcessEnv(env, () => {
    const context = requireReviewWorkspace(workspace);
    const target = resolveReviewTarget(context, { base: suspiciousBase });
    collectReviewContext(context, target);
  });

  const calls = readArcCalls(logPath);
  assert.equal(calls.some((call) => call.args.includes(suspiciousBase)), true);
  assert.equal(fs.existsSync(path.join(workspace, "arc-should-not-run")), false);
});

test("Arc untracked content is skipped when its path cannot be mapped inside the workspace", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeArc(binDir);
  const outsideSecret = path.join(path.dirname(workspace), "outside-secret.js");
  fs.writeFileSync(outsideSecret, "DO_NOT_READ_THIS_SECRET\n");
  const env = buildArcEnv(binDir, {
    FAKE_ARC_STATUS_JSON: JSON.stringify({
      staged: [],
      changed: [],
      untracked: [{ status: "?", type: "file", path: "unrelated/outside-secret.js" }]
    })
  });

  withProcessEnv(env, () => {
    const context = requireReviewWorkspace(workspace);
    const target = resolveReviewTarget(context, { scope: "working-tree" });
    const reviewContext = collectReviewContext(context, target);
    assert.match(reviewContext.content, /cannot be proven to resolve inside the opened workspace/);
    assert.doesNotMatch(reviewContext.content, /DO_NOT_READ_THIS_SECRET/);
  });
});

test("large Arc changes use scoped self-collection guidance", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeArc(binDir);
  const changed = ["a.js", "b.js", "c.js"].map((name) => ({
    status: "M",
    type: "file",
    path: `project/${name}`
  }));
  const env = buildArcEnv(binDir, {
    FAKE_ARC_STATUS_JSON: JSON.stringify({ staged: [], changed, untracked: [] }),
    FAKE_ARC_UNSTAGED_DIFF: "INLINE_ARC_MARKER\n"
  });

  withProcessEnv(env, () => {
    const context = requireReviewWorkspace(workspace);
    const target = resolveReviewTarget(context, { scope: "working-tree" });
    const reviewContext = collectReviewContext(context, target);
    assert.equal(reviewContext.inputMode, "self-collect");
    assert.match(reviewContext.collectionGuidance, /arc status --json \./);
    assert.match(reviewContext.collectionGuidance, /--relative=\./);
    assert.match(reviewContext.collectionGuidance, /Do not run `arc root`/);
    assert.doesNotMatch(reviewContext.content, /INLINE_ARC_MARKER/);
  });
});

test("malformed Arc status fails without producing review context", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeArc(binDir);
  const env = buildArcEnv(binDir, { FAKE_ARC_BEHAVIOR: "malformed-status" });

  withProcessEnv(env, () => {
    const context = requireReviewWorkspace(workspace);
    assert.throws(
      () => resolveReviewTarget(context, { scope: "working-tree" }) && collectReviewContext(
        context,
        { mode: "working-tree", label: "working tree diff", explicit: true }
      ),
      /arc status --json returned malformed JSON/
    );
  });
});

test("an explicitly requested missing Arc binary returns an Arc-specific error", () => {
  const workspace = makeTempDir();
  withProcessEnv({ PATH: makeTempDir() }, () => {
    assert.throws(
      () => requireReviewWorkspace(workspace, { vcs: "arc" }),
      /Yandex Arc CLI is not installed/
    );
  });
});

test("Arc review routes through an app-server custom target", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeCodex(binDir);
  installFakeArc(binDir);
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    FAKE_ARC_STATUS_JSON: JSON.stringify({
      staged: [],
      changed: [{ status: "M", type: "file", path: "project/src/app.js" }],
      untracked: []
    }),
    FAKE_ARC_UNSTAGED_DIFF: "diff --git a/src/app.js b/src/app.js\n+arc\n"
  };

  const result = run("node", [SCRIPT, "review"], { cwd: workspace, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed custom target/);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.lastReviewStart.target.type, "custom");
  assert.match(state.lastReviewStart.target.instructions, /Yandex Arc/);
  assert.match(state.lastReviewStart.target.instructions, /## Arc Status/);
  assert.doesNotMatch(state.lastReviewStart.target.instructions, /git status|git diff/);

  const stateRoots = fs.readdirSync(path.join(pluginDataDir, "state"));
  assert.equal(stateRoots.length, 1);
  const companionState = JSON.parse(
    fs.readFileSync(path.join(pluginDataDir, "state", stateRoots[0], "state.json"), "utf8")
  );
  assert.equal(companionState.jobs[0].vcs, "arc");
});

test("review-estimate returns backend-neutral JSON for Arc", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeArc(binDir);
  const env = buildArcEnv(binDir, {
    FAKE_ARC_STATUS_JSON: JSON.stringify({
      staged: [],
      changed: [{ status: "M", type: "file", path: "project/src/app.js" }],
      untracked: []
    }),
    FAKE_ARC_UNSTAGED_DIFF: "diff --git a/src/app.js b/src/app.js\n+arc\n"
  });

  const result = run("node", [SCRIPT, "review-estimate", "--scope working-tree --json"], {
    cwd: workspace,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.vcs, "arc");
  assert.equal(payload.target.mode, "working-tree");
  assert.equal(payload.fileCount, 1);
  assert.equal(payload.recommendedMode, "wait");
});

test("a bound Arc command failure does not fall back to Git", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeArc(binDir);
  initGitRepo(workspace);
  const env = buildArcEnv(binDir, {
    FAKE_ARC_BEHAVIOR: "diff-fails",
    FAKE_ARC_STATUS_JSON: JSON.stringify({
      staged: [],
      changed: [{ status: "M", type: "file", path: "project/src/app.js" }],
      untracked: []
    })
  });

  const result = run("node", [SCRIPT, "review-estimate", "--scope working-tree --json"], {
    cwd: workspace,
    env
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated Arc diff failure/);
  assert.doesNotMatch(result.stderr, /Git repository/);
});

test("session start exports an Arc binding reused by nested lifecycle commands", () => {
  const workspace = makeTempDir();
  const nested = path.join(workspace, "nested");
  const binDir = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  installFakeArc(binDir);
  fs.mkdirSync(nested);
  fs.writeFileSync(envFile, "");
  const env = buildArcEnv(binDir, {
    CLAUDE_ENV_FILE: envFile
  });

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: workspace,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "arc-session",
      cwd: workspace
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /CODEX_COMPANION_VCS='arc'/);
  assert.match(
    exported,
    new RegExp(`CODEX_COMPANION_WORKSPACE_ROOT='${fs.realpathSync(workspace).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`)
  );

  withProcessEnv({
    CODEX_COMPANION_VCS: "arc",
    CODEX_COMPANION_WORKSPACE_ROOT: fs.realpathSync(workspace)
  }, () => {
    assert.equal(resolveStateDir(workspace), resolveStateDir(nested));
  });
});

test("a session without VCS still reuses its opened workspace identity", () => {
  const workspace = makeTempDir();
  const nested = path.join(workspace, "nested");
  fs.mkdirSync(nested);

  withProcessEnv({
    CODEX_COMPANION_VCS: null,
    CODEX_COMPANION_WORKSPACE_ROOT: fs.realpathSync(workspace)
  }, () => {
    assert.equal(resolveStateDir(workspace), resolveStateDir(nested));
    assert.equal(resolveWorkspaceContext(nested).vcsKind, null);
  });
});
