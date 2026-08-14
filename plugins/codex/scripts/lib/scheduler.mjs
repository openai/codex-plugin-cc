import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const SCHEDULER_DIR_ENV = "CODEX_COMPANION_SCHEDULER_DIR";
export const DEFAULT_QUEUE_WAIT_MS = 1800000;

const HEARTBEAT_INTERVAL_MS = 1000;
const STALE_HEARTBEAT_MS = 5000;
const STALE_LOCK_MS = 5000;
const POLL_INTERVAL_MS = 100;
const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 10000;

export class QueueWaitTimeoutError extends Error {
  constructor(waitedMs, position) {
    super(
      `Codex is already running another workload. Gave up after waiting ${Math.round(waitedMs / 1000)}s in the global queue${
        position ? ` (position ${position})` : ""
      }.`
    );
    this.name = "QueueWaitTimeoutError";
    this.waitedMs = waitedMs;
    this.position = position;
  }
}

export class QueueCancelledError extends Error {
  constructor(jobId) {
    super(`Codex workload ${jobId} was cancelled while it waited in the global queue.`);
    this.name = "QueueCancelledError";
    this.jobId = jobId;
  }
}

export function resolveSchedulerDir(env = process.env) {
  const override = env[SCHEDULER_DIR_ENV];
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "cache", "codex-companion", "scheduler");
}

function queueDir(root) {
  return path.join(root, "queue");
}

function activeFile(root) {
  return path.join(root, "active.json");
}

function lockFile(root) {
  return path.join(root, "scheduler.lock");
}

function sequenceFile(root) {
  return path.join(root, "sequence");
}

function ensureSchedulerDirs(root) {
  fs.mkdirSync(queueDir(root), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone.
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function withSchedulerLock(root, fn) {
  const lockPath = lockFile(root);
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      fs.writeSync(handle, `${process.pid}\n`);
      fs.closeSync(handle);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        removeIfExists(lockPath);
        continue;
      }
      if (Date.now() > deadline) {
        // The lock holder is wedged; break in rather than blocking Codex forever.
        removeIfExists(lockPath);
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    removeIfExists(lockPath);
  }
}

function nextSequence(root) {
  const current = Number.parseInt(String(readTextOrEmpty(sequenceFile(root))).trim(), 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  fs.writeFileSync(sequenceFile(root), `${next}\n`, "utf8");
  return next;
}

function readTextOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function recordFileName(record) {
  return `${String(record.seq).padStart(12, "0")}-${record.jobId}.json`;
}

function listQueueRecords(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(queueDir(root));
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(queueDir(root), entry);
      const record = readJsonOrNull(filePath);
      return record ? { ...record, file: filePath } : null;
    })
    .filter(Boolean)
    .sort((left, right) => Number(left.seq) - Number(right.seq));
}

function readActiveRecord(root) {
  return readJsonOrNull(activeFile(root));
}

function isActiveRecordLive(active) {
  if (!active) {
    return false;
  }
  const heartbeatAt = Date.parse(active.heartbeatAt ?? "");
  const heartbeatStale = !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > STALE_HEARTBEAT_MS;
  // A lease may only be reclaimed when the heartbeat is stale AND the owner is gone.
  return !(heartbeatStale && !isProcessAlive(active.pid));
}

function pruneDeadRecords(root) {
  const active = readActiveRecord(root);
  if (active && !isActiveRecordLive(active)) {
    removeIfExists(activeFile(root));
  }

  for (const record of listQueueRecords(root)) {
    if (record.jobId === readActiveRecord(root)?.jobId) {
      continue;
    }
    if (!isProcessAlive(record.pid)) {
      removeIfExists(record.file);
    }
  }
}

