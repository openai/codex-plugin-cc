import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const SESSION_NAME = "CODEX_COMPANION_SESSION_ID";
const BASH = "/bin/bash";
const POSIX = { skip: process.platform === "win32" || !fs.existsSync(BASH) };

function fixture(t, contents) {
  const directory = makeTempDir("codex-shell-wrapper-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "env.sh");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function start(file, value = "latest") {
  return run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "" },
    input: JSON.stringify({ session_id: value, transcript_path: "" })
  });
}

for (const [name, command] of [
  ["builtin export", `builtin export ${SESSION_NAME}=stale`],
  ["command export", `command export ${SESSION_NAME}=stale`],
  ["command builtin export", `command builtin export ${SESSION_NAME}=stale`],
  ["builtin command export", `builtin command export ${SESSION_NAME}=stale`],
  ["builtin unset", `builtin unset ${SESSION_NAME}`],
  ["command unset", `command unset ${SESSION_NAME}`]
]) {
  test(`SessionStart rejects parent-shell ${name} before writing`, (t) => {
    const marker = "PRIVATE-DUMMY-WRAPPER-FIXTURE";
    const file = fixture(t, `export ${SESSION_NAME}='old'\n${command}\nexport OTHER='${marker}'\n`);
    const before = fs.readFileSync(file);
    const result = start(file);
    assert.notEqual(result.status, 0, "a parent-shell command wrapper must be rejected instead of overriding the managed value");
    assert.notEqual(result.stderr.trim(), "", "rejection must report why the file cannot be safely updated");
    assert.equal((result.stdout + result.stderr).includes(marker), false, "rejection must not echo source contents");
    assert.deepEqual(fs.readFileSync(file), before, "rejection must preserve the original file byte-for-byte");
  });
}

test("SessionStart preserves a wrapper inside command-substitution data", POSIX, (t) => {
  const unrelated = `export OTHER=$(builtin export ${SESSION_NAME}=child; printf keep)\n`;
  const file = fixture(t, `export ${SESSION_NAME}='old'\n` + unrelated);
  let first;
  for (let index = 0; index < 3; index += 1) {
    const result = start(file);
    assert.equal(result.status, 0, result.stderr);
    const updated = fs.readFileSync(file, "utf8");
    assert.equal(updated.includes(unrelated), true, "the child-shell wrapper and data command must remain unchanged");
    const sourced = run(BASH, ["--noprofile", "--norc", "-c", 'source "$1" && [[ "$CODEX_COMPANION_SESSION_ID" == latest && "$OTHER" == keep ]]', "verify", file], {
      cwd: path.dirname(file), env: { PATH: process.env.PATH }
    });
    assert.equal(sourced.status, 0, sourced.stderr || "child-shell writes must not replace the parent's latest value");
    if (index === 0) first = updated;
    else assert.equal(updated, first, "repeated invocations must be stable");
  }
});
