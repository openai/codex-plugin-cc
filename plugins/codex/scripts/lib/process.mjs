import { spawnSync } from "node:child_process";
import process from "node:process";

const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function readEnvValue(env, name) {
  const matchingKey = Object.keys(env ?? {}).find((key) => key.toUpperCase() === name.toUpperCase());
  return matchingKey ? env[matchingKey] : undefined;
}

function quotePosixShellArgument(argument) {
  return `'${String(argument).replaceAll("'", `'\\''`)}'`;
}

function quoteCmdShellCommand(command) {
  return String(command).replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

function quoteCmdShellArgument(argument) {
  let quoted = String(argument);

  // Preserve quotes and trailing backslashes when cmd.exe hands this argument
  // to the target process, then protect cmd metacharacters from interpretation.
  quoted = quoted.replace(/(\\*)"/g, (_match, backslashes) => `${backslashes}${backslashes}\\"`);
  quoted = quoted.replace(/(\\+)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

function isCmdShell(shell) {
  return shell === true || /(?:^|[\\/])cmd(?:\.exe)?$/i.test(String(shell));
}

function isPowerShell(shell) {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(String(shell));
}

function preparePowerShellShimCommand(command, args, shell = "powershell.exe") {
  const payload = Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
  const script = [
    `$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    "$spec = $json | ConvertFrom-Json",
    "$name = [string]$spec.command",
    "$launcher = Get-Command ($name + '.exe') -CommandType Application -ErrorAction SilentlyContinue",
    "if (-not $launcher) { $launcher = Get-Command ($name + '.ps1') -CommandType ExternalScript -ErrorAction Stop }",
    "$launchArgs = @($spec.args)",
    "& $launcher.Source @launchArgs",
    "exit $LASTEXITCODE"
  ].join("; ");

  return {
    command: shell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    shell: false
  };
}

/**
 * Builds a spawn invocation that preserves argv boundaries when Windows needs
 * a shell to launch command shims such as codex.cmd and npm.cmd.
 */
export function prepareSpawnCommand(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const env = options.env ?? process.env;
  const configuredShell = options.shell ?? readEnvValue(env, "SHELL") ?? readEnvValue(process.env, "SHELL") ?? true;
  if (!configuredShell) {
    return { command, args: [...args], shell: false };
  }

  if (isPowerShell(configuredShell)) {
    return preparePowerShellShimCommand(command, args, configuredShell);
  }

  // cmd.exe expands %NAME% before it processes caret escapes, so percent signs
  // cannot be safely embedded in its command string. Standard npm installs
  // provide a PowerShell shim alongside the .cmd shim; send argv as base64 JSON
  // and splat the decoded values so no user content is parsed as shell source.
  if (isCmdShell(configuredShell) && [command, ...args].some((value) => String(value).includes("%"))) {
    return preparePowerShellShimCommand(command, args);
  }

  const commandLine = isCmdShell(configuredShell)
    ? [quoteCmdShellCommand(command), ...args.map(quoteCmdShellArgument)].join(" ")
    : [command, ...args].map(quotePosixShellArgument).join(" ");

  // Pass a single, fully quoted command string. Node otherwise joins a command
  // and args with spaces before handing them to the shell, losing argv bounds.
  return { command: commandLine, args: [], shell: configuredShell };
}

export function runCommand(command, args = [], options = {}) {
  const invocation = prepareSpawnCommand(command, args, { env: options.env, shell: options.shell });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: invocation.shell,
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
