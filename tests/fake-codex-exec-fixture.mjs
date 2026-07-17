import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

const FIXTURE_SCRIPT_NAME = "codex-fixture.cjs";

// A minimal fake `codex exec` binary for exec-transport.test.mjs. Behaviors:
//   "ok"              -- streams a lying `item.completed` line immediately,
//                        then writes the -o file and a real turn.completed
//                        event after a short delay.
//   "missing-output"  -- exits cleanly without ever writing the -o file.
//   "hang"            -- never writes the -o file and never exits on its
//                        own, exercising the timeout + tree-kill path.
//
// This must be a REAL executable, not a shim -- exec-transport.mjs's
// Windows path refuses to spawn through a cmd.exe shim at all (see
// resolveWindowsCodexInvocation's doc comment: that fallback was attempted
// and found to corrupt a nested-batch-file invocation, and Node itself
// refuses `shell:false` against a .cmd/.bat). So on Windows this fixture is
// a genuine copy of the running node.exe, renamed to codex.exe, preloaded
// via NODE_OPTIONS=--require so it exercises the exact same direct-exe,
// shell:false code path production uses.
//
// That preload trick has its own sharp edge worth recording: `--require`
// only guarantees the module's SYNCHRONOUS top-level code runs before
// Node's normal bootstrap continues -- once that synchronous body returns
// (e.g. because it scheduled a setTimeout/setInterval and yielded), Node
// proceeds to treat argv[1] ("exec") as the entry-point module to load,
// fails to resolve it, and crashes the whole process before any async
// callback ever fires. Patching `process.argv[1]` from inside the
// preloaded script does NOT prevent this -- empirically, Node had already
// captured the entry-point path before `--require` modules run. The fix is
// to never yield: every behavior below blocks synchronously (Atomics.wait
// on a throwaway SharedArrayBuffer, the standard true-synchronous-sleep
// primitive in Node) for its delay instead of using setTimeout/setInterval.
//
// A second, unrelated sharp edge from the same preload mechanism: the
// shebang line a directly-executed POSIX script needs (`#!/usr/bin/env
// node`) is NOT stripped by Node's `--require` preload loader the way it is
// for a normally-executed entry script -- included on Windows, it throws
// "SyntaxError: Invalid or unexpected token" before a single line of the
// behavior runs. So the shebang is POSIX-only.
function behaviorSource(behavior, argvSliceIndex, invocationsLogPath, includeShebang) {
  return `${includeShebang ? "#!/usr/bin/env node\n" : ""}const fs = require("node:fs");

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const args = process.argv.slice(${argvSliceIndex});
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
// Node normalizes a bare "exec" positional into an absolute path
// (cwd-joined) even inside a --require preload, in preparation for its own
// (never-reached, since we exit before it fires) main-module resolution --
// so args[0] here is "<cwd>\\exec" on Windows, not the literal string
// "exec". endsWith tolerates both that and the POSIX literal case.
if (!args[0] || !args[0].endsWith("exec")) {
  process.exit(1);
}

const BEHAVIOR = ${JSON.stringify(behavior)};

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

const outputPath = flagValue("-o");

function send(message) {
  console.log(JSON.stringify(message));
}

send({ type: "thread.started", thread_id: "thr_fake_exec_1" });
// A schema-coerced streamed message that LIES about completion (field
// report F5: --output-schema coerces every streamed assistant message,
// including narrated future-tense plans, into the schema shape). The
// transport under test must never treat this as the real completion.
send({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      status: "DONE",
      summary: "narrated plan, not real completion",
      files_modified: [],
      concerns: [],
      blocked_reason: null
    })
  }
});

if (BEHAVIOR === "hang") {
  // Blocks far longer than any test timeout, simulating an unresponsive
  // process; the external timeout + tree-kill is expected to end it first.
  sleepSync(10 * 60 * 1000);
} else if (BEHAVIOR === "missing-output") {
  process.exit(0);
} else if (BEHAVIOR === "echo-argv") {
  fs.writeFileSync(outputPath, JSON.stringify({ receivedArgs: args }));
  process.exit(0);
} else if (BEHAVIOR === "rate-limited") {
  // Simulates an upstream 429 rejected before any output was produced --
  // no -o file gets written. Every invocation is logged (by the -m model
  // it received) to a shared state file so a test can assert the tier
  // step-down order without any spy hooks inside exec-transport.mjs.
  const invocationsLogPath = ${JSON.stringify(invocationsLogPath)};
  const priorInvocations = fs.existsSync(invocationsLogPath) ? JSON.parse(fs.readFileSync(invocationsLogPath, "utf8")) : [];
  priorInvocations.push(flagValue("-m") || "unknown");
  fs.writeFileSync(invocationsLogPath, JSON.stringify(priorInvocations));
  console.error("Error: 429 rate limit exceeded for this request.");
  process.exit(1);
} else {
  sleepSync(50);
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      status: "DONE",
      summary: "Implemented the feature via codex exec.",
      files_modified: ["src/app.js"],
      concerns: [],
      blocked_reason: null
    })
  );
  send({ type: "turn.completed", turn_id: "turn_fake_exec_1" });
  process.exit(0);
}
`;
}

/**
 * Installs a fake `codex` (POSIX) / `codex.exe` (Windows) on `binDir` that
 * exec-transport.mjs's real spawn logic can invoke directly (no shell
 * wrapper). Pair with buildEnv(binDir) for the env to pass to
 * runExecTurn/runExecProcess.
 * @param {string} binDir
 * @param {string} [behavior]
 */
export function invocationsLogPath(binDir) {
  return path.join(binDir, "invocations.json");
}

/**
 * Reads back the model list logged by the "rate-limited" behavior, in
 * invocation order. Returns [] if no invocation has happened yet.
 * @param {string} binDir
 * @returns {string[]}
 */
export function readInvocations(binDir) {
  const logPath = invocationsLogPath(binDir);
  return fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
}

export function installFakeCodexExec(binDir, behavior = "ok") {
  const logPath = invocationsLogPath(binDir);
  if (process.platform === "win32") {
    const exePath = path.join(binDir, "codex.exe");
    fs.copyFileSync(process.execPath, exePath);
    const fixtureScriptPath = path.join(binDir, FIXTURE_SCRIPT_NAME);
    // argvSliceIndex 1: NODE_OPTIONS --require preloads this script before
    // Node would otherwise try (and fail) to resolve argv[1] as an entry
    // script, so argv[1..] are already the real "--version"/"exec ..." args.
    fs.writeFileSync(fixtureScriptPath, behaviorSource(behavior, 1, logPath, false), "utf8");
    return;
  }

  const scriptPath = path.join(binDir, "codex");
  // argvSliceIndex 2: a POSIX shebang script occupies argv[1] with its own
  // path, so the real "--version"/"exec ..." args start at argv[2].
  writeExecutable(scriptPath, behaviorSource(behavior, 2, logPath, true));
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
  if (process.platform === "win32") {
    const fixtureScriptPath = path.join(binDir, FIXTURE_SCRIPT_NAME).replace(/\\/g, "/");
    env.NODE_OPTIONS = `--require "${fixtureScriptPath}"`;
  }
  return env;
}