function startHeartbeat(root, record) {
  const timer = setInterval(() => {
    const active = readActiveRecord(root);
    if (!active || active.jobId !== record.jobId) {
      return;
    }
    try {
      writeJsonAtomic(activeFile(root), { ...active, heartbeatAt: new Date().toISOString() });
    } catch {
      // Heartbeat is best effort.
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/**
 * Join the user-global FIFO queue and wait for the single Codex workload lease.
 * The execution deadline of the caller must only start once this resolves.
 */
export async function acquireWorkloadLease(options = {}) {
  const root = options.schedulerDir ?? resolveSchedulerDir(options.env ?? process.env);
  const jobId = options.jobId ?? `anon-${process.pid}`;
  const waitTimeoutMs = Math.max(0, Number(options.waitTimeoutMs) || DEFAULT_QUEUE_WAIT_MS);
  const pollIntervalMs = Math.max(10, Number(options.pollIntervalMs) || POLL_INTERVAL_MS);
  const enqueuedAt = Date.now();

  ensureSchedulerDirs(root);

  const record = await withSchedulerLock(root, async () => {
    const next = {
      jobId,
      seq: nextSequence(root),
      pid: options.pid ?? process.pid,
      kind: options.kind ?? "codex",
      workspace: options.workspace ?? null,
      timeoutMs: options.timeoutMs ?? null,
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    };
    const file = path.join(queueDir(root), recordFileName(next));
    writeJsonAtomic(file, next);
    return { ...next, file };
  });

  const deadline = enqueuedAt + waitTimeoutMs;

  for (;;) {
    const outcome = await withSchedulerLock(root, async () => {
      pruneDeadRecords(root);
      if (!fs.existsSync(record.file)) {
        return { acquired: false, cancelled: true };
      }
      const active = readActiveRecord(root);
      if (active && active.jobId !== jobId && isActiveRecordLive(active)) {
        return { acquired: false, active };
      }

      const waiting = listQueueRecords(root);
      const head = waiting[0] ?? null;
      if (!head || head.jobId !== jobId) {
        return { acquired: false, active: null };
      }

      writeJsonAtomic(activeFile(root), {
        ...record,
        leaseAcquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      });
      return { acquired: true };
    });

    if (outcome.acquired) {
      const queueWaitMs = Date.now() - enqueuedAt;
      const heartbeat = startHeartbeat(root, record);
      return {
        jobId,
        seq: record.seq,
        schedulerDir: root,
        queueWaitMs,
        acquiredAt: new Date().toISOString(),
        release: () => {
          clearInterval(heartbeat);
          releaseWorkloadLease({ jobId, schedulerDir: root, file: record.file });
        }
      };
    }

    if (outcome.cancelled) {
      throw new QueueCancelledError(jobId);
    }

    if (options.noWait) {
      releaseWorkloadLease({ jobId, schedulerDir: root, file: record.file });
      throw new QueueWaitTimeoutError(Date.now() - enqueuedAt, getQueuePosition(jobId, { schedulerDir: root }));
    }

    if (Date.now() >= deadline) {
      const position = getQueuePosition(jobId, { schedulerDir: root });
      releaseWorkloadLease({ jobId, schedulerDir: root, file: record.file });
      throw new QueueWaitTimeoutError(Date.now() - enqueuedAt, position);
    }

    await sleep(pollIntervalMs);
  }
}

export function releaseWorkloadLease(lease) {
  if (!lease) {
    return;
  }
  const root = lease.schedulerDir ?? resolveSchedulerDir();
  const active = readActiveRecord(root);
  if (active && active.jobId === lease.jobId) {
    removeIfExists(activeFile(root));
  }
  if (lease.file) {
    removeIfExists(lease.file);
    return;
  }
  for (const record of listQueueRecords(root)) {
    if (record.jobId === lease.jobId) {
      removeIfExists(record.file);
    }
  }
}

/**
 * Remove a queued job from the global queue. Never touches the active lease:
 * cancelling the active workload is the caller's job (interrupt, then terminate).
 */
export function cancelQueuedWorkload(jobId, options = {}) {
  const root = options.schedulerDir ?? resolveSchedulerDir(options.env ?? process.env);
  const active = readActiveRecord(root);
  if (active && active.jobId === jobId) {
    return { removed: false, wasActive: true };
  }

  let removed = false;
  for (const record of listQueueRecords(root)) {
    if (record.jobId === jobId) {
      removeIfExists(record.file);
      removed = true;
    }
  }
  return { removed, wasActive: false };
}

export function readSchedulerSnapshot(options = {}) {
  const root = options.schedulerDir ?? resolveSchedulerDir(options.env ?? process.env);
  const activeRaw = readActiveRecord(root);
  const active = activeRaw && isActiveRecordLive(activeRaw) ? activeRaw : null;
  const waiting = listQueueRecords(root).filter((record) => record.jobId !== active?.jobId);

  return {
    schedulerDir: root,
    active: active
      ? {
          jobId: active.jobId,
          kind: active.kind ?? null,
          workspace: active.workspace ?? null,
          pid: active.pid ?? null,
          leaseAcquiredAt: active.leaseAcquiredAt ?? null
        }
      : null,
    queue: waiting.map((record, index) => ({
      jobId: record.jobId,
      kind: record.kind ?? null,
      workspace: record.workspace ?? null,
      seq: record.seq,
      position: index + 1,
      createdAt: record.createdAt ?? null
    }))
  };
}

export function getQueuePosition(jobId, options = {}) {
  const snapshot = readSchedulerSnapshot(options);
  if (snapshot.active?.jobId === jobId) {
    return 0;
  }
  return snapshot.queue.find((entry) => entry.jobId === jobId)?.position ?? null;
}
