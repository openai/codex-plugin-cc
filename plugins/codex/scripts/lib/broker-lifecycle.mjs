import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { isProcessAlive } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

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

export async function sendBrokerShutdown(endpoint, { timeoutMs = 1000 } = {}) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", finish);
    socket.on("error", finish);
    socket.on("close", finish);
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

export function clearBrokerSessionIfCurrent(cwd, endpoint) {
  // A replacement may have published its own state since the caller loaded this one.
  const current = loadBrokerSession(cwd);
  if (!current || current.endpoint === endpoint) {
    clearBrokerSession(cwd);
  }
}

export async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

function readLockOwner(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return { text, owner: JSON.parse(text) };
  } catch {
    // Exclusive creation and the owner write are separate steps, so a process that
    // dies between them leaves an empty or partial file.
    return { text, owner: null };
  }
}

function isLockStale(file, owner, maxAgeMs) {
  if (Number.isInteger(owner?.pid) && owner.pid > 0) {
    return !isProcessAlive(owner.pid);
  }
  return Date.now() - fs.statSync(file).mtimeMs > maxAgeMs;
}

function unlinkIfUnchanged(file, text) {
  // Tokens are unique per acquisition, so unchanged text means the same acquisition.
  if (fs.readFileSync(file, "utf8") === text) {
    fs.unlinkSync(file);
  }
}

function removeStaleBrokerLock(lockFile, guardOwner) {
  // Reclaimers serialize on a guard so two of them cannot both act on the same stale lock.
  // The guard is judged by its owner's liveness like the lock is, never by age alone,
  // so a slow but live reclaimer is not revoked.
  const guard = `${lockFile}.reclaim`;
  try {
    fs.writeFileSync(guard, JSON.stringify(guardOwner), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    try {
      const held = readLockOwner(guard);
      if (isLockStale(guard, held.owner, 10000)) {
        unlinkIfUnchanged(guard, held.text);
      }
    } catch (guardError) {
      if (guardError.code !== "ENOENT") {
        throw guardError;
      }
    }
    return;
  }
  try {
    const held = readLockOwner(lockFile);
    if (isLockStale(lockFile, held.owner, 30000)) {
      unlinkIfUnchanged(lockFile, held.text);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  } finally {
    try {
      unlinkIfUnchanged(guard, JSON.stringify(guardOwner));
    } catch {
      // Already removed.
    }
  }
}

function releaseBrokerLock(lockFile, owner) {
  // Only remove a lock we still own; another process may have reclaimed it.
  try {
    if (JSON.parse(fs.readFileSync(lockFile, "utf8")).token === owner.token) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // Already removed or replaced by a reclaiming process.
  }
}

export async function withBrokerLock(cwd, options, fn) {
  // Serialize broker startup, state publication and teardown across processes.
  // Otherwise simultaneous first commands each leave a detached broker behind, and a
  // session-end cleanup can erase a replacement's state.
  const stateFile = resolveBrokerStateFile(cwd);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lockFile = `${stateFile}.lock`;
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + (options.timeoutMs ?? 2000) + 3000;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      removeStaleBrokerLock(lockFile, { pid: process.pid, token: randomUUID() });
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for Codex broker startup lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    releaseBrokerLock(lockFile, owner);
  }
}

export function ensureBrokerSession(cwd, options = {}) {
  return withBrokerLock(cwd, options, () => startBrokerSession(cwd, options));
}

async function startBrokerSession(cwd, options) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
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

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
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
  saveBrokerSession(cwd, session);
  return session;
}

function removeIfPresent(file) {
  // A draining broker removes its own pid file and socket concurrently with a replacement.
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
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

  if (pidFile) {
    removeIfPresent(pidFile);
  }

  if (logFile) {
    removeIfPresent(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        removeIfPresent(target.path);
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
