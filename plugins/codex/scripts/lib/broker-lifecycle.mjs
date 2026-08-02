import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { runCommand, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
// Test-facing override for the broker's idle timeout; the shipped value is in
// app-server-broker.mjs. It lives here because importing that script runs it.
export const BROKER_IDLE_MS_ENV = "CODEX_COMPANION_BROKER_IDLE_MS";
const BROKER_STATE_FILE = "broker.json";
const PROCESS_START_TIME_TIMEOUT_MS = 2000;

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function readProcessStartTime(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  try {
    if (platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fieldsAfterCommand[19] ?? null;
    }

    const runCommandImpl = options.runCommandImpl ?? runCommand;
    const commandOptions = {
      env: options.env,
      shell: false,
      timeout: PROCESS_START_TIME_TIMEOUT_MS
    };
    const result =
      platform === "win32"
        ? runCommandImpl(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
            ],
            commandOptions
          )
        : runCommandImpl(
            // macOS has no finer-grained portable ps start-time field. `lstart` is
            // second-resolution, so PID reuse within the same second remains possible.
            "ps",
            ["-p", String(pid), "-o", "lstart="],
            commandOptions
          );
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function brokerProcessMatchesRecordedStart(existing, options = {}) {
  if (typeof existing.processStartTime !== "string") {
    return false;
  }
  const readProcessStartTimeImpl = options.readProcessStartTime ?? readProcessStartTime;
  try {
    return (
      readProcessStartTimeImpl(existing.pid, {
        env: options.env,
        platform: options.platform,
        runCommandImpl: options.runCommandImpl
      }) === existing.processStartTime
    );
  } catch {
    return false;
  }
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

// A healthy broker answers the first probe immediately, so the second, longer one
// only costs time when the broker is already in trouble. Without it a merely busy
// broker on a loaded host misses 150 ms, gets replaced, and its process is stranded.
async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  for (const timeoutMs of [150, 1000]) {
    try {
      if (await waitForBrokerEndpoint(endpoint, timeoutMs)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export async function ensureBrokerSession(cwd, options = {}) {
  const terminateBrokerProcess =
    options.killProcess ?? options.terminateProcessTreeImpl ?? terminateProcessTree;
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    const brokerPidVerified = brokerProcessMatchesRecordedStart(existing, options);
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      // A pid is safe to target only while its immutable process start time still
      // matches the value recorded when this broker was spawned. Missing, unreadable
      // or mismatched identity skips the kill, but teardown still clears stale files.
      killProcess: brokerPidVerified ? terminateBrokerProcess : null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });
  const readProcessStartTimeImpl = options.readProcessStartTime ?? readProcessStartTime;
  const processStartTime = readProcessStartTimeImpl(child.pid, {
    env: options.env,
    runCommandImpl: options.runCommandImpl
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    // We spawned this one, but the endpoint wait runs out its full timeout even when the
    // child died immediately -- `codex app-server` failing at startup does exactly that --
    // and node reaps the child, so by now the pid can belong to somebody else. A child
    // node still holds open is the one case where the pid is unambiguously ours.
    const childStillRunning = child.exitCode === null && child.signalCode === null;
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: childStillRunning ? terminateBrokerProcess : null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    processStartTime
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
