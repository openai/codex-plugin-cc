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
const HAS_BASH = process.platform !== "win32" && fs.existsSync(BASH);
const DATA_NAME = "CLAUDE_PLUGIN_DATA";
const MARKER = "PRIVATE-DUMMY-BUILTIN-FIXTURE";

function fixture(t, commands) {
  const directory = makeTempDir("codex-shell-builtin-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "env.sh");
  fs.writeFileSync(file, `export ${DATA_NAME}='old'\nexport OTHER='${MARKER}'\n${commands}\n`, "utf8");
  fs.writeFileSync(path.join(directory, "mutate.sh"), `${DATA_NAME}=stale\n`, "utf8");
  return file;
}

function start(file) {
  return run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "latest-data" },
    input: JSON.stringify({ session_id: "latest-session", transcript_path: "latest-transcript" })
  });
}

for (const [name, command, sourcedValue] of [
  ["printf -v", `printf -v ${DATA_NAME} %s stale`, "stale"],
  ["quoted printf command", `"printf" -v ${DATA_NAME} %s stale`, "stale"],
  ["escaped printf command", `p\\rintf -v ${DATA_NAME} %s stale`, "stale"],
  ["printf %n", `printf '%n' ${DATA_NAME}`, "0"],
  ["read", `read ${DATA_NAME} <<<'stale'`, "stale"],
  ["readarray", `readarray ${DATA_NAME} <<<'stale'`],
  ["mapfile", `mapfile ${DATA_NAME} <<<'stale'`],
  ["getopts", `getopts 'x:' ${DATA_NAME} -x stale`],
  ["let", `let '${DATA_NAME}=2'`],
  ["arithmetic assignment", `((${DATA_NAME}=2))`, "2"],
  ["arithmetic prefix increment", `((++${DATA_NAME}))`, "1"],
  ["arithmetic postfix increment", `((${DATA_NAME}++)); :`, "1"],
  ["arithmetic mutation inside another export", `export OTHER=$(( ${DATA_NAME}++ ))`, "1"],
  ["managed subscript assignment", `${DATA_NAME}[0]=stale`, "stale"],
  ["eval", `eval '${DATA_NAME}=stale'`],
  ["source", "source ./mutate.sh"],
  ["dot sourcing", ". ./mutate.sh"]
]) {
  test(`SessionStart rejects parent-shell ${name} before writing`, (t) => {
    const file = fixture(t, command);
    if (HAS_BASH && sourcedValue !== undefined) {
      const baseline = run(BASH, ["--noprofile", "--norc", "-c", 'source "$1" && [[ "$CLAUDE_PLUGIN_DATA" == "$2" ]]', "verify", file, sourcedValue], {
        cwd: path.dirname(file), env: { PATH: process.env.PATH }
      });
      assert.equal(baseline.status, 0, baseline.stderr || "the fixture must reproduce the builtin's managed-variable mutation in clean Bash");
    }
    const before = fs.readFileSync(file);
    const result = start(file);
    assert.notEqual(result.status, 0, "opaque parent-shell mutation must not silently override the hook's latest value");
    assert.notEqual(result.stderr.trim(), "", "rejection must report why the file cannot be safely updated");
    assert.equal((result.stdout + result.stderr).includes(MARKER), false, "the error must not echo source contents");
    assert.deepEqual(fs.readFileSync(file), before, "rejection must leave the original file byte-for-byte intact");
  });
}

test("SessionStart preserves child-shell printf data and remains stable", { skip: !HAS_BASH }, (t) => {
  const command = "export OTHER=$(printf keep)";
  const file = fixture(t, command);
  let first;
  for (let index = 0; index < 3; index += 1) {
    const result = start(file);
    assert.equal(result.status, 0, result.stderr);
    const updated = fs.readFileSync(file, "utf8");
    assert.equal(updated.includes(command + "\n"), true, "the child-shell data command must remain unchanged");
    const sourced = run(BASH, ["--noprofile", "--norc", "-c", [
      'source "$1"',
      '[[ "$OTHER" == keep && "$CLAUDE_PLUGIN_DATA" == latest-data && "$CODEX_COMPANION_SESSION_ID" == latest-session && "$CODEX_COMPANION_TRANSCRIPT_PATH" == latest-transcript ]]'
    ].join(" && "), "verify", file], {
      cwd: path.dirname(file), env: { PATH: process.env.PATH }
    });
    assert.equal(sourced.status, 0, sourced.stderr || "child-shell data must survive alongside the latest parent-shell values");
    if (index === 0) first = updated;
    else assert.equal(updated, first, "repeated invocations must not grow or reorder the file");
  }
});

test("SessionStart preserves read-only arithmetic depending on a managed value", { skip: !HAS_BASH }, (t) => {
  const command = `export OTHER=$(( \${#${DATA_NAME}} + 1 ))`;
  const file = fixture(t, command);
  let first;
  for (let index = 0; index < 3; index += 1) {
    const result = start(file);
    assert.equal(result.status, 0, result.stderr);
    const updated = fs.readFileSync(file, "utf8");
    assert.equal(updated.includes(command + "\n"), true);
    const sourced = run(BASH, ["--noprofile", "--norc", "-c", 'source "$1" && [[ "$CLAUDE_PLUGIN_DATA" == latest-data && "$OTHER" == "$2" ]]', "verify", file, String("latest-data".length + 1)], {
      cwd: path.dirname(file), env: { PATH: process.env.PATH }
    });
    assert.equal(sourced.status, 0, sourced.stderr);
    if (index === 0) first = updated;
    else assert.equal(updated, first);
  }
});
