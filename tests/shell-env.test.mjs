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
const SESSION_NAME = "CODEX_COMPANION_SESSION_ID";

function fixture(t, contents) {
  const directory = makeTempDir("codex-shell-env-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "env.sh");
  fs.writeFileSync(file, contents, "utf8");
  assert.equal(run(BASH, ["--noprofile", "--norc", "-n", file], {
    cwd: directory,
    env: { PATH: process.env.PATH }
  }).status, 0, "the reproduction fixture must be valid Bash");
  return file;
}

function start(file, sessionId = "latest") {
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "" },
    input: JSON.stringify({ session_id: sessionId, transcript_path: "" })
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(file, "utf8");
}

function assertSource(file, expected) {
  const checks = Object.keys(expected).map((name, index) => `[[ "\${${name}}" == "\${${index + 2}}" ]]`);
  const result = run(BASH, ["--noprofile", "--norc", "-c", [
    'source "$1" || exit',
    ...checks
  ].join(" && "), "verify", file, ...Object.values(expected)], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr || "sourcing must preserve unrelated values and export the latest session id");
}

function assertRejectedStart(file) {
  const before = fs.readFileSync(file);
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "" },
    input: JSON.stringify({ session_id: "latest", transcript_path: "" })
  });
  assert.notEqual(result.status, 0, "unsupported writes must fail instead of silently overriding the latest value");
  assert.notEqual(result.stderr.trim(), "", "rejection must report an actionable error");
  assert.equal((result.stdout + result.stderr).includes("PRIVATE-DUMMY-UNSUPPORTED-WRITE"), false, "rejection must not echo source values");
  assert.deepEqual(fs.readFileSync(file), before, "rejection must leave the original file byte-for-byte intact");
}

for (const [name, contents, unrelated] of [
  ["semicolon-separated commands", `export ${SESSION_NAME}='old'; export OTHER='keep'\n`, "export OTHER='keep'"],
  ["multiple export arguments", `export ${SESSION_NAME}='old' OTHER='keep'\n`, "OTHER='keep'"]
]) {
  test(`SessionStart preserves other assignments in ${name}`, POSIX, (t) => {
    const file = fixture(t, contents);
    let first;
    for (let index = 0; index < 3; index += 1) {
      const updated = start(file);
      assert.equal(updated.includes(unrelated), true, "the unrelated assignment must remain byte-for-byte intact");
      assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
      if (index === 0) first = updated;
      else assert.equal(updated, first, "repeated SessionStart must not grow or reorder the file");
    }
    start(file, "changed");
    assertSource(file, { [SESSION_NAME]: "changed", OTHER: "keep" });
  });
}

test("SessionStart preserves export-looking literal data in a here-document", POSIX, (t) => {
  const literal = `first\nexport ${SESSION_NAME}='example'\nlast`;
  const unrelated = `export OTHER=$(cat <<'EOF'\n${literal}\nEOF\n)\n`;
  const file = fixture(t, unrelated + `export ${SESSION_NAME}='old'\n`);
  let first;
  for (let index = 0; index < 3; index += 1) {
    const updated = start(file);
    assert.equal(updated.includes(unrelated), true, "the complete here-document must remain byte-for-byte intact");
    assertSource(file, { [SESSION_NAME]: "latest", OTHER: literal });
    if (index === 0) first = updated;
    else assert.equal(updated, first);
  }
});

test("SessionStart handles ANSI-C quotes without swallowing subsequent assignments", POSIX, (t) => {
  const unrelated = "export OTHER='keep'\n";
  const file = fixture(t, `export ${SESSION_NAME}=$'old\\'s'\n` + unrelated);
  const first = start(file);
  assert.equal(first.includes(unrelated), true);
  assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
  assert.equal(start(file), first);
});

