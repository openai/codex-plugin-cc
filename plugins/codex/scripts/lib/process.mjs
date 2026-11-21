import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function readEnvCaseInsensitive(env, targetName) {
  if (!env || typeof env !== "object") {
    return "";
  }
  if (typeof env[targetName] === "string" && env[targetName].trim()) {
    return env[targetName].trim();
  }
  const lowerTarget = targetName.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowerTarget && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export function isPowerShellPath(shellValue) {
  if (typeof shellValue !== "string") {
    return false;
  }
  const normalized = shellValue.trim().replace(/^["']+|["']+$/g, "");
  if (!normalized) {
    return false;
  }
  const baseName = normalized.split(/[\\/]/).pop() ?? "";
  return /^(powershell|pwsh)(\.exe)?$/i.test(baseName);
}

export function resolveWindowsShell(env = process.env) {
  const configuredShell = readEnvCaseInsensitive(env, "SHELL");
  if (configuredShell && !isPowerShellPath(configuredShell)) {
    return configuredShell;
  }

  const comSpec = readEnvCaseInsensitive(env, "ComSpec");
  if (comSpec && !isPowerShellPath(comSpec)) {
    return comSpec;
  }

  const systemRoot = readEnvCaseInsensitive(env, "SystemRoot") || readEnvCaseInsensitive(env, "windir");
  if (systemRoot) {
    return path.win32.join(systemRoot, "System32", "cmd.exe");
  }

  return "cmd.exe";
}

export function resolveCommandShell(options = {}) {
  if (options.shell !== undefined) {
    return options.shell;
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }
  return resolveWindowsShell(options.env ?? process.env);
}

export function isShellPolicyRejection(text) {
  const value = String(text ?? "");
  return (
    /PSSecurityException/i.test(value) ||
    /cannot\s+be\s+loaded\s+because\s+running\s+scripts\s+is\s+disabled/i.test(value) ||
    /about_Execution_Policies/i.test(value) ||
    (/UnauthorizedAccess/i.test(value) && /\.ps1\b|execution\s+polic|running\s+scripts/i.test(value))
  );
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: resolveCommandShell(options),
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
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, reason: "not-found", detail: "not found" };
  }
  if (result.error) {
    const detail = result.error.message;
    return {
      available: false,
      reason: isShellPolicyRejection(detail) ? "policy-rejected" : "error",
      detail
    };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return {
      available: false,
      reason: isShellPolicyRejection(detail) ? "policy-rejected" : "error",
      detail
    };
  }
  return { available: true, reason: "ok", detail: result.stdout.trim() || result.stderr.trim() || "ok" };
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
