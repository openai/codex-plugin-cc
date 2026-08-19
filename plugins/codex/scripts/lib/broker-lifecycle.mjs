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

const MANAGED_MARKER_FILE = "broker.managed";

export function createBrokerSessionDir(prefix = "cxc-") {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Persisted ownership record: only directories this plugin created carry the
  // marker, and only marked directories are ever removed recursively (by the
  // reaper below; the broker's own shutdown gets the equivalent signal via
  // --managed-session-dir). A caller-selected directory that merely looks like
  // ours never gains the marker, so it is never deleted.
  fs.writeFileSync(
    path.join(sessionDir, MANAGED_MARKER_FILE),
    "Created by the codex plugin (createBrokerSessionDir); safe to remove recursively.\n",
    "utf8"
  );
  return sessionDir;
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
  // --managed-session-dir: this spawner created the session directory
  // (createBrokerSessionDir's mkdtemp), so the broker may remove the whole
  // directory on clean exit. Manual invocations lack the flag and keep theirs.
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile, "--managed-session-dir"], {
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
      const marker = path.join(resolvedSessionDir, MANAGED_MARKER_FILE);
      if (fs.existsSync(marker)) {
        fs.unlinkSync(marker);
      }
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

function readBrokerPid(sessionDir) {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(sessionDir, "broker.pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null; // reject 0/negative/NaN
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0); // signal 0 only checks existence
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // exists but owned by another user
  }
}

// GC leaked broker session directories. A broker is spawned per working
// directory and reused across sessions, and it now exits itself once idle,
// removing its own directory (see app-server-broker.mjs). This only cleans up
// after a broker that died WITHOUT that clean exit (e.g. it was killed): its
// directory is left behind with a now-dead PID. Deletion requires the
// persisted ownership marker createBrokerSessionDir writes, so a directory
// this plugin did not create (a manual --pid-file location, however named) is
// never removed regardless of what its pid file says. A live PID is never
// inspected or signalled, so this can neither interrupt a session sharing a
// broker nor signal an unrelated process that reused a stale PID. And a
// marked directory whose broker.pid is missing, empty, or unparseable
// (possibly a torn write from a broker still starting up) is left alone
// rather than racing the writer; the cost is that a permanently corrupt pid
// file leaks its (tiny) directory, where the alternative was deleting a live
// broker's socket out from under it.
export async function reapBrokerSessions({ tmpDir = os.tmpdir() } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("cxc-")) {
      continue;
    }
    const sessionDir = path.join(tmpDir, entry.name);
    if (!fs.existsSync(path.join(sessionDir, MANAGED_MARKER_FILE))) {
      continue; // no ownership marker: not created by this plugin, never delete
    }
    if (!fs.existsSync(path.join(sessionDir, "broker.pid"))) {
      continue; // a broker removes its own dir on clean exit; nothing to do
    }

    const pid = readBrokerPid(sessionDir);
    if (pid === null) {
      continue; // empty/unparseable pid file: possibly mid-write, leave it alone
    }
    if (isPidAlive(pid)) {
      continue; // live broker: leave it entirely alone (it self-exits when idle)
    }

    // The broker process is gone but left its directory behind (killed, not a
    // clean exit). Remove the leftover; the PID is dead so nothing is signalled.
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore already-removed directories.
    }
  }
}
