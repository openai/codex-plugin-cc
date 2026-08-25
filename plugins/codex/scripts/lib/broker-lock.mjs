import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveStateDir } from "./state.mjs";

const BROKER_LOCK_FILE = "broker.lock";
const BROKER_LOCK_TIMEOUT_MS = 5000;
const BROKER_LOCK_STALE_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function brokerLockPath(cwd) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, BROKER_LOCK_FILE);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function removeAbandonedBrokerLock(lockFile, staleMs) {
  try {
    const stat = fs.statSync(lockFile);
    const ownerPid = Number.parseInt(fs.readFileSync(lockFile, "utf8").split(":", 1)[0], 10);
    if (Number.isFinite(ownerPid) && isProcessAlive(ownerPid)) {
      return false;
    }
    if (!Number.isFinite(ownerPid) && Date.now() - stat.mtimeMs <= staleMs) {
      return false;
    }
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function acquireBrokerLock(cwd, options = {}) {
  const lockFile = brokerLockPath(cwd);
  const timeoutMs = options.lockTimeoutMs ?? BROKER_LOCK_TIMEOUT_MS;
  const staleMs = options.lockStaleMs ?? BROKER_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;

  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, token, "utf8");
      return { fd, lockFile, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (removeAbandonedBrokerLock(lockFile, staleMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the shared Codex broker lock at ${lockFile}.`);
      }
      await sleep(25);
    }
  }
}

function releaseBrokerLock(lock) {
  try {
    fs.closeSync(lock.fd);
  } finally {
    try {
      if (fs.readFileSync(lock.lockFile, "utf8") === lock.token) {
        fs.unlinkSync(lock.lockFile);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export async function withBrokerLock(cwd, options, action) {
  const lock = await acquireBrokerLock(cwd, options);
  try {
    return await action();
  } finally {
    releaseBrokerLock(lock);
  }
}
