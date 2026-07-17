/**
 * `codex exec` transport: drives a turn by spawning a one-shot headless
 * process instead of holding a long-lived app-server JSON-RPC session.
 * `runExecTurn` returns the same result shape as runAppServerTurn (codex.mjs)
 * so rig-edition.mjs can route between the two transports without either
 * caller or downstream envelope parsing noticing which one ran.
 *
 * Completion source of truth: the `-o/--output-last-message` file, never the
 * streamed --json JSONL output. `--output-schema` coerces every streamed
 * assistant message into the schema shape -- including narrated,
 * future-tense plans -- so a streamed `{"status":"DONE",...}` carries no
 * information about whether the turn actually finished. See
 * pack-codex/references/field-report-2026-07-16-windows-toolchain-blocker.md
 * finding F5. The `-o` file is written before process exit and is the only
 * trustworthy final message; a missing or empty file maps to a BLOCKED-style
 * result rather than throwing, mirroring how runAppServerTurn reports a
 * turn that never completed.
 *
 * @typedef {{
 *   status: 0 | 1,
 *   threadId: string | null,
 *   turnId: string | null,
 *   finalMessage: string,
 *   reasoningSummary: string[],
 *   turn: Record<string, unknown> | null,
 *   error: unknown,
 *   stderr: string,
 *   fileChanges: unknown[],
 *   touchedFiles: string[],
 *   commandExecutions: unknown[]
 * }} ExecTurnResult
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { binaryAvailable, resolveWindowsShell, terminateProcessTree } from "./process.mjs";

const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 300;

// Deliberately narrower than codex.mjs's getCodexAvailability, which also
// requires `codex app-server --help` to succeed -- that check is meaningless
// here since this transport never touches the app-server RPC surface.
function getExecAvailability(cwd) {
  return binaryAvailable("codex", ["--version"], { cwd });
}

/**
 * Builds the argument list for a single `codex exec` invocation. Exported
 * so callers and tests can inspect the exact command template without
 * spawning a process.
 * @param {string} prompt
 * @param {string} outputPath
 * @param {{
 *   schemaPath?: string | null,
 *   profile?: string,
 *   model?: string,
 *   effort?: string,
 *   cwd: string,
 *   sandbox?: string
 * }} options
 * @returns {string[]}
 */
export function buildExecArgs(prompt, outputPath, options = {}) {
  const args = ["exec", "--json"];

  if (options.schemaPath) {
    args.push("--output-schema", options.schemaPath);
  }
  args.push("-o", outputPath);
  if (options.profile) {
    args.push("-p", options.profile);
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    // `-c key=value` parses value as TOML; quoting matches the `-c
    // model="o3"` example in `codex exec --help` so a bare word round-trips
    // as a TOML string rather than an unquoted (and invalid) bareword.
    args.push("-c", `model_reasoning_effort="${options.effort}"`);
  }
  args.push("-C", options.cwd);
  if (options.sandbox) {
    args.push("-s", options.sandbox);
  }
  args.push("--skip-git-repo-check");
  args.push(prompt);

  return args;
}

