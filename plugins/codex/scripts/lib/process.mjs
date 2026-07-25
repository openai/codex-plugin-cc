import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    killSignal: options.killSignal,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    // Preserve Node's spawnSync contract: signal-terminated commands have a
    // null status and a non-null signal.
    status: result.status,
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
  if (result.signal != null || result.status !== 0) {
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
  if (result.signal != null || result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      (result.signal != null ? `signal ${result.signal}` : `exit ${result.status}`);
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function isValidPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function readLinuxProcessStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) {
      return null;
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return {
      state: fields[0] ?? null,
      processGroup: fields[2] ?? null,
      // /proc/<pid>/stat field 22; fields starts at field 3.
      startTime: fields[19] ?? null
    };
  } catch {
    return null;
  }
}

function queryProcessTable(pid, powershellCommand, psFormat, options) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const spawnOptions = {
    timeout: options.timeoutMs ?? 2000,
    killSignal: "SIGTERM",
    // ps -o lstart= renders via the C library's %c, which is locale- and
    // TZ-dependent: the same instant can print differently between the
    // recording and the checking invocation, producing a false mismatch on a
    // still-live broker. Force a fixed, unambiguous rendering. Harmless for
    // the PowerShell path (already UTC ticks) and for command-line reads.
    env: { ...(options.env ?? process.env), LC_ALL: "C", TZ: "UTC" }
  };
  const result =
    (options.platform ?? process.platform) === "win32"
      ? runCommandImpl(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", powershellCommand],
          spawnOptions
        )
      : runCommandImpl("ps", ["-ww", "-p", String(pid), "-o", psFormat], spawnOptions);
  if (result.error || result.signal != null || result.status !== 0) {
    return null;
  }
  return String(result.stdout ?? "");
}

// /proc/<pid>/stat's starttime is in clock ticks since BOOT, not since the
// epoch, so the bare value collides across reboots (a reused pid after a
// reboot can present the same tick count as an earlier, unrelated process).
// Prefixing with the boot id disambiguates across reboots while keeping
// identities comparable within one. Read once and cache for the process
// lifetime -- it cannot change without a reboot, which also invalidates any
// identity recorded before it. Only a SUCCESSFUL read is cached: a transient
// failure (e.g. a sandboxed /proc) must not poison every later call for the
// rest of the process's lifetime -- each subsequent call gets another chance
// to read it.
let cachedBootId;
function bootId() {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return "";
    }
  }
  return cachedBootId;
}

