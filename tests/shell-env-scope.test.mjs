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
const MARKER = "PRIVATE-DUMMY-SCOPE-FIXTURE";

function assertRejectedWithoutWrites(t, commands) {
  const directory = makeTempDir("codex-shell-scope-test-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "env.sh");
  const contents = `export OTHER='${MARKER}'\n` + commands(directory);
  fs.writeFileSync(file, contents, "utf8");
  const before = fs.readFileSync(file);
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: directory,
    env: { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "latest-data" },
    input: JSON.stringify({ session_id: "latest-session", transcript_path: "latest-transcript" })
  });
  assert.notEqual(result.status, 0, "ambiguous or conditional writes must be rejected before the file is updated");
  assert.notEqual(result.stderr.trim(), "", "rejection must explain why the hook cannot safely update the file");
  assert.equal((result.stdout + result.stderr).includes(MARKER), false, "rejection must not echo environment-file contents");
  assert.deepEqual(fs.readFileSync(file), before, "rejection must preserve the complete original file");
}

for (const [name, nested] of [
  ["executed conditional", `if true; then\nexport ${SESSION_NAME}='stale'\nfi\n`],
  ["unexecuted conditional", `if false; then\nexport ${SESSION_NAME}='stale'\nfi\n`],
  ["brace group", `{\nexport ${SESSION_NAME}='stale'\n}\n`],
  ["function body", `set_managed() {\nexport ${SESSION_NAME}='stale'\n}\n`],
  ["loop body", `for item in once; do\nexport ${SESSION_NAME}='stale'\ndone\n`]
]) {
  test(`SessionStart rejects a managed export in a parent-shell ${name}`, (t) => {
    assertRejectedWithoutWrites(t, () => `export ${SESSION_NAME}='old'\n` + nested);
  });
}

for (const argument of [`"${SESSION_NAME}=stale"`, `'${SESSION_NAME}=stale'`]) {
  test(`SessionStart rejects a quoted managed assignment argument (${argument[0] === '"' ? "double" : "single"} quotes)`, (t) => {
    assertRejectedWithoutWrites(t, () => `export ${SESSION_NAME}='old'\nexport ${argument}\n`);
  });
}

test("SessionStart rejects an indeterminate export argument without evaluating it", (t) => {
  assertRejectedWithoutWrites(t, () => `export ${SESSION_NAME}='old'\nASSIGNMENT='${SESSION_NAME}=stale'\nexport "$ASSIGNMENT"\n`);
});

test("SessionStart rejects a negated parent-shell export represented as an ordinary command", (t) => {
  assertRejectedWithoutWrites(t, () => `export ${SESSION_NAME}='old'\n! export ${SESSION_NAME}='stale'\n`);
});

test("SessionStart rejects redirected managed exports instead of removing their fallback", (t) => {
  assertRejectedWithoutWrites(t, (directory) => {
    const missingOutput = path.join(directory, "missing-directory", "output");
    return `export ${SESSION_NAME}='first' >'${missingOutput}'\nexport ${SESSION_NAME}='fallback'\n`;
  });
});