function splitPathEntries(env) {
  const raw = env?.PATH ?? env?.Path ?? env?.path ?? "";
  return raw.split(path.delimiter).filter(Boolean);
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Directory-major, matching real Windows/cmd.exe PATH resolution: the FIRST
// PATH directory that has ANY match wins, checked across all extensions
// before moving to the next directory. An earlier, extension-major version
// of this (scan the whole PATH for .exe, THEN scan the whole PATH for
// .cmd) shadowed a fixture-only .cmd earlier on PATH and fell through to a
// real codex.exe installed later on PATH -- silently making a live call in
// what was meant to be a fixture-isolated test. See exec-transport.test.mjs.
function classifyCodexOnWindowsPath(env) {
  for (const dir of splitPathEntries(env)) {
    const exePath = [".exe", ".com"].map((ext) => path.join(dir, `codex${ext}`)).find(isFile);
    if (exePath) {
      return { kind: "exe", path: exePath };
    }
    const shimPath = [".cmd", ".bat"].map((ext) => path.join(dir, `codex${ext}`)).find(isFile);
    if (shimPath) {
      return { kind: "shim", path: shimPath };
    }
  }
  return null;
}

/**
 * Resolves how to invoke `codex exec` on Windows without ever combining a
 * shell wrapper with untrusted argv content (core-review BLOCKING 1:
 * `shell: resolveWindowsShell()` plus a dynamic prompt argument let cmd.exe's
 * own metacharacter parser see `&`/`|`/`>` inside the prompt, since Node's
 * shell-string spawn mode concatenates args UNescaped -- DEP0190).
 *
 * A real `codex.exe` on PATH is spawned directly with `shell: false`:
 * CreateProcess then receives properly CRT-quoted argv with no shell parser
 * involved at all, which is unconditionally safe -- this is Node's own
 * well-tested native Windows argv marshaling, not anything hand-rolled here.
 *
 * If no `.exe` is on PATH -- codex installed only via an npm `.cmd` shim --
 * this refuses rather than falling back to a hand-rolled cmd.exe escape.
 * That fallback was attempted and DISPROVEN empirically: escaping every
 * token for cmd.exe's own metacharacter parser (the standard two-layer CRT
 * + caret algorithm, verified correct against a real cmd.exe for a plain
 * executable target) breaks `%~dp0`-based self-location inside the *nested*
 * cmd.exe invocation a `.cmd` shim triggers (`%~dp0` resolved to the
 * spawned process's cwd instead of the shim's own directory). Node itself
 * also refuses to spawn a `.cmd` directly with `shell: false` (EINVAL) and
 * offers no built-in safe path for this shape. Given a verified-safe
 * alternative exists (install the standalone Codex CLI, which ships a real
 * `codex.exe`), failing closed with an actionable error beats shipping an
 * escape routine that is now known to corrupt some invocations.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ command: string, buildArgs: (execArgs: string[]) => string[], windowsVerbatimArguments: boolean }}
 */
function resolveWindowsCodexInvocation(env) {
  const resolved = classifyCodexOnWindowsPath(env);
  if (resolved?.kind === "exe") {
    return { command: resolved.path, buildArgs: (execArgs) => execArgs, windowsVerbatimArguments: false };
  }

  throw new Error(
    "No codex.exe was found on PATH (only an npm .cmd/.bat shim, or nothing at all). " +
      "The exec transport requires a real codex.exe to invoke it safely without a shell -- " +
      "install the standalone Codex CLI (https://github.com/openai/codex releases) rather than `npm install -g @openai/codex` on Windows."
  );
}

function readOutputFileIfReady(outputPath) {
  try {
    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    return fs.readFileSync(outputPath, "utf8");
  } catch {
    // Not created yet, or a transient read race with codex's own write --
    // either way, "not ready" rather than an error.
    return null;
  }
}

function emitProgress(onProgress, message) {
  if (onProgress && message) {
    onProgress(message);
  }
}

/**
 * Spawns `codex exec`, watches the `-o` file (never the streamed status) for
 * completion, and enforces an external timeout that tree-kills the process
 * on expiry -- codex exec has no native timeout flag and the process can
 * hang after the `-o` file is already written, so process exit is not a
 * trustworthy completion signal either.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{
 *   outputPath: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   spawnImpl?: typeof spawn,
 *   terminateProcessTreeImpl?: typeof terminateProcessTree,
 *   onProgress?: (message: string) => void
 * }} options
 * @returns {Promise<ExecTurnResult>}
 */
function runExecProcess(cwd, args, options) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const terminate = options.terminateProcessTreeImpl ?? terminateProcessTree;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  const env = options.env ?? process.env;
  // POSIX: spawn "codex" directly with shell:false -- Node/execvp already
  // resolves it via PATH with no shell parser involved, so no injection
  // surface exists here. Windows: never combine a shell wrapper with these
  // dynamic args (see resolveWindowsCodexInvocation's docstring for why).
  const invocation =
    process.platform === "win32"
      ? resolveWindowsCodexInvocation(env)
      : { command: "codex", buildArgs: (execArgs) => execArgs, windowsVerbatimArguments: false };

  const child = spawnImpl(invocation.command, invocation.buildArgs(args), {
    cwd,
    env,
    // stdin "ignore" reads as immediate EOF, closing it before codex can
    // block on "Reading additional input from stdin..." (verified-facts
    // point 1). The prompt travels as a positional arg instead.
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  let threadId = null;
  let turnEvent = null;
  let lines = null;
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      // These two event types are structural stream markers, not the
      // schema-coerced assistant message content F5 warns about -- they are
      // only ever used here for metadata (thread/turn ids), never to decide
      // that the turn is finished.
      if (message.type === "thread.started" && !threadId) {
        threadId = message.thread_id ?? message.threadId ?? null;
      } else if (message.type === "turn.completed") {
        turnEvent = message;
      }
    });
  }

  emitProgress(options.onProgress, "Starting codex exec turn.");

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let exited = false;

    function buildResult({ status, finalMessage, error }) {
      return {
        status,
        threadId,
        turnId: turnEvent?.turn_id ?? turnEvent?.turnId ?? null,
        finalMessage: finalMessage ?? "",
        reasoningSummary: [],
        turn: turnEvent,
        error: error ?? null,
        stderr: stderr.trim(),
        fileChanges: [],
        touchedFiles: [],
        commandExecutions: []
      };
    }

    function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      lines?.close();
      resolve(result);
    }

    pollTimer = setInterval(() => {
      const content = readOutputFileIfReady(options.outputPath);
      if (content === null) {
        return;
      }
      // The -o file is the completion signal on its own; do not wait on
      // process exit, which verified-facts documents as sometimes hanging
      // after the file is already written. Best-effort tree-kill any
      // process still alive once we already have our answer.
      if (!exited) {
        try {
          terminate(child.pid);
        } catch {
          // Best-effort cleanup; the outcome below does not depend on it.
        }
      }
      emitProgress(options.onProgress, "codex exec turn finished.");
      settle(buildResult({ status: 0, finalMessage: content }));
    }, pollIntervalMs);

    timeoutTimer = setTimeout(() => {
      let terminationOutcome = null;
      let terminationError = null;
      try {
        terminationOutcome = terminate(child.pid);
      } catch (err) {
        terminationError = err;
      }
      // Do not claim "terminated" unless terminateProcessTree actually
      // reports delivery -- e.g. a nested-process taskkill failure ("could
      // not be terminated: operation attempted is not supported") must
      // surface, not be papered over by an optimistic message.
      const delivered = terminationOutcome?.delivered === true;
      const terminationDetail = delivered
        ? "and was terminated"
        : `but termination was not confirmed delivered (${
            terminationError ? terminationError.message : JSON.stringify(terminationOutcome)
          })`;
      settle(
        buildResult({
          status: 1,
          finalMessage: "",
          error: new Error(`codex exec timed out after ${timeoutMs}ms ${terminationDetail}.`)
        })
      );
    }, timeoutMs);

    child.on("error", (error) => {
      try {
        terminate(child.pid);
      } catch {
        // Best-effort cleanup; the error result below stands regardless.
      }
      settle(buildResult({ status: 1, finalMessage: "", error }));
    });

    child.on("exit", () => {
      exited = true;
      // One last read in case exit raced the poll tick.
      const content = readOutputFileIfReady(options.outputPath);
      if (content !== null) {
        settle(buildResult({ status: 0, finalMessage: content }));
        return;
      }
      settle(
        buildResult({
          status: 1,
          finalMessage: "",
          error: new Error("codex exec exited without writing an output-last-message file.")
        })
      );
    });
  });
}

