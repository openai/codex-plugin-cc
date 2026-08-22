import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolves `command` to a concrete file path on Windows, so it can be
 * spawned with `shell: false` instead of a shell string. `spawn`/`spawnSync`
 * never consult `PATHEXT` themselves, so a bare command that only exists as
 * an extensionless/`.cmd` shim (e.g. an npm-installed CLI) fails with ENOENT
 * unless something else resolves it first (#287) -- but handing
 * `process.env.SHELL` to `shell:` as a quick fix means Node hands the whole
 * command line to whatever that variable points at, unescaped for that
 * shell's own quoting rules. When it happens to be PowerShell, a `>` from
 * quoted source text is read as a redirect and creates junk files in the
 * repo (#643). Resolving to the literal file sidesteps a caller-supplied
 * shell entirely: Node still wraps a resolved `.cmd`/`.bat` target through
 * cmd.exe internally when needed (hardened by the CVE-2024-27980 fix), but
 * never asks an arbitrary shell to reinterpret a raw command string.
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
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";
  const pathExtEnv = options.pathExtEnv ?? process.env.PATHEXT ?? DEFAULT_PATHEXT;

  const dirs = pathEnv.split(win.delimiter).filter(Boolean);
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

export function runCommand(command, args = [], options = {}) {
  const resolvedCommand = resolveExecutablePath(command, {
    platform: options.platform,
    existsSync: options.existsSync,
    pathEnv: options.pathEnv,
    pathExtEnv: options.pathExtEnv
  });

  const result = spawnSync(resolvedCommand, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
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
