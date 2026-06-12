import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
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

// Keep in sync with BROKER_BUSY_RPC_CODE in lib/app-server.mjs (importing it
// here would create a circular dependency: app-server.mjs imports this module).
const BROKER_BUSY_RPC_CODE = -32001;

/**
 * Probe whether the broker is currently serving a request or streaming turn.
 * Uses the `broker/status` RPC (answered before the busy gate). Brokers from
 * older plugin versions don't implement it: when busy their gate rejects the
 * probe with BROKER_BUSY_RPC_CODE (busy), and when idle they forward it to the
 * app server which rejects the unknown method (idle) — both interpretable.
 * Timeouts are treated as busy so an unresponsive broker is never killed
 * mid-turn by account rotation.
 */
export async function isBrokerBusy(endpoint, timeoutMs = 1500) {
  return await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (busy) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(busy);
      }
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/status", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      try {
        const message = JSON.parse(buffer.slice(0, newlineIndex));
        if (message.error) {
          finish(message.error.code === BROKER_BUSY_RPC_CODE);
          return;
        }
        finish(Boolean(message.result?.busy));
      } catch {
        finish(true);
      }
    });
    socket.on("error", () => finish(true));
    socket.on("close", () => finish(true));
  });
}

/**
 * Ask the broker to shut down. With `ifIdle: true` the broker refuses when a
 * request/stream is in flight (atomic with its busy state — see
 * app-server-broker.mjs); the promise then resolves `false`. Resolves `true`
 * when the broker shut down (or on legacy brokers that ignore the param and
 * reply with an empty result).
 */
export async function sendBrokerShutdown(endpoint, { ifIdle = false } = {}) {
  return await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (didShutdown) => {
      if (!settled) {
        settled = true;
        socket.end();
        resolve(didShutdown);
      }
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const params = ifIdle ? { ifIdle: true } : {};
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      try {
        const message = JSON.parse(buffer.slice(0, newlineIndex));
        finish(message.result?.shutdown !== false);
      } catch {
        finish(true);
      }
    });
    socket.on("error", () => finish(true));
    socket.on("close", () => finish(true));
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

export async function ensureBrokerSession(cwd, options = {}) {
  // Account-aware reuse: the broker (and the `codex app-server` it manages)
  // inherits CODEX_HOME once, at spawn time, so a live broker started under one
  // account would otherwise silently serve every later call in this workspace —
  // ignoring the caller's CODEX_HOME and breaking multi-account fallback.
  // When the caller's CODEX_HOME differs from the one the session was created
  // with, shut the old broker down gracefully and start a fresh one.
  const desiredCodexHome = (options.env ?? process.env).CODEX_HOME ?? "";
  const existing = loadBrokerSession(cwd);
  const existingReady = existing ? await isBrokerEndpointReady(existing.endpoint) : false;
  if (existing && existingReady && (existing.codexHome ?? "") === desiredCodexHome) {
    return existing;
  }

  if (existing) {
    if (existingReady && (existing.codexHome ?? "") !== desiredCodexHome) {
      // Never kill in-flight work on account rotation. The probe also covers
      // legacy brokers (their busy gate rejects it with BROKER_BUSY_RPC_CODE);
      // the `ifIdle` shutdown closes the probe→shutdown race on current
      // brokers (a turn that starts in between makes the broker refuse).
      // On either busy signal: return null so this call falls back to a
      // directly spawned app server with the caller's env, and the rotation
      // happens on the next call that finds the broker idle.
      if (await isBrokerBusy(existing.endpoint)) {
        return null;
      }
      const didShutdown = await sendBrokerShutdown(existing.endpoint, { ifIdle: true });
      if (!didShutdown) {
        return null;
      }
    }
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
    pid: child.pid ?? null,
    codexHome: desiredCodexHome
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
