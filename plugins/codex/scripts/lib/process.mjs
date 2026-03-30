import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

function quoteCmdArg(value) {
  const text = String(value ?? "");
  if (!text) {
    return '""';
  }
  const escaped = text.replace(/"/g, '""');
  return /[\s"&()^<>|]/.test(escaped) ? `"${escaped}"` : escaped;
}

function buildCmdCommandLine(command, args = []) {
  return [quoteCmdArg(command), ...args.map((arg) => quoteCmdArg(arg))].join(" ");
}

function rankWindowsCommandCandidate(candidate) {
  switch (path.extname(candidate).toLowerCase()) {
    case ".cmd":
      return 0;
    case ".bat":
      return 1;
    case ".exe":
      return 2;
    case ".com":
      return 3;
    case ".ps1":
      return 4;
    default:
      return 10;
  }
}

function resolveWindowsCommand(command, env) {
  if (/[\\/]/.test(command) || path.isAbsolute(command)) {
    return { command, wrapper: null };
  }

  const whereResult = spawnSync("where.exe", [command], {
    env,
    encoding: "utf8",
    windowsHide: true
  });

  if (whereResult.error || whereResult.status !== 0) {
    return { command, wrapper: null };
  }

  const candidates = whereResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => rankWindowsCommandCandidate(left) - rankWindowsCommandCandidate(right));

  const resolved = candidates[0] ?? command;
  const extension = path.extname(resolved).toLowerCase();
  return {
    command: resolved,
    wrapper: extension === ".cmd" || extension === ".bat" ? "cmd" : null
  };
}

function prepareCommand(command, args = [], env = process.env) {
  if (process.platform !== "win32") {
    return { command, args, windowsHide: false };
  }

  const resolved = resolveWindowsCommand(command, env);
  if (resolved.wrapper === "cmd") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdCommandLine(resolved.command, args)],
      windowsHide: true
    };
  }

  return {
    command: resolved.command,
    args,
    windowsHide: true
  };
}

export function spawnCommand(command, args = [], options = {}) {
  const prepared = prepareCommand(command, args, options.env);
  return spawn(prepared.command, prepared.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? "pipe",
    detached: options.detached ?? false,
    windowsHide: options.windowsHide ?? prepared.windowsHide
  });
}

export function runCommand(command, args = [], options = {}) {
  const prepared = prepareCommand(command, args, options.env);
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: options.windowsHide ?? prepared.windowsHide
  });

  return {
    command: prepared.command,
    args: prepared.args,
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

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
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
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
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
