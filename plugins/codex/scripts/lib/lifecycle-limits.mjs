import process from "node:process";

const DEFAULT_BROKER_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const DEFAULT_BROKER_STARTUP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_TTL_MS = 24 * 60 * 60 * 1000;

/** `setTimeout` truncates anything larger to a 32-bit int, firing almost immediately instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function readDurationMs(raw, fallback) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  // Clamp rather than reject: an operator asking for 30 days means "effectively never", and
  // letting that overflow into ~1ms would kill exactly what they meant to protect.
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/**
 * How long the broker may sit with no connected client before shutting itself down, taking its
 * app-server (and every MCP server under it) with it.
 *
 * A broker outlives the client that spawned it, so without this it survives a crashed or
 * timed-out SessionEnd hook and holds that whole tree alive indefinitely. `0` disables the timer.
 */
export function brokerIdleShutdownMs(env = process.env) {
  return readDurationMs(env.CODEX_BROKER_IDLE_SHUTDOWN_MS, DEFAULT_BROKER_IDLE_SHUTDOWN_MS);
}

/**
 * How long the broker may spend starting up before it gives up and takes its tree down.
 *
 * Until the broker is listening there is no idle timer, and the client that spawned it stops
 * waiting after a couple of seconds without killing anything — so a wedged app-server or MCP
 * startup would strand the whole tree permanently. The default is generous because a cold start
 * legitimately spawns every configured MCP server. `0` disables the bound.
 */
export function brokerStartupTimeoutMs(env = process.env) {
  return readDurationMs(env.CODEX_BROKER_STARTUP_TIMEOUT_MS, DEFAULT_BROKER_STARTUP_TIMEOUT_MS);
}

/**
 * Ceiling on a detached background worker's wall-clock lifetime.
 *
 * The worker is deliberately detached so a background task survives the session that queued it,
 * and its immediate parent exits right after enqueue — so there is no parent to watch and nothing
 * else that reclaims it. This is a runaway guard, not a task deadline: the default is far longer
 * than any real background task, and still reclaims the multi-day trees that prompted it. `0`
 * disables the ceiling.
 */
export function workerTtlMs(env = process.env) {
  return readDurationMs(env.CODEX_TASK_WORKER_TTL_MS, DEFAULT_WORKER_TTL_MS);
}
