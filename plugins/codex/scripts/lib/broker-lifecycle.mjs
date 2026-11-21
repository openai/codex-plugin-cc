import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateRoot } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_DIR = "broker.lock";
const DEFAULT_BROKER_STARTUP_TIMEOUT_MS = 20_000;
const BROKER_LOCK_POLL_MS = 50;

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

function resolveBrokerStateDir(env = process.env) {
  return resolveStateRoot(env);
}

function resolveBrokerStateFile(env = process.env) {
  return path.join(resolveBrokerStateDir(env), BROKER_STATE_FILE);
}

function resolveBrokerLockDir(env = process.env) {
  return path.join(resolveBrokerStateDir(env), BROKER_LOCK_DIR);
}

export function loadBrokerSession(_cwd, env = process.env) {
  const stateFile = resolveBrokerStateFile(env);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(_cwd, session, env = process.env) {
  const stateDir = resolveBrokerStateDir(env);
  const stateFile = resolveBrokerStateFile(env);
  fs.mkdirSync(stateDir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, stateFile);
}

export function clearBrokerSession(_cwd, env = process.env) {
  const stateFile = resolveBrokerStateFile(env);
  try {
    fs.unlinkSync(stateFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

function releaseBrokerLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore missing or already-removed lock directories.
  }
}

async function acquireBrokerLock(cwd, env, timeoutMs) {
  const stateDir = resolveBrokerStateDir(env);
  const lockDir = resolveBrokerLockDir(env);
  const staleLockMs = Math.max(timeoutMs, 30_000);
  fs.mkdirSync(stateDir, { recursive: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      fs.mkdirSync(lockDir);
      return { acquired: true, lockDir, session: null };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existing = loadBrokerSession(cwd, env);
    if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
      return { acquired: false, lockDir, session: existing };
    }

    try {
      const stats = fs.statSync(lockDir);
      if (Date.now() - stats.mtimeMs > staleLockMs) {
        releaseBrokerLock(lockDir);
        continue;
      }
    } catch {
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, BROKER_LOCK_POLL_MS));
  }

  const existing = loadBrokerSession(cwd, env);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return { acquired: false, lockDir, session: existing };
  }
  return { acquired: false, lockDir, session: null };
}

export async function ensureBrokerSession(cwd, options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROKER_STARTUP_TIMEOUT_MS;

  const existing = loadBrokerSession(cwd, env);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  const lock = await acquireBrokerLock(cwd, env, timeoutMs);
  if (!lock.acquired) {
    return lock.session;
  }

  try {
    const lockedExisting = loadBrokerSession(cwd, env);
    if (lockedExisting && (await isBrokerEndpointReady(lockedExisting.endpoint))) {
      return lockedExisting;
    }

    if (lockedExisting) {
      teardownBrokerSession({
        endpoint: lockedExisting.endpoint ?? null,
        pidFile: lockedExisting.pidFile ?? null,
        logFile: lockedExisting.logFile ?? null,
        sessionDir: lockedExisting.sessionDir ?? null,
        pid: lockedExisting.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd, env);
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
      env
    });

    const ready = await waitForBrokerEndpoint(endpoint, timeoutMs);
    if (!ready) {
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null
    };
    saveBrokerSession(cwd, session, env);
    return session;
  } finally {
    releaseBrokerLock(lock.lockDir);
  }
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
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Ignore busy or already-removed pid files during teardown.
    }
  }

  if (logFile && fs.existsSync(logFile)) {
    try {
      fs.unlinkSync(logFile);
    } catch {
      // Ignore busy or already-removed log files during teardown.
    }
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