for (const [name, nested] of [
  ["conditional", `if false; then\nexport ${SESSION_NAME}='inner'\nfi\nexport OTHER='keep'\n`],
  ["function", `set_inner() {\nexport ${SESSION_NAME}='inner'\n}\nexport OTHER='keep'\n`],
  ["command substitution", `export OTHER=$(\nexport ${SESSION_NAME}='inner'\nprintf keep\n)\n`]
]) {
  test(`SessionStart leaves ${name} exports scoped and updates the top-level export`, POSIX, (t) => {
    const file = fixture(t, nested + `export ${SESSION_NAME}='old'\n`);
    const first = start(file);
    assert.equal(first.includes(nested), true, "nested shell commands must remain byte-for-byte intact");
    assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
    assert.equal(start(file), first);
    const changed = start(file, "changed");
    assert.equal(changed.includes(nested), true);
    assertSource(file, { [SESSION_NAME]: "changed", OTHER: "keep" });
  });
}

test("SessionStart collapses preexisting standalone duplicates and remains stable", POSIX, (t) => {
  const duplicate = `export ${SESSION_NAME}='old'\n`;
  const file = fixture(t, duplicate + "export OTHER='keep'\n" + duplicate.repeat(3));
  const first = start(file);
  assert.equal(first, `export ${SESSION_NAME}='latest'\nexport OTHER='keep'\n:\n:\n:\n`);
  assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
  assert.equal(start(file), first);
});

test("SessionStart preserves Unicode around and within edited exports", POSIX, (t) => {
  const before = "# π 🧪\nexport OTHER='🌍 café'\n";
  const after = "export AFTER='naïve 🔬'\n";
  const file = fixture(t, before + `export ${SESSION_NAME}='old 🚀'\n` + after + `export ${SESSION_NAME}='duplicate 🌙'\n`);
  const first = start(file, "latest 🌠 café");
  assert.equal(first, before + `export ${SESSION_NAME}='latest 🌠 café'\n` + after + ":\n");
  assertSource(file, { [SESSION_NAME]: "latest 🌠 café", OTHER: "🌍 café", AFTER: "naïve 🔬" });
  assert.equal(start(file, "latest 🌠 café"), first);
});

test("SessionStart rejects invalid shell without changing the file or echoing its contents", POSIX, (t) => {
  const directory = makeTempDir("codex-shell-env-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "invalid.sh");
  const marker = "PRIVATE-DUMMY-FIXTURE-CONTENT";
  const invalid = `export OTHER='${marker}\n`;
  fs.writeFileSync(file, invalid, "utf8");
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: directory,
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "" },
    input: JSON.stringify({ session_id: "latest", transcript_path: "" })
  });
  assert.notEqual(result.status, 0, "invalid shell must cause the hook to fail before writing");
  assert.notEqual(result.stderr.trim(), "", "the hook must report an actionable error");
  assert.equal((result.stdout + result.stderr).includes(marker), false, "errors must not echo source contents");
  assert.equal(fs.readFileSync(file, "utf8"), invalid, "failed parsing must leave the original file untouched");
});

test("SessionStart leaves background exports scoped and appends a parent-shell export", POSIX, (t) => {
  const original = `export ${SESSION_NAME}='child' &\nexport OTHER='keep'\n`;
  const file = fixture(t, original);
  const first = start(file);
  assert.equal(first, original + `export ${SESSION_NAME}='latest'\n`);
  assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
  assert.equal(start(file), first);
});

test("SessionStart rejects optioned exports without changing the file", POSIX, (t) => {
  const plain = `export ${SESSION_NAME}='old'\n`;
  for (const command of [`export -n ${SESSION_NAME}`, `export -n ${SESSION_NAME}='PRIVATE-DUMMY-UNSUPPORTED-WRITE'`]) {
    for (const contents of [command + "\n" + plain, plain + command + "\n"]) {
      const file = fixture(t, contents + "export OTHER='PRIVATE-DUMMY-UNSUPPORTED-WRITE'\n");
      assertRejectedStart(file);
    }
  }
});

