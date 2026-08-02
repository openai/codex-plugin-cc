import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// taskkill's exit code for "no such process". Locale-independent, unlike the message
// text: on a non-English Windows the "not found" wording is translated and the regex
// above never matches, so an already-dead pid would surface as a thrown error.
const TASKKILL_PROCESS_NOT_FOUND = 128;

// On Windows runCommand spawns through $SHELL, which is Git Bash when Claude Code runs
// from it. MSYS then rewrites taskkill's `/PID` flag into a path (`C:/Program Files/Git/PID`)
// and the call fails. Disable the conversion for this child only -- setting it on the
// node process itself would break the `/c/...` paths node needs to resolve.
function envWithoutMsysPathConversion(env) {
  return {
    ...(env ?? process.env),
    MSYS_NO_PATHCONV: "1",
    MSYS2_ARG_CONV_EXCL: "*"
  };
}

// Signal 0 tests for existence without touching the process. EPERM means it is alive
// under another owner, so anything but ESRCH counts as still running.
function processIsGone(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// A process that is already on its way out -- taskkill losing the race with a turn that
// was just interrupted reports "Access is denied", exit 1 -- is still briefly alive, so a
// single instantaneous probe calls it a failure. Give it a bounded moment to finish.
// This whole function is synchronous, hence the Atomics sleep rather than a timer.
function waitForProcessGone(pid, killImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    if (processIsGone(pid, killImpl)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    Atomics.wait(idle, 0, 0, Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, treeConfirmed: true, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: envWithoutMsysPathConversion(options.env)
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, treeConfirmed: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (
      !result.error &&
      (result.status === TASKKILL_PROCESS_NOT_FOUND || looksLikeMissingProcessMessage(combinedOutput))
    ) {
      // "No such process" is about the root at this instant, not about what it spawned
      // while it was alive. A worker that died mid-turn leaves its `codex app-server`
      // child orphaned, and with the root gone `/T` has nothing left to walk from. That
      // is not a corner case here: `cancel` only reaches this branch for a job the state
      // still calls running, which is exactly the crashed-worker case.
      return { attempted: true, delivered: false, treeConfirmed: false, method: "taskkill", result };
    }

    // taskkill exits non-zero both after failing to reap a descendant ("The operation
    // attempted is not supported", 255) and when it races a root that was already
    // terminating ("Access is denied", 1 -- what `cancel` hits after interrupting the
    // turn). Both messages are localized, so the root's own liveness is the only usable
    // signal: it is gone, and the kill should not throw for either case.
    //
    // But a non-zero taskkill never establishes that the REST of the tree went with it,
    // and `/T` leaves no way to enumerate what survived once the root is gone. So the
    // two facts are reported separately -- `delivered` is about the target, and
    // `treeConfirmed` is about everything under it. Like the missing-root branch above,
    // this one cannot account for the whole tree.
    if (!result.error && waitForProcessGone(pid, killImpl, options.killWaitMs ?? 1000)) {
      return { attempted: true, delivered: true, treeConfirmed: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, treeConfirmed: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, treeConfirmed: true, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, treeConfirmed: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, treeConfirmed: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, treeConfirmed: true, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, treeConfirmed: true, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
