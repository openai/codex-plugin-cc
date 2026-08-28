import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_LIB = path.join(HERE, "..", "plugins", "codex", "scripts", "lib", "codex.mjs");

// The inferred-completion timer in scheduleInferredCompletion() is the only thing
// that resolves `state.completion` when a turn arrives without an explicit final
// turn marker. If that timer is unref'd it does not hold the event loop open, so
// once the app-server socket closes the loop can drain with the completion promise
// still pending. Node then exits 0 having written nothing at all -- and callers
// that expect JSON on stdout (the stop-review gate) fail with a parse error that
// looks like a review verdict rather than a tooling failure.
//
// scheduleInferredCompletion is not exported, so this asserts the observable
// contract in a subprocess: a pending await whose sole remaining handle is that
// timer must still produce output rather than exiting silently.
function runCompletionHarness({ unref }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inferred-completion-"));
  const script = path.join(dir, "harness.mjs");

  fs.writeFileSync(
    script,
    `
let resolveCompletion;
const completion = new Promise((resolve) => { resolveCompletion = resolve; });
const timer = setTimeout(() => resolveCompletion("completed"), 250);
${unref ? "timer.unref?.();" : ""}
async function main() {
  const result = await completion;
  process.stdout.write(JSON.stringify({ rawOutput: result }) + "\\n");
}
main().catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`
  );

  try {
    return spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an unref'd completion timer lets the process exit 0 with no output", () => {
  const result = runCompletionHarness({ unref: true });

  // This is the failure mode being guarded against: a clean exit code with an
  // empty stdout is indistinguishable from success to a caller parsing JSON.
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a referenced completion timer resolves the turn and emits parseable output", () => {
  const result = runCompletionHarness({ unref: false });

  assert.equal(result.status, 0);
  assert.notEqual(result.stdout.trim(), "", "expected the completion timer to produce output");
  assert.equal(JSON.parse(result.stdout).rawOutput, "completed");
});

test("scheduleInferredCompletion does not unref the completion timer", () => {
  const source = fs.readFileSync(CODEX_LIB, "utf8");
  const start = source.indexOf("function scheduleInferredCompletion");
  assert.notEqual(start, -1, "expected to find scheduleInferredCompletion in codex.mjs");

  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);

  assert.doesNotMatch(
    body.replace(/^\s*\/\/.*$/gm, ""),
    /completionTimer\.unref/,
    "the inferred-completion timer must stay referenced so the turn can resolve before the event loop drains"
  );
});