test("SessionStart rejects append assignments without changing the file", POSIX, (t) => {
  const plain = `export ${SESSION_NAME}='old'\n`;
  const append = `export ${SESSION_NAME}+='PRIVATE-DUMMY-UNSUPPORTED-WRITE'\n`;
  for (const contents of [append + plain, plain + append]) {
    assertRejectedStart(fixture(t, contents));
  }
});

test("SessionStart rejects plain non-export assignments to updated variables", POSIX, (t) => {
  const file = fixture(t, `export ${SESSION_NAME}='old'\n${SESSION_NAME}='PRIVATE-DUMMY-UNSUPPORTED-WRITE'\n`);
  assertRejectedStart(file);
});

test("SessionStart updates redirected exports and preserves duplicate redirections", POSIX, (t) => {
  for (const firstRedirect of ["", " >/dev/null"]) {
    const original = `export ${SESSION_NAME}='old'${firstRedirect}\nexport OTHER='keep'\nexport ${SESSION_NAME}='stale' >/dev/null\n`;
    const file = fixture(t, original);
    let first;
    for (let index = 0; index < 3; index += 1) {
      const updated = start(file);
      assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
      assert.equal(updated.includes("export OTHER='keep'\n"), true);
      assert.equal((updated.match(/>\/dev\/null/g) ?? []).length, firstRedirect ? 2 : 1, "duplicate redirections must retain their shell side effects");
      if (index === 0) first = updated;
      else assert.equal(updated, first);
    }
    start(file, "changed");
    assertSource(file, { [SESSION_NAME]: "changed", OTHER: "keep" });
  }
});

test("SessionStart removes duplicate commands without stranding a leading semicolon", POSIX, (t) => {
  const unrelated = "export OTHER='keep'";
  const file = fixture(t, `export ${SESSION_NAME}='old'\nexport ${SESSION_NAME}='duplicate'; ${unrelated}\n`);
  let first;
  for (let index = 0; index < 3; index += 1) {
    const updated = start(file);
    assert.equal(updated.includes(unrelated), true);
    assert.equal((updated.match(new RegExp(`export ${SESSION_NAME}=`, "g")) ?? []).length, 1);
    assert.equal(run(BASH, ["--noprofile", "--norc", "-n", file], {
      cwd: path.dirname(file), env: { PATH: process.env.PATH }
    }).status, 0, "removing a duplicate command must preserve valid shell separators");
    assertSource(file, { [SESSION_NAME]: "latest", OTHER: "keep" });
    if (index === 0) first = updated;
    else assert.equal(updated, first);
  }
});

test("the deployed hook runs without source helpers, WASM files or node_modules", (t) => {
  const directory = makeTempDir("codex-hook-deployment-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, "scripts");
  fs.mkdirSync(scripts);
  const hook = path.join(scripts, "session-lifecycle-hook.mjs");
  fs.copyFileSync(SESSION_HOOK, hook);
  fs.cpSync(path.join(ROOT, "plugins", "codex", "scripts", "lib"), path.join(scripts, "lib"), { recursive: true });
  fs.mkdirSync(path.join(directory, ".claude-plugin"));
  fs.copyFileSync(path.join(ROOT, "plugins", "codex", ".claude-plugin", "plugin.json"), path.join(directory, ".claude-plugin", "plugin.json"));
  assert.deepEqual(fs.readdirSync(scripts).sort(), ["lib", "session-lifecycle-hook.mjs"]);
  const file = path.join(directory, "env.sh");
  const expected = "export CODEX_COMPANION_SESSION_ID='deployment-session'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='dummy-transcript.jsonl'\nexport CLAUDE_PLUGIN_DATA='dummy-plugin-data'\n";
  for (let index = 0; index < 3; index += 1) {
    const result = run(process.execPath, [hook, "SessionStart"], {
      cwd: directory,
      env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "dummy-plugin-data" },
      input: JSON.stringify({ session_id: "deployment-session", transcript_path: "dummy-transcript.jsonl" })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), expected);
  }
});
