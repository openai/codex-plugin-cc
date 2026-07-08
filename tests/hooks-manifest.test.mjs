import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const HOOKS_MANIFEST = path.join(PLUGIN_ROOT, "hooks", "hooks.json");

function readHooksManifest() {
  return JSON.parse(fs.readFileSync(HOOKS_MANIFEST, "utf8"));
}

function singleCommandHook(manifest, eventName) {
  const groups = manifest.hooks[eventName] ?? [];
  const commandHooks = groups.flatMap((group) => group.hooks ?? []);
  assert.equal(commandHooks.length, 1, `${eventName} should define exactly one command hook`);
  assert.equal(commandHooks[0].type, "command");
  return commandHooks[0];
}

function runHookCommand(commandHook, { env, input = "{}" } = {}) {
  return spawnSync(commandHook.command, commandHook.args ?? [], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    input,
    windowsHide: true
  });
}

const EXPECTED_HOOKS = [
  {
    eventName: "SessionStart",
    scriptName: "session-lifecycle-hook.mjs",
    scriptArgs: ["SessionStart"],
    timeout: 5
  },
  {
    eventName: "SessionEnd",
    scriptName: "session-lifecycle-hook.mjs",
    scriptArgs: ["SessionEnd"],
    timeout: 5
  },
  {
    eventName: "Stop",
    scriptName: "stop-review-gate-hook.mjs",
    scriptArgs: [],
    timeout: 900
  }
];

test("hook manifest uses exec form for every Codex hook", () => {
  const manifest = readHooksManifest();

  for (const expected of EXPECTED_HOOKS) {
    const hook = singleCommandHook(manifest, expected.eventName);
    assert.equal(hook.command, "node");
    assert.equal(hook.timeout, expected.timeout);
    assert.equal(hook.args[0], "-e");
    assert.equal(hook.args[2], expected.scriptName);
    assert.deepEqual(hook.args.slice(3), expected.scriptArgs);
    assert.match(hook.args[1], /CLAUDE_PLUGIN_ROOT/);
    assert.match(hook.args[1], /spawnSync/);
  }
});

test("hook manifest skips cleanly when CLAUDE_PLUGIN_ROOT is missing", () => {
  const manifest = readHooksManifest();
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;

  for (const expected of EXPECTED_HOOKS) {
    const hook = singleCommandHook(manifest, expected.eventName);
    const result = runHookCommand(hook, { env });

    assert.equal(result.status, 0, `${expected.eventName} should fail open`);
    assert.match(result.stderr, /CLAUDE_PLUGIN_ROOT is not set/);
    assert.doesNotMatch(result.stderr, /Cannot find module/);
  }
});

test("hook manifest delegates to bundled scripts when CLAUDE_PLUGIN_ROOT is set", () => {
  const manifest = readHooksManifest();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-hooks-"));
  const envFile = path.join(tempDir, "claude-env.sh");
  const pluginDataDir = path.join(tempDir, "plugin-data");
  const transcriptPath = path.join(tempDir, "session.jsonl");
  fs.writeFileSync(envFile, "", "utf8");
  fs.mkdirSync(pluginDataDir, { recursive: true });

  const env = {
    ...process.env,
    CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT
  };
  const input = JSON.stringify({
    session_id: "sess-hook-manifest",
    transcript_path: transcriptPath,
    cwd: tempDir
  });

  try {
    const sessionStart = runHookCommand(singleCommandHook(manifest, "SessionStart"), { env, input });
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.equal(
      fs.readFileSync(envFile, "utf8"),
      `export CODEX_COMPANION_SESSION_ID='sess-hook-manifest'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
    );

    const sessionEnd = runHookCommand(singleCommandHook(manifest, "SessionEnd"), { env, input });
    assert.equal(sessionEnd.status, 0, sessionEnd.stderr);

    const stop = runHookCommand(singleCommandHook(manifest, "Stop"), { env, input });
    assert.equal(stop.status, 0, stop.stderr);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
