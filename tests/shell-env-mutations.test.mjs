import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const BASH = "/bin/bash";
const POSIX = { skip: process.platform === "win32" || !fs.existsSync(BASH) };
const MANAGED_NAMES = ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH", "CLAUDE_PLUGIN_DATA"];
const LATEST = ["latest-session", "latest-transcript", "latest-data"];

function fixture(t, contents) {
  const directory = makeTempDir("codex-shell-mutations-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "env.sh");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function start(file, values = LATEST) {
  return run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: values[2] },
    input: JSON.stringify({ session_id: values[0], transcript_path: values[1] })
  });
}

for (const name of MANAGED_NAMES) {
  for (const command of ["unset", "unset -v"]) {
    test(`SessionStart rejects ${command} of ${name} before writing`, (t) => {
      const marker = "PRIVATE-DUMMY-UNSET-FIXTURE";
      const contents = MANAGED_NAMES.map((variable) => `export ${variable}='old'\n`).join("")
        + `${command} ${name}\nexport OTHER='${marker}'\n`;
      const file = fixture(t, contents);
      const before = fs.readFileSync(file);
      const result = start(file);
      assert.notEqual(result.status, 0, "an unset targeting an updated variable must be rejected");
      assert.notEqual(result.stderr.trim(), "", "the hook must explain its refusal");
      assert.equal((result.stdout + result.stderr).includes(marker), false, "the error must not echo source contents");
      assert.deepEqual(fs.readFileSync(file), before, "rejection must leave the file byte-for-byte unchanged");
    });
  }
}

function assertSourcedValuesAndStatus(file, values) {
  const result = run(BASH, ["--noprofile", "--norc", "-c", [
    'source "$1" || exit',
    '[[ "$CODEX_COMPANION_SESSION_ID" == "$2" && "$CODEX_COMPANION_TRANSCRIPT_PATH" == "$3" && "$CLAUDE_PLUGIN_DATA" == "$4" && "$OTHER" == 0 ]]'
  ].join(" && "), "verify", file, ...values], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr || "sourcing must yield the latest values and preserve the observed success status");
}

test("SessionStart preserves duplicate-export exit status observed by another assignment", POSIX, (t) => {
  const file = fixture(t, "export CODEX_COMPANION_SESSION_ID='old'\nfalse; export CODEX_COMPANION_SESSION_ID='duplicate'; export OTHER=$?\n");
  let first;
  for (let index = 0; index < 3; index += 1) {
    const result = start(file);
    assert.equal(result.status, 0, result.stderr);
    const updated = fs.readFileSync(file, "utf8");
    assertSourcedValuesAndStatus(file, LATEST);
    if (index === 0) first = updated;
    else assert.equal(updated, first, "repeated invocations must not accumulate commands");
  }
  const changed = ["changed-session", "changed-transcript", "changed-data"];
  const replacement = start(file, changed);
  assert.equal(replacement.status, 0, replacement.stderr);
  assertSourcedValuesAndStatus(file, changed);
  const latest = fs.readFileSync(file, "utf8");
  const repeated = start(file, changed);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), latest);
});
