import fs from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { processHasLaunchToken, terminateProcessTree, waitForProcessExit } from "./process.mjs";
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

export async function sendBrokerShutdown(endpoint, options = {}) {
  return await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let settled = false;
    let buffer = "";
    const finish = (result = null) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs ?? 2000, finish);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id: 1,
        method: "broker/shutdown",
        params: { instanceToken: options.instanceToken ?? null }
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex));
        finish({ result: response?.result ?? null, error: response?.error ?? null });
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

function isValidPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

async function waitForBrokerExit(endpoint, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 25;
  const target = parseBrokerEndpoint(endpoint);
  const start = Date.now();
  let unavailableChecks = 0;
  while (Date.now() - start < timeoutMs) {
    if (target.kind === "unix") {
      if (!fs.existsSync(target.path)) {
        return true;
      }
    } else if (await isBrokerEndpointReady(endpoint)) {
      unavailableChecks = 0;
    } else {
      unavailableChecks += 1;
      if (unavailableChecks >= 3) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return target.kind === "unix" ? !fs.existsSync(target.path) : !(await isBrokerEndpointReady(endpoint));
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, instanceToken, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [
    scriptPath,
    "serve",
    "--endpoint",
    endpoint,
    "--cwd",
    cwd,
    "--pid-file",
    pidFile,
    "--instance-token",
    instanceToken
  ], {
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

function resolveBrokerPid(session) {
  const statePid = isValidPid(session.pid) ? session.pid : null;
  let filePid = null;
  if (session.pidFile && fs.existsSync(session.pidFile)) {
    const rawPid = fs.readFileSync(session.pidFile, "utf8").trim();
    if (/^\d+$/.test(rawPid)) {
      const parsedPid = Number(rawPid);
      filePid = isValidPid(parsedPid) ? parsedPid : null;
    }
  }
  if (statePid && filePid && statePid !== filePid) {
    throw new Error(`Codex app-server broker PID mismatch (${statePid} != ${filePid}).`);
  }
  return statePid ?? filePid;
}

export async function shutdownBrokerSession(cwd, options = {}) {
  const session = options.session ?? loadBrokerSession(cwd);
  if (!session) {
    return { found: false, exited: true, forced: false };
  }

  const pid = resolveBrokerPid(session);
  if (session.endpoint && !session.instanceToken) {
    throw new Error("Codex app-server broker ownership could not be verified; persisted state was preserved.");
  }
  let shutdownResponse = null;
  if (session.endpoint) {
    shutdownResponse = await sendBrokerShutdown(session.endpoint, {
      timeoutMs: options.timeoutMs,
      instanceToken: session.instanceToken
    });
  }
  if (shutdownResponse?.error) {
    throw new Error(
      `Codex app-server broker rejected shutdown identity; persisted state was preserved: ${shutdownResponse.error.message ?? "unknown error"}`
    );
  }
  const shutdownAck = shutdownResponse?.result ?? null;

  const acknowledgedPid = isValidPid(shutdownAck?.pid) ? shutdownAck.pid : null;
  const ownershipVerified =
    Boolean(session.instanceToken) &&
    shutdownAck?.instanceToken === session.instanceToken &&
    acknowledgedPid !== null &&
    (pid === null || pid === acknowledgedPid);
  if (shutdownAck && session.instanceToken && !ownershipVerified) {
    throw new Error("Codex app-server broker shutdown identity did not match persisted state.");
  }
  let verifiedPid = ownershipVerified ? acknowledgedPid : null;
  let pidAlreadyExited = false;
  if (isValidPid(pid)) {
    pidAlreadyExited = await waitForProcessExit(pid, {
      timeoutMs: 0,
      intervalMs: options.intervalMs,
      killImpl: options.killImpl,
      platform: options.platform
    });
  }
  if (!shutdownAck && isValidPid(pid) && !pidAlreadyExited) {
    const ownsPersistedProcess = options.verifyProcess
      ? options.verifyProcess(pid, session.instanceToken)
      : processHasLaunchToken(pid, session.instanceToken, {
          marker: "--instance-token",
          platform: options.platform,
          timeoutMs: options.timeoutMs,
          runCommandImpl: options.runCommandImpl
        });
    if (!ownsPersistedProcess) {
      pidAlreadyExited = await waitForProcessExit(pid, {
        timeoutMs: 0,
        intervalMs: options.intervalMs,
        killImpl: options.killImpl,
        platform: options.platform
      });
      if (!pidAlreadyExited) {
        throw new Error("Codex app-server broker ownership could not be verified; persisted state was preserved.");
      }
    } else {
      verifiedPid = pid;
    }
  }
  if (!shutdownAck && session.instanceToken && !isValidPid(pid)) {
    throw new Error("Codex app-server broker PID is unavailable; persisted ownership state was preserved.");
  }

  let exited = pidAlreadyExited
    ? true
    : isValidPid(verifiedPid)
    ? await waitForProcessExit(verifiedPid, {
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        killImpl: options.killImpl,
        platform: options.platform
      })
    : session.endpoint
      ? await waitForBrokerExit(session.endpoint, {
          timeoutMs: options.timeoutMs,
          intervalMs: options.intervalMs
        })
      : false;
  let forced = false;

  if (!exited && isValidPid(verifiedPid) && options.killProcess) {
    const stillOwnsProcess = options.verifyProcess
      ? options.verifyProcess(verifiedPid, session.instanceToken)
      : processHasLaunchToken(verifiedPid, session.instanceToken, {
          marker: "--instance-token",
          platform: options.platform,
          timeoutMs: options.timeoutMs,
          runCommandImpl: options.runCommandImpl
        });
    if (!stillOwnsProcess) {
      throw new Error("Codex app-server broker process ownership changed before forced shutdown.");
    }
    options.killProcess(verifiedPid);
    forced = true;
    exited = await waitForProcessExit(verifiedPid, {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      killImpl: options.killImpl,
      platform: options.platform
    });
  }

  if (!exited) {
    throw new Error(`Codex app-server broker ${verifiedPid ?? session.endpoint ?? "unknown"} did not exit.`);
  }

  teardownBrokerSession({
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid
  });
  clearBrokerSession(cwd);
  return { found: true, exited: true, forced };
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
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    await shutdownBrokerSession(cwd, {
      session: existing,
      killProcess: options.killProcess ?? terminateProcessTree,
      verifyProcess: options.verifyProcess,
      runCommandImpl: options.runCommandImpl,
      killImpl: options.killImpl,
      platform: options.platform,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs
    });
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const instanceToken = options.instanceToken ?? randomUUID();

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    instanceToken,
    env: options.env ?? process.env
  });

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    instanceToken
  };
  saveBrokerSession(cwd, session);

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    await shutdownBrokerSession(cwd, {
      session,
      killProcess: options.killProcess ?? terminateProcessTree,
      verifyProcess: options.verifyProcess,
      runCommandImpl: options.runCommandImpl,
      killImpl: options.killImpl,
      platform: options.platform,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs
    });
    return null;
  }

  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (isValidPid(pid) && killProcess) {
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
