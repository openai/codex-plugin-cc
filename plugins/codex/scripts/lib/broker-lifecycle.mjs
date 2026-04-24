import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
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

// Observed failure: the broker process has crashed but its endpoint socket
// file lingers (unix domain) or listener drops without `waitForBrokerEndpoint`
// noticing in the 150ms probe window. `isBrokerEndpointReady` passes, the
// caller trusts the existing session, and every downstream task disconnects
// mid-turn. Add a PID-alive probe so we catch this class up-front and force
// a fresh broker before trusting the socket.
//
// Age-based rotation was considered to cover slow-degradation (broker alive
// but serving unreliably). Dropped in this revision — rotating a healthy
// broker while it may be mid-turn for a concurrent client can interrupt that
// turn. Proper fix for slow degradation needs a real health probe (e.g.
// lightweight RPC round-trip) or graceful drain, which are out of scope
// for this PR. Left as a follow-up.

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 only checks existence; no actual signal delivered
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSessionStale(session) {
  if (!session) return true;
  // PID check — covers crashed-broker case
  if (session.pid != null && !isPidAlive(session.pid)) return true;
  return false;
}

// Default kill for stale-rotation teardown. Without this, rotating a still-alive
// broker only removes its socket/pid files — the detached process keeps running
// and leaks host resources. SIGTERM is best-effort; ignore missing-process errors.
function defaultKillProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // process already gone — fine
  }
}

// Cross-check session.pid against the actual running process before signaling.
//
// pid-file alone is insufficient: app-server-broker.mjs only removes it in the
// clean shutdown() path — if the broker crashed ungracefully the pidfile
// lingers, and when the OS recycles that PID to an unrelated process the file
// contents will spuriously match. On POSIX we also check `ps` command line to
// confirm the broker script name is present. On Windows we intentionally do
// not send SIGTERM: `tasklist` exposes image name but not full command line
// via the public CLI, and matching on image-name (`node.exe`) alone is too
// weak to rule out recycled-PID foreign processes. Windows rotation will
// still clean up socket/pidfile — detached old broker eventually exits on
// its own since no new client will reach it.
function verifyBrokerPid(session) {
  if (!session || !Number.isFinite(session.pid) || !session.pidFile) return false;
  if (process.platform === "win32") return false;
  try {
    if (!fs.existsSync(session.pidFile)) return false;
    const content = fs.readFileSync(session.pidFile, "utf8").trim();
    if (Number(content) !== session.pid) return false;
    // POSIX: ps exposes the full command, so match instance-specific args.
    // Script name alone is too broad — a recycled PID belonging to a foreign
    // broker instance (different workspace) would also contain
    // "app-server-broker.mjs" and cause a cross-session kill. We also require
    // the session's unique --pid-file and --endpoint paths to appear in the
    // live command line. Those paths are per-session (see spawnBrokerProcess —
    // both are derived from createBrokerSessionDir()), so a recycled PID on
    // an unrelated broker cannot match.
    const cmd = execFileSync("ps", ["-p", String(session.pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1000
    });
    if (!cmd.includes("app-server-broker.mjs")) return false;
    if (!cmd.includes(`--pid-file ${session.pidFile}`)) return false;
    if (session.endpoint && !cmd.includes(`--endpoint ${session.endpoint}`)) return false;
    return true;
  } catch {
    // Any lookup failure (process gone, permission denied, timeout) → skip
    // the kill. Safe default; socket/pidfile cleanup still proceeds.
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && !isSessionStale(existing) && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    // Only send SIGTERM when the pid-file on disk still maps to session.pid —
    // otherwise the PID may have been recycled by the OS to an unrelated
    // process and signaling it would kill something we don't own.
    const killAllowed = verifyBrokerPid(existing);
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? (killAllowed ? defaultKillProcess : null)
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
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
