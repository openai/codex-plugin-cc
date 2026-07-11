import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { withBrokerLock } from "./broker-lock.mjs";
import { probeBroker } from "./broker-probe.mjs";
import { binaryAvailable, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export function resolveBrokerRuntimeIdentity(cwd, env = process.env) {
  const codex = binaryAvailable("codex", ["--version"], { cwd, env });
  return {
    pluginVersion: PLUGIN_MANIFEST.version ?? "0.0.0",
    codexVersion: codex.available ? codex.detail : null
  };
}

export function isBrokerRuntimeCurrent(session, runtime) {
  return (
    session?.runtime?.pluginVersion === runtime.pluginVersion &&
    session?.runtime?.codexVersion === runtime.codexVersion
  );
}

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
  return new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        resolve(!JSON.parse(line.trim()).error);
      } catch {
        resolve(false);
      }
    });
    socket.on("error", () => resolve(false));
    socket.on("close", () => resolve(false));
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

function teardownExistingBroker(cwd, existing, killProcess) {
  teardownBrokerSession({
    endpoint: existing.endpoint ?? null,
    pidFile: existing.pidFile ?? null,
    logFile: existing.logFile ?? null,
    sessionDir: existing.sessionDir ?? null,
    pid: existing.pid ?? null,
    killProcess
  });
  clearBrokerSession(cwd);
}

async function loadReusableBrokerSessionUnlocked(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  const runtime = resolveBrokerRuntimeIdentity(cwd, options.env);
  if (
    existing &&
    isBrokerRuntimeCurrent(existing, runtime) &&
    (await isBrokerEndpointReady(existing.endpoint))
  ) {
    return existing;
  }

  if (existing) {
    if (await isBrokerEndpointReady(existing.endpoint)) {
      const brokerStatus = await probeBroker(existing.endpoint, cwd);
      if (brokerStatus === "busy" && options.allowBusyStaleBroker) {
        return existing;
      }
      if (brokerStatus !== "idle") {
        options.deferBrokerReplacement = true;
        return null;
      }
      if (!(await sendBrokerShutdown(existing.endpoint))) {
        options.deferBrokerReplacement = true;
        return null;
      }
    }
    teardownExistingBroker(cwd, existing, options.killProcess ?? terminateProcessTree);
  }

  return null;
}

export async function loadReusableBrokerSession(cwd, options = {}) {
  return withBrokerLock(cwd, options, () => loadReusableBrokerSessionUnlocked(cwd, options));
}

export async function ensureBrokerSession(cwd, options = {}) {
  return withBrokerLock(cwd, options, async () => {
    const existing = await loadReusableBrokerSessionUnlocked(cwd, options);
    if (existing || options.deferBrokerReplacement) {
      return existing;
    }

    const runtime = resolveBrokerRuntimeIdentity(cwd, options.env);

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
        killProcess: options.killProcess ?? terminateProcessTree
      });
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      runtime
    };
    saveBrokerSession(cwd, session);
    return session;
  });
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