export function getProcessIdentity(pid, options = {}) {
  if (!isValidPid(pid)) {
    return null;
  }
  if ((options.platform ?? process.platform) === "linux") {
    const startTime = readLinuxProcessStat(pid)?.startTime ?? null;
    if (startTime == null) {
      return null;
    }
    const boot = bootId();
    if (!boot) {
      // boot_id unreadable: a raw tick count is boot-relative and would both
      // collide across boots and falsely mismatch against composite values
      // recorded when boot_id WAS readable. Unknown must never masquerade
      // as a comparable identity.
      return null;
    }
    return `${boot}:${startTime}`;
  }
  const output = queryProcessTable(
    pid,
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks) }`,
    "lstart=",
    options
  );
  return output?.trim() || null;
}

export function isProcessRunning(pid, options = {}) {
  if (!isValidPid(pid)) {
    return false;
  }

  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }

  if (platform === "linux") {
    const readProcessStat = options.readProcessStat ?? readLinuxProcessStat;
    const stat = readProcessStat(pid);
    // A null stat means /proc could not be inspected even though kill(pid, 0)
    // proved the process exists. Failure to inspect is not proof of exit or
    // replacement, so stay conservative and keep reporting it as running.
    if (stat) {
      // Zombies still answer kill(pid, 0), but no longer own a live resource.
      if (stat.state === "Z" || stat.state === "X") {
        return false;
      }
      if (options.identity != null) {
        // getProcessIdentity() prefixes Linux identities with the boot id
        // (see its comment); build the same composite here so this direct
        // stat.startTime comparison stays consistent with values recorded
        // through getProcessIdentity(). Only compare when boot_id is
        // currently readable and the composite can actually be formed --
        // a bare tick count is boot-relative and must never be compared
        // directly, which would both collide across boots and falsely
        // mismatch a still-live process against a composite identity
        // recorded when boot_id WAS readable.
        const boot = bootId();
        if (boot) {
          const currentIdentity = `${boot}:${stat.startTime}`;
          if (currentIdentity !== String(options.identity)) {
            return false;
          }
        }
        // boot_id unreadable right now: the comparison cannot be formed, so
        // it proves nothing. Failure to inspect is not proof of replacement.
      }
    }
  } else if (options.identity != null) {
    const currentIdentity = getProcessIdentity(pid, options);
    // Failure to inspect a live process is not proof that it was replaced.
    if (currentIdentity != null && currentIdentity !== String(options.identity)) {
      return false;
    }
  }

  return true;
}

function isLinuxProcessGroupRunning(pid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return isProcessRunning(pid);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const stat = readLinuxProcessStat(Number(entry.name));
    if (
      stat?.processGroup === String(pid) &&
      stat.state !== "Z" &&
      stat.state !== "X"
    ) {
      return true;
    }
  }
  return false;
}

export function isProcessTreeRunning(pid, options = {}) {
  if (!isValidPid(pid)) {
    return false;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return isProcessRunning(pid, options);
  }
  if (options.identity != null) {
    const currentIdentity = getProcessIdentity(pid, options);
    if (currentIdentity != null && currentIdentity !== String(options.identity)) {
      // The pid exists and belongs to a different process. POSIX keeps a group
      // leader's pid reserved while its group still has members, so a confirmed
      // replacement also proves the recorded group is gone.
      return false;
    }
    // An absent or unreadable pid proves nothing about survivors in its group;
    // fall through to the group checks below. In particular, a leader that
    // has already exited (identity now unreadable) must not short-circuit
    // here: its process group can still have live descendants.
  }
  if (platform === "linux" && !options.killImpl) {
    return isLinuxProcessGroupRunning(pid);
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export async function waitForProcessExit(pid, options = {}) {
  if (!isValidPid(pid)) {
    return false;
  }
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 25;
  const isRunning = options.tree === false ? isProcessRunning : isProcessTreeRunning;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid, options)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isRunning(pid, options);
}

function readProcessCommandLine(pid, options) {
  return queryProcessTable(
    pid,
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`,
    "command=",
    options
  );
}

function readLinuxCommandLineArgs(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return null;
  }
}

export function processHasLaunchSequence(pid, expectedArgs, options = {}) {
  if (
    !isValidPid(pid) ||
    !Array.isArray(expectedArgs) ||
    expectedArgs.length === 0 ||
    expectedArgs.some((arg) => typeof arg !== "string" || arg.length === 0)
  ) {
    return false;
  }

  if ((options.platform ?? process.platform) === "linux") {
    const argv = readLinuxCommandLineArgs(pid)?.filter(Boolean);
    if (!argv) {
      return false;
    }
    return argv.some((_, start) =>
      expectedArgs.every((expected, offset) => argv[start + offset] === expected)
    );
  }

  const commandLine = readProcessCommandLine(pid, options);
  if (commandLine == null) {
    return false;
  }
  let cursor = 0;
  for (const expected of expectedArgs) {
    const index = commandLine.indexOf(expected, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + expected.length;
  }
  return true;
}

export function processHasLaunchToken(pid, token, options = {}) {
  if (!isValidPid(pid) || typeof token !== "string" || token.length < 16) {
    return false;
  }

  const marker = options.marker ?? "--worker-token";
  if ((options.platform ?? process.platform) === "linux") {
    const argv = readLinuxCommandLineArgs(pid);
    return argv != null && argv.includes(marker) && argv.includes(token);
  }

  const commandLine = readProcessCommandLine(pid, options);
  if (commandLine == null) {
    return false;
  }
  return commandLine.includes(marker) && commandLine.includes(token);
}

export function terminateProcessTree(pid, options = {}) {
  if (!isValidPid(pid)) {
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
