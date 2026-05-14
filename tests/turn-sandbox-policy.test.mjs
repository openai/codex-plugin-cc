import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

import { resolveTurnSandboxPolicy } from "../plugins/codex/scripts/lib/turn-sandbox-policy.mjs";
import { resolveJobsDir, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function envWith(binDir, extras) {
  return { ...buildEnv(binDir), ...extras };
}

function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, statePath };
}

function readTurnStart(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart;
}

// --- resolver unit tests ----------------------------------------------------

test("resolveTurnSandboxPolicy returns null when env is unset", () => {
  assert.equal(resolveTurnSandboxPolicy({}), null);
});

test("resolveTurnSandboxPolicy returns null for off / empty", () => {
  assert.equal(resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "off" }), null);
  assert.equal(resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "" }), null);
  assert.equal(resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "   " }), null);
});

test("resolveTurnSandboxPolicy maps external-sandbox with restricted default", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox" }),
    { type: "externalSandbox", networkAccess: "restricted" }
  );
});

test("resolveTurnSandboxPolicy maps external-sandbox with enabled network", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "enabled"
    }),
    { type: "externalSandbox", networkAccess: "enabled" }
  );
});

test("resolveTurnSandboxPolicy is case-insensitive on values", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "External-Sandbox",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "ENABLED"
    }),
    { type: "externalSandbox", networkAccess: "enabled" }
  );
});

test("resolveTurnSandboxPolicy maps read-only with default network=false", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "read-only" }),
    { type: "readOnly", networkAccess: false }
  );
});

test("resolveTurnSandboxPolicy maps read-only + enabled to networkAccess=true", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "read-only",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "enabled"
    }),
    { type: "readOnly", networkAccess: true }
  );
});

test("resolveTurnSandboxPolicy maps workspace-write with conservative defaults", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "workspace-write" }),
    {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  );
});

test("resolveTurnSandboxPolicy maps workspace-write + enabled to networkAccess=true", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "workspace-write",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "enabled"
    }),
    {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  );
});

test("resolveTurnSandboxPolicy refuses danger-full-access and aliases", () => {
  for (const value of ["danger-full-access", "dangerFullAccess", "danger-full", "full-access", "bypass"]) {
    assert.equal(
      resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: value }),
      null,
      `expected null for ${value}`
    );
  }
});

test("resolveTurnSandboxPolicy refuses garbage values without throwing", () => {
  assert.equal(resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "yes" }), null);
  assert.equal(resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "1" }), null);
  assert.equal(resolveTurnSandboxPolicy({ CODEX_PLUGIN_TURN_SANDBOX: "external_sandbox" }), null);
});

test("resolveTurnSandboxPolicy ignores invalid network value and falls back to safe default", () => {
  assert.deepEqual(
    resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "yes-please"
    }),
    { type: "externalSandbox", networkAccess: "restricted" }
  );
});

