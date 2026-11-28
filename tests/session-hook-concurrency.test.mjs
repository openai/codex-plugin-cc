import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const INPUT = JSON.stringify({ session_id: "latest", transcript_path: "/tmp/latest-transcript" });
const ORIGINAL = "export CODEX_COMPANION_SESSION_ID='old'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='/tmp/old'\nexport CLAUDE_PLUGIN_DATA='/tmp/old-data'\n";
const LATEST = "export CODEX_COMPANION_SESSION_ID='latest'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='/tmp/latest-transcript'\nexport CLAUDE_PLUGIN_DATA='/tmp/latest-data'\n";
const MARKER = "CONCURRENT-DUMMY-MARKER";

// Deterministically simulate another writer after a real read, rather than relying on timings.
const DRIVER = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [envFile, hook, mode] = process.argv.slice(1);
const read = fs.readFileSync;
const write = fs.writeFileSync;
let reads = 0;
let writes = 0;
fs.readFileSync = (file, ...args) => {
  const contents = read(file, ...args);
  if (file === envFile) {
    reads += 1;
    if (mode === "churn" || reads === 1) {
      const appended = mode === "churn"
        ? "# ${MARKER}-" + reads + "\\n"
        : "export OTHER='keep'\\n";
      // The unpatched append represents the other writer, not a hook write.
      write(envFile, appended, { encoding: "utf8", flag: "a" });
    }
  }
  return contents;
};
fs.writeFileSync = (file, ...args) => {
  if (file === envFile) writes += 1;
  return write(file, ...args);
};
syncBuiltinESMExports();
process.on("exit", () => fs.writeSync(1, JSON.stringify({ reads, writes }) + "\\n"));
process.argv.splice(1, process.argv.length - 1, "session-hook", "SessionStart");
await import(hook);
`;

function fixture(t) {
  const directory = makeTempDir("codex-hook-concurrency-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "env.sh");
  fs.writeFileSync(file, ORIGINAL, "utf8");
  return file;
}

function environment(file) {
  return { PATH: process.env.PATH, CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "/tmp/latest-data" };
}

function simulatedWriter(file, mode) {
  return run(process.execPath, [
    "--input-type=module", "--eval", DRIVER, file, pathToFileURL(HOOK).href, mode
  ], { cwd: path.dirname(file), env: environment(file), input: INPUT });
}

test("SessionStart reconciles a simulated append during asynchronous parsing", (t) => {
  const file = fixture(t);
  const result = simulatedWriter(file, "once");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), LATEST + "export OTHER='keep'\n");
  assert.ok(JSON.parse(result.stdout).reads > 1, "the hook must re-read before replacing its snapshot");

  if (process.platform !== "win32" && fs.existsSync("/bin/sh")) {
    const sourced = run("/bin/sh", [
      "-c",
      '. "$1"; [ "$CODEX_COMPANION_SESSION_ID" = latest ] && [ "$CODEX_COMPANION_TRANSCRIPT_PATH" = /tmp/latest-transcript ] && [ "$CLAUDE_PLUGIN_DATA" = /tmp/latest-data ] && [ "$OTHER" = keep ]',
      "verify", file
    ], { cwd: path.dirname(file), env: { PATH: process.env.PATH } });
    assert.equal(sourced.status, 0, sourced.stderr);
  }

  const stable = fs.readFileSync(file, "utf8");
  const modified = fs.statSync(file).mtimeMs;
  const repeated = run(process.execPath, [HOOK, "SessionStart"], {
    cwd: path.dirname(file), env: environment(file), input: INPUT
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), stable);
  assert.equal(fs.statSync(file).mtimeMs, modified, "an unchanged result must not rewrite the file");
});

test("SessionStart stops retrying sustained simulated churn without overwriting it", (t) => {
  const file = fixture(t);
  const result = simulatedWriter(file, "churn");
  assert.notEqual(result.status, 0, "continued intervening changes must cause a bounded failure");
  const metrics = JSON.parse(result.stdout);
  assert.ok(metrics.reads > 1 && metrics.reads <= 10, "retries must be bounded");
  assert.equal(metrics.writes, 0, "the hook must not overwrite a changing file");
  const appended = Array.from({ length: metrics.reads }, (_, index) => `# ${MARKER}-${index + 1}\n`).join("");
  assert.equal(fs.readFileSync(file, "utf8"), ORIGINAL + appended, "all simulated writer data must survive");
  assert.notEqual(result.stderr.trim(), "", "failure must explain why no update was written");
  assert.equal((result.stdout + result.stderr).includes(MARKER), false, "errors must not echo file contents");
});
