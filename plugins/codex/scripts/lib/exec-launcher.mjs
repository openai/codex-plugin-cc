import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand, terminateProcessTree } from "./process.mjs";
import { acquireWorkloadLease } from "./scheduler.mjs";

export const TIMED_OUT_EXIT_CODE = 124;
const DEFAULT_EXEC_TIMEOUT_MS = 1800000;
const DEFAULT_QUEUE_WAIT_MS = 900000;
const DEFAULT_KILL_GRACE_MS = 10000;

function forceKill(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function isInsideGitWorktree(cwd) {
  const result = runCommand("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * Build the argument list for one `codex exec` run. `--skip-git-repo-check` is
 * decided here so no caller has to remember when Codex needs it.
 */
export function buildCodexExecArgs(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const skipGitRepoCheck = options.skipGitRepoCheck ?? !isInsideGitWorktree(cwd);
  const args = ["exec"];
  if (skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  args.push("-s", options.sandbox ?? "read-only");
  if (options.effort) {
    args.push("-c", `model_reasoning_effort=${options.effort}`);
  }
  for (const extra of options.extraArgs ?? []) {
    args.push(extra);
  }
  if (options.outputFile) {
    args.push("-o", options.outputFile);
  }
  // The prompt arrives on a pipe this process owns and closes, so the child sees
  // EOF immediately and never waits on an inherited terminal.
  args.push("-");
  return { args, skipGitRepoCheck };
}

/** Signals must never be normalized into a successful exit. */
export function normalizeExitCode(code, signal) {
  if (typeof code === "number") {
    return code;
  }
  if (!signal) {
    return 0;
  }
  const signalNumber = os.constants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 128;
}

export function describeExecOutcome(result) {
  if (result.timedOut) {
    return `Codex was interrupted after its ${result.timeoutMs}ms deadline expired.`;
  }
  if (result.signal) {
    return `Codex was terminated by ${result.signal} (exit ${result.exitCode}).`;
  }
  if (result.exitCode !== 0) {
    return `Codex exited with code ${result.exitCode}.`;
  }
  return "Codex completed.";
}

function spawnCodexExec({ command, args, cwd, env, logFd, timeoutMs, killGraceMs, stdinText }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command ?? "codex", args, {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", logFd, logFd],
      // Own process group: the deadline can terminate the whole Codex tree, and
      // a signal aimed at the parent shell does not take the run down with it.
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid ?? Number.NaN);
      // A SIGTERM-resistant child must not outlive its deadline.
      killTimer = setTimeout(() => {
        forceKill(child);
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        exitCode: timedOut ? TIMED_OUT_EXIT_CODE : normalizeExitCode(code, signal),
        signal: signal ?? null,
        timedOut
      });
    });

    // stdin is a pipe this process owns and closes immediately.
    child.stdin.on("error", () => {});
    child.stdin.end(stdinText ?? "");
  });
}

/**
 * Run a prepared `codex exec` argument list under the global queue and a
 * deadline. Callers that need their own argument shape (collab's resume form,
 * for example) use this; everything else uses runHardenedCodexExec.
 */
export async function runQueuedCodexExec(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_EXEC_TIMEOUT_MS;
  const killGraceMs = Number(options.killGraceMs) > 0 ? Number(options.killGraceMs) : DEFAULT_KILL_GRACE_MS;
  const logFile = options.logFile;
  if (!logFile) {
    throw new Error("runQueuedCodexExec requires a logFile for the transcript.");
  }

  const lease = await acquireWorkloadLease({
    jobId: options.jobId ?? `exec-${process.pid}`,
    kind: options.kind ?? "codex-exec",
    workspace: cwd,
    schedulerDir: options.schedulerDir,
    env: options.env,
    timeoutMs,
    waitTimeoutMs: Number(options.queueWaitMs) > 0 ? Number(options.queueWaitMs) : DEFAULT_QUEUE_WAIT_MS,
    noWait: Boolean(options.noWait)
  });

  const startedAt = Date.now();
  const logFd = fs.openSync(logFile, options.appendLog === false ? "w" : "a");
  try {
    const outcome = await spawnCodexExec({
      command: options.command,
      args: options.args ?? [],
      cwd,
      env: options.env,
      logFd,
      timeoutMs,
      killGraceMs,
      stdinText: options.stdinText
    });
    return {
      ...outcome,
      timeoutMs,
      cwd,
      logFile,
      durationMs: Date.now() - startedAt,
      queueWaitMs: lease.queueWaitMs
    };
  } finally {
    fs.closeSync(logFd);
    lease.release();
  }
}

/**
 * The single blessed way for plugin code to launch `codex exec`:
 * prompt from a file, stdin never inherited, one global queue slot, an execution
 * deadline, and separate final-answer and transcript files.
 */
export async function runHardenedCodexExec(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const promptFile = options.promptFile;
  if (!promptFile || !fs.existsSync(promptFile)) {
    throw new Error(`A readable --prompt-file is required; ${promptFile ?? "none"} was not found.`);
  }
  const prompt = fs.readFileSync(promptFile, "utf8");
  const logFile = options.logFile ?? path.join(path.dirname(promptFile), "run.log");
  const outputFile = options.outputFile ?? path.join(path.dirname(promptFile), "final.md");
  const { args, skipGitRepoCheck } = buildCodexExecArgs({ ...options, cwd, outputFile });

  const outcome = await runQueuedCodexExec({
    ...options,
    cwd,
    args,
    logFile,
    stdinText: prompt
  });

  const finalOutput = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
  return {
    ...outcome,
    skipGitRepoCheck,
    promptFile,
    outputFile,
    finalOutput
  };
}