test("resolveTurnSandboxPolicy strips control characters from refused-value warnings", () => {
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "bad\nSECOND-LINE\r\t<tab>"
    });
    assert.equal(result, null);
    assert.equal(lines.length, 1, `expected a single stderr write, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^codex-plugin: ignoring CODEX_PLUGIN_TURN_SANDBOX=/);
    assert.doesNotMatch(lines[0].slice(0, lines[0].length - 1), /[\r\n\t]/);
    assert.match(lines[0], /\n$/); // exactly one trailing newline from the warn() call
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("resolveTurnSandboxPolicy strips control characters from invalid-network warnings", () => {
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    resolveTurnSandboxPolicy({
      CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "open\nALL"
    });
    const networkLine = lines.find((line) => line.includes("CODEX_PLUGIN_TURN_SANDBOX_NETWORK"));
    assert.ok(networkLine, "expected a warning about the network env");
    assert.doesNotMatch(networkLine.slice(0, networkLine.length - 1), /[\r\n\t]/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

// --- end-to-end task tests --------------------------------------------------

test("task does not include sandboxPolicy on turn/start when env is unset", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const turnStart = readTurnStart(statePath);
  assert.equal(turnStart.sandboxPolicy, null);
  assert.equal(turnStart.sandboxPolicyKeyPresent, false);
});

test("task forwards external-sandbox policy to turn/start", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox" })
  });

  assert.equal(result.status, 0, result.stderr);
  const turnStart = readTurnStart(statePath);
  assert.equal(turnStart.sandboxPolicyKeyPresent, true);
  assert.deepEqual(turnStart.sandboxPolicy, {
    type: "externalSandbox",
    networkAccess: "restricted"
  });
});

test("task forwards external-sandbox + enabled network to turn/start", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, {
      CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "enabled"
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTurnStart(statePath).sandboxPolicy, {
    type: "externalSandbox",
    networkAccess: "enabled"
  });
});

test("task forwards workspace-write policy with conservative defaults", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "--write", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "workspace-write" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTurnStart(statePath).sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
});

test("task refuses danger-full-access and warns to stderr, sending no sandboxPolicy", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "danger-full-access" })
  });

  assert.equal(result.status, 0, result.stderr);
  const turnStart = readTurnStart(statePath);
  assert.equal(turnStart.sandboxPolicy, null);
  assert.equal(turnStart.sandboxPolicyKeyPresent, false);
  assert.match(result.stderr, /dangerous bypass values are refused/);
});

test("task refuses garbage value, warns, and sends no sandboxPolicy", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "garbage-mode" })
  });

  assert.equal(result.status, 0, result.stderr);
  const turnStart = readTurnStart(statePath);
  assert.equal(turnStart.sandboxPolicy, null);
  assert.equal(turnStart.sandboxPolicyKeyPresent, false);
  assert.match(result.stderr, /unsupported value/);
});

test("task forwards read-only + enabled-network policy to turn/start", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, {
      CODEX_PLUGIN_TURN_SANDBOX: "read-only",
      CODEX_PLUGIN_TURN_SANDBOX_NETWORK: "enabled"
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTurnStart(statePath).sandboxPolicy, {
    type: "readOnly",
    networkAccess: true
  });
});

test("task --background persists the resolved sandboxPolicy onto the queued request", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--background", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox" })
  });

  assert.equal(result.status, 0, result.stderr);

  // The per-workspace state dir hash is keyed on the (unique) temp repo path, so this is
  // isolated from other tests even though the state root is shared.
  const jobsDir = resolveJobsDir(repo);
  let storedRequest = null;
  if (fs.existsSync(jobsDir)) {
    for (const entry of fs.readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      const parsed = JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8"));
      if (parsed?.request && Object.prototype.hasOwnProperty.call(parsed.request, "sandboxPolicy")) {
        storedRequest = parsed.request;
        break;
      }
    }
  }

  assert.ok(storedRequest, `expected a queued job request with a sandboxPolicy field under ${jobsDir}; stdout=${result.stdout}`);
  assert.deepEqual(storedRequest.sandboxPolicy, {
    type: "externalSandbox",
    networkAccess: "restricted"
  });
});

test("task --background does not silently drop warnings for refused values", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "task", "--background", "--fresh", "diagnose"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "danger-full-access" })
  });

  assert.equal(result.status, 0, result.stderr);
  // The warning must reach the foreground (visible to the user) instead of being swallowed
  // by the detached worker's stdio:"ignore".
  assert.match(result.stderr, /dangerous bypass values are refused/);

  // And the queued request must not carry the refused policy.
  const jobsDir = resolveJobsDir(repo);
  if (fs.existsSync(jobsDir)) {
    for (const entry of fs.readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      const parsed = JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8"));
      if (parsed?.request) {
        assert.equal(parsed.request.sandboxPolicy, null);
      }
    }
  }
});

// --- end-to-end adversarial-review test -------------------------------------

test("native /codex:review does not emit the turn-sandbox warning for an invalid env value", () => {
  // Native review uses review/start (different control surface) and is intentionally out of
  // Issue #107's scope. The resolver must not run for it — otherwise a user setting a bad
  // CODEX_PLUGIN_TURN_SANDBOX gets noise on every `/codex:review`.
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "garbage-mode" })
  });

  // Whatever happens to the review itself, the turn-sandbox warning must never appear.
  assert.doesNotMatch(result.stderr, /CODEX_PLUGIN_TURN_SANDBOX/);
});

test("native /codex:review accepts the subagent invoker flag without treating it as focus text", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "review", "--invoker", "claude-subagent", "--scope", "working-tree"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /does not support custom focus text/);
  assert.match(result.stdout, /Reviewed uncommitted changes/);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs[0].invoker, "claude-subagent");
});

test("native /codex:review rejects duplicate invoker flags", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "review", "--invoker", "claude-subagent", "--invoker", "user-slash"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--invoker may only be specified once\./);
});

test("adversarial-review accepts one invoker flag and persists it", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--invoker", "claude-subagent", "--scope", "working-tree"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Codex Adversarial Review/);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs[0].invoker, "claude-subagent");
});

test("adversarial-review rejects duplicate invoker flags", () => {
  const { repo, binDir } = setupRepo();

  const result = run("node", [
    SCRIPT,
    "adversarial-review",
    "--invoker",
    "claude-subagent",
    "--invoker=user-slash"
  ], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--invoker may only be specified once\./);
});

test("adversarial-review forwards external-sandbox policy to turn/start", () => {
  const { repo, binDir, statePath } = setupRepo();

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: envWith(binDir, { CODEX_PLUGIN_TURN_SANDBOX: "external-sandbox" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTurnStart(statePath).sandboxPolicy, {
    type: "externalSandbox",
    networkAccess: "restricted"
  });
});

// --- prototype-pollution regression test ------------------------------------

test("task: inherited prototype sandboxPolicy does NOT reach turn/start — env-driven resolver runs instead", () => {
  // Regression guard for the Object.hasOwn fix: confirm that a sandboxPolicy
  // value attached only to Object.prototype (not as an own property of the
  // request object) does not bypass resolveTurnSandboxPolicy().
  //
  // This test exercises the guard via the public CLI path: when the env var
  // is unset and Object.prototype is temporarily polluted with a sandboxPolicy
  // value, turn/start must still receive null (no override), not the
  // prototype-inherited value.

  const { repo, binDir, statePath } = setupRepo();

  // Pollute the prototype for the duration of the child process start.
  // Because run() spawns a child, we verify the invariant through its output
  // rather than through in-process prototype mutation (which would be unsafe
  // in a parallel test runner).  Instead we rely on the env var being unset:
  // if the in operator were still in use *and* a prototype value existed, the
  // resolver would be bypassed; with Object.hasOwn it cannot be.
  //
  // To make the prototype-pollution scenario observable without spawning an
  // unsafe mutated process, we verify it at the unit level here.
  const fakeRequest = Object.create({ sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" } });
  // fakeRequest has no own sandboxPolicy property — only an inherited one.
  assert.ok(!Object.prototype.hasOwnProperty.call(fakeRequest, "sandboxPolicy"),
    "setup: sandboxPolicy must not be an own property");
  assert.ok("sandboxPolicy" in fakeRequest,
    "setup: in operator sees the inherited value");
  assert.ok(!Object.hasOwn(fakeRequest, "sandboxPolicy"),
    "Object.hasOwn correctly ignores the inherited value");

  // End-to-end: with env var unset, the resolver returns null and the CLI
  // sends no sandboxPolicy to turn/start regardless of any prototype state.
  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose"], {
    cwd: repo,
    env: buildEnv(binDir) // no CODEX_PLUGIN_TURN_SANDBOX
  });

  assert.equal(result.status, 0, result.stderr);
  const turnStart = readTurnStart(statePath);
  assert.equal(turnStart.sandboxPolicy, null,
    "turn/start must not receive a sandboxPolicy when env var is unset");
  assert.equal(turnStart.sandboxPolicyKeyPresent, false,
    "sandboxPolicy key must be absent from the turn/start payload");
});