/**
 * Runs one turn via `codex exec`. Returns the same shape as
 * runAppServerTurn(cwd, options) in codex.mjs, but the fields are only as
 * rich as the exec CLI's headless output actually is:
 *   - `turn` is the raw `turn.completed` JSONL event object (whatever shape
 *     that codex version emits), NOT the structured `Turn` RPC object
 *     runAppServerTurn returns -- do not rely on a specific schema for it.
 *   - `reasoningSummary`, `fileChanges`, `touchedFiles`, and
 *     `commandExecutions` are always empty arrays. `codex exec --json`'s
 *     JSONL stream is only consulted here for `thread.started`/
 *     `turn.completed` metadata (never trusted for completion, see the
 *     module doc comment); it is not parsed for reasoning or file-change
 *     items the way the app-server path's turn/item notifications are.
 * @param {string} cwd
 * @param {{
 *   prompt?: string,
 *   defaultPrompt?: string,
 *   model?: string,
 *   effort?: string,
 *   sandbox?: string,
 *   profile?: string,
 *   outputSchema?: Record<string, unknown> | null,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   spawnImpl?: typeof spawn,
 *   terminateProcessTreeImpl?: typeof terminateProcessTree,
 *   onProgress?: (message: string) => void
 * }} [options]
 * @returns {Promise<ExecTurnResult>}
 */
export async function runExecTurn(cwd, options = {}) {
  const availability = getExecAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Codex run.");
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exec-"));
  const outputPath = path.join(scratchDir, "last-message.txt");
  let schemaPath = null;
  if (options.outputSchema) {
    schemaPath = path.join(scratchDir, "output-schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify(options.outputSchema), "utf8");
  }

  const args = buildExecArgs(prompt, outputPath, {
    schemaPath,
    profile: options.profile,
    model: options.model,
    effort: options.effort,
    cwd,
    sandbox: options.sandbox
  });

  try {
    return await runExecProcess(cwd, args, { ...options, outputPath });
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
