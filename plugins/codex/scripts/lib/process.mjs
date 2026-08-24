import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Looks up an environment variable by name, case-insensitively. Windows
 * environment variable names are case-insensitive, but a plain JS object
 * (a caller-supplied `options.env`, as opposed to the running process's own
 * `process.env`, which Node already exposes case-insensitively on win32) is
 * not -- `spawn` builds the child's real (case-insensitive) environment
 * block from it regardless of the casing used, so anything reading that
 * same object needs to match by key name, not by one or two guessed
 * casings.
 */
function getEnvValue(env, name) {
  if (!env) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowerName) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * Resolves `command` to a concrete file path on Windows, so its extension
 * can be inspected to decide how it needs to be spawned (see
 * buildSpawnCommand()). `spawn`/`spawnSync` never consult `PATHEXT`
 * themselves, so a bare command that only exists as an extensionless/`.cmd`
 * shim (e.g. an npm-installed CLI) fails with ENOENT unless something else
 * resolves it first (#287).
 *
 * Windows' own CreateProcess searches the current directory before PATH
 * when given a bare command name (documented search sequence: the loading
 * app's directory, then "the current directory for the parent process",
 * then the system/Windows directories, then PATH) -- so `cwd` (the
 * directory the spawned process will actually run from, matching Node's
 * own `spawn`/`spawnSync` `cwd` option) is searched first here too, and
 * any relative PATH entry is resolved against it, to match what running
 * the same bare command from that directory would actually find. Unless
 * `NoDefaultCurrentDirectoryInExePath` is present in the environment (its
 * mere presence disables the lookup, not its value -- this is what
 * cmd.exe/CreateProcess themselves check), in which case `cwd` is skipped
 * entirely: this variable exists specifically so a user or enterprise
 * policy can opt out of current-directory executable lookup to prevent a
 * malicious file dropped into a working directory (e.g. an untrusted repo
 * checkout) from being executed just by resolving a bare command name
 * there.
 */
export function resolveExecutablePath(command, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return command;
  }

  const win = path.win32;
  if (win.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  const cwd = options.cwd ?? process.cwd();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";
  const pathExtEnv = options.pathExtEnv ?? process.env.PATHEXT ?? DEFAULT_PATHEXT;
  const skipCwdLookup = getEnvValue(options.env ?? process.env, "NoDefaultCurrentDirectoryInExePath") !== undefined;

  const pathDirs = pathEnv
    .split(win.delimiter)
    .filter(Boolean)
    .map((dir) => (win.isAbsolute(dir) ? dir : win.resolve(cwd, dir)));
  const dirs = skipCwdLookup ? pathDirs : [cwd, ...pathDirs];

  const extensions = pathExtEnv
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);

  const hasKnownExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const candidateExtensions = hasKnownExtension ? [""] : extensions;

  for (const dir of dirs) {
    for (const ext of candidateExtensions) {
      const candidate = win.join(dir, `${command}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

const EXECUTABLE_EXTENSION_REGEXP = /\.(?:com|exe)$/i;
// Matches cross-spawn's own detection of an npm-generated cmd shim, which
// wraps the real command through its own %~dp0-based cmd.exe redirection --
// meta chars we escape once get interpreted once by that inner layer before
// cmd.exe ever sees them, so they need a second escape pass to survive.
const NPM_CMD_SHIM_REGEXP = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;
// See http://www.robvanderwoude.com/escapechars.php
const CMD_METACHAR_REGEXP = /([()\][%!^"`<>&|;, *?])/g;

// escapeCmdCommand/escapeCmdArgument are ported from cross-spawn
// (https://github.com/moxystudio/node-cross-spawn, MIT License, Copyright
// (c) 2018 Made With MOXY Lda) -- the standard reference implementation for
// safely invoking cmd.exe on Windows. escapeCmdArgument's backslash/quote
// handling is based on https://qntm.org/cmd, cross-spawn's own cited source.
function escapeCmdCommand(value) {
  return value.replace(CMD_METACHAR_REGEXP, "^$1");
}

function escapeCmdArgument(value, doubleEscapeMetaChars) {
  let arg = String(value);

  // Sequence of backslashes followed by a double quote: double up all the
  // backslashes and escape the double quote.
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // Sequence of backslashes followed by the end of the string (which will
  // become a double quote next): double up all the backslashes.
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  // All other backslashes occur literally.

  arg = `"${arg}"`;
  arg = arg.replace(CMD_METACHAR_REGEXP, "^$1");
  if (doubleEscapeMetaChars) {
    arg = arg.replace(CMD_METACHAR_REGEXP, "^$1");
  }

  return arg;
}

/**
 * Given a command already resolved by resolveExecutablePath(), decides how
 * it actually needs to be spawned on Windows and returns the
 * { command, args, windowsVerbatimArguments } to pass to spawn/spawnSync.
 *
 * Node's own docs are explicit that `.bat`/`.cmd` files "are not executable
 * on their own without a terminal" -- spawn()/spawnSync() with
 * shell: false cannot launch them no matter what path is given, resolved
 * or not. Anything that isn't `.exe`/`.com` must instead be launched by
 * explicitly spawning cmd.exe (never a caller- or environment-supplied
 * shell, which is what caused #643) with the command line escaped and
 * quoted the way cmd.exe itself requires.
 */
export function buildSpawnCommand(resolvedCommand, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || EXECUTABLE_EXTENSION_REGEXP.test(resolvedCommand)) {
    return { command: resolvedCommand, args, windowsVerbatimArguments: undefined };
  }

  const needsDoubleEscapeMetaChars = NPM_CMD_SHIM_REGEXP.test(resolvedCommand);
  const escapedCommand = escapeCmdCommand(path.win32.normalize(resolvedCommand));
  const escapedArgs = args.map((arg) => escapeCmdArgument(arg, needsDoubleEscapeMetaChars));
  const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
  const comspec = options.comspec || "cmd.exe";

  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true
  };
}

/**
 * Resolves `command` and decides how to spawn it, in one step. `options.env`
 * (the environment the child will actually run in) is consulted for
 * PATH/PATHEXT/COMSPEC when given, since resolving against the running
 * process's own environment could pick a different executable than the one
 * the child would actually see. `options.cwd` (the directory the child will
 * actually run from) is searched before PATH, matching what running the
 * same bare command from that directory would find.
 */
export function resolveSpawnInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const resolvedCommand = resolveExecutablePath(command, {
    platform,
    existsSync: options.existsSync,
    cwd: options.cwd,
    env: options.env,
    pathEnv: options.pathEnv ?? getEnvValue(options.env, "PATH"),
    pathExtEnv: options.pathExtEnv ?? getEnvValue(options.env, "PATHEXT")
  });

  return buildSpawnCommand(resolvedCommand, args, {
    platform,
    comspec: options.comspec ?? getEnvValue(options.env, "comspec")
  });
}

export function runCommand(command, args = [], options = {}) {
  let spawnCommand = command;
  let spawnArgs = args;
  let windowsVerbatimArguments;

  // An explicit `options.shell` asks for direct control over shell
  // behavior; anything else goes through the safe, resolved invocation.
  if (options.shell === undefined) {
    const invocation = resolveSpawnInvocation(command, args, options);
    spawnCommand = invocation.command;
    spawnArgs = invocation.args;
    windowsVerbatimArguments = invocation.windowsVerbatimArguments;
  }

  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsVerbatimArguments,
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
