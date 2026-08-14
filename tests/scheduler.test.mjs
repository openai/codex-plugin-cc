import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  acquireWorkloadLease,
  cancelQueuedWorkload,
  getQueuePosition,
  QueueWaitTimeoutError,
  readSchedulerSnapshot,
  releaseWorkloadLease,
  resolveSchedulerDir
} from "../plugins/codex/scripts/lib/scheduler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULER_MODULE = path.join(ROOT, "plugins", "codex", "scripts", "lib", "scheduler.mjs");

function writeQueueRecord(schedulerDir, record) {
  fs.mkdirSync(path.join(schedulerDir, "queue"), { recursive: true });
  const file = path.join(schedulerDir, "queue", `${String(record.seq).padStart(12, "0")}-${record.jobId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

function writeActiveRecord(schedulerDir, record) {
  fs.mkdirSync(schedulerDir, { recursive: true });
  fs.writeFileSync(path.join(schedulerDir, "active.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("the scheduler directory is user-global rather than per repository or plugin data dir", () => {
  const fallback = resolveSchedulerDir({ CLAUDE_PLUGIN_DATA: "/tmp/some-plugin-data" });
  assert.equal(fallback, path.join(os.homedir(), ".claude", "cache", "codex-companion", "scheduler"));

  const override = resolveSchedulerDir({ CODEX_COMPANION_SCHEDULER_DIR: "/tmp/custom-scheduler" });
  assert.equal(override, path.resolve("/tmp/custom-scheduler"));
});

test("only one workload holds the lease at a time and queue position is reported", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  const first = await acquireWorkloadLease({ schedulerDir, jobId: "job-a", kind: "task" });
  assert.equal(first.queueWaitMs >= 0, true);

  const secondPromise = acquireWorkloadLease({ schedulerDir, jobId: "job-b", kind: "review" });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const snapshot = readSchedulerSnapshot({ schedulerDir });
  assert.equal(snapshot.active.jobId, "job-a");
  assert.deepEqual(
    snapshot.queue.map((entry) => entry.jobId),
    ["job-b"]
  );
  assert.equal(getQueuePosition("job-b", { schedulerDir }), 1);
  assert.equal(getQueuePosition("job-a", { schedulerDir }), 0);

  first.release();
  const second = await secondPromise;
  assert.equal(second.jobId, "job-b");
  // Queue wait is measured separately so it can never consume the execution deadline.
  assert.equal(second.queueWaitMs >= 200, true);
  second.release();

  assert.equal(readSchedulerSnapshot({ schedulerDir }).active, null);
});

test("the queue is FIFO by monotonic sequence, not by filesystem timestamp", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  const held = await acquireWorkloadLease({ schedulerDir, jobId: "holder" });

  const waiters = [];
  for (const jobId of ["first", "second", "third"]) {
    waiters.push(acquireWorkloadLease({ schedulerDir, jobId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const queued = readSchedulerSnapshot({ schedulerDir }).queue;
  assert.deepEqual(
    queued.map((entry) => entry.jobId),
    ["first", "second", "third"]
  );
  assert.deepEqual(
    queued.map((entry) => entry.seq),
    [...queued.map((entry) => entry.seq)].sort((left, right) => left - right)
  );

  // Rewrite mtimes in reverse order: ordering must still follow the sequence numbers.
  const queueFiles = fs
    .readdirSync(path.join(schedulerDir, "queue"))
    .map((entry) => path.join(schedulerDir, "queue", entry));
  let offset = queueFiles.length;
  for (const file of queueFiles) {
    const when = new Date(Date.now() + offset * 1000);
    fs.utimesSync(file, when, when);
    offset -= 1;
  }

  const order = [];
  held.release();
  for (const waiter of waiters) {
    const lease = await waiter;
    order.push(lease.jobId);
    lease.release();
  }
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("six concurrent workloads from different workspaces run one at a time", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  const workerPath = path.join(schedulerDir, "worker.mjs");
  const eventsPath = path.join(schedulerDir, "events.log");
  fs.writeFileSync(
    workerPath,
    `import fs from "node:fs";
import { acquireWorkloadLease } from ${JSON.stringify(SCHEDULER_MODULE)};

const jobId = process.argv[2];
const lease = await acquireWorkloadLease({ schedulerDir: ${JSON.stringify(schedulerDir)}, jobId, workspace: "/repo/" + jobId });
fs.appendFileSync(${JSON.stringify(eventsPath)}, \`start \${jobId} \${Date.now()}\\n\`);
await new Promise((resolve) => setTimeout(resolve, 120));
fs.appendFileSync(${JSON.stringify(eventsPath)}, \`end \${jobId} \${Date.now()}\\n\`);
lease.release();
`,
    "utf8"
  );

  const jobs = ["w1", "w2", "w3", "w4", "w5", "w6"];
  await Promise.all(
    jobs.map(
      (jobId) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [workerPath, jobId], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${jobId} failed: ${stderr}`))));
        })
    )
  );

  const events = fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  assert.equal(events.length, jobs.length * 2);

  let open = 0;
  for (const [kind] of events) {
    open += kind === "start" ? 1 : -1;
    assert.equal(open <= 1, true, "two Codex workloads held the lease at the same time");
  }
  assert.equal(readSchedulerSnapshot({ schedulerDir }).active, null);
});

test("cancelling a queued job never interrupts the active job and promotes the next waiter", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  const active = await acquireWorkloadLease({ schedulerDir, jobId: "active-job" });
  const queued = acquireWorkloadLease({ schedulerDir, jobId: "queued-job" }).catch((error) => error);
  const nextUp = acquireWorkloadLease({ schedulerDir, jobId: "next-job" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const cancelledQueued = cancelQueuedWorkload("queued-job", { schedulerDir });
  assert.deepEqual(cancelledQueued, { removed: true, wasActive: false });
  assert.equal(readSchedulerSnapshot({ schedulerDir }).active.jobId, "active-job");

  const cancelActive = cancelQueuedWorkload("active-job", { schedulerDir });
  assert.deepEqual(cancelActive, { removed: false, wasActive: true });

  active.release();
  const promoted = await nextUp;
  assert.equal(promoted.jobId, "next-job");
  promoted.release();

  const cancelledWaiter = await queued;
  assert.match(String(cancelledWaiter.message), /cancelled while it waited/i);
});

test("a live lease is not stolen when its heartbeat is briefly delayed", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  writeActiveRecord(schedulerDir, {
    jobId: "live-owner",
    seq: 1,
    pid: process.pid,
    heartbeatAt: new Date(Date.now() - 60000).toISOString()
  });
  writeQueueRecord(schedulerDir, {
    jobId: "live-owner",
    seq: 1,
    pid: process.pid,
    heartbeatAt: new Date(Date.now() - 60000).toISOString()
  });

  await assert.rejects(
    acquireWorkloadLease({ schedulerDir, jobId: "waiter", waitTimeoutMs: 300, pollIntervalMs: 50 }),
    QueueWaitTimeoutError
  );
  assert.equal(readSchedulerSnapshot({ schedulerDir }).active.jobId, "live-owner");
});

test("a dead owner with a stale heartbeat has its lease reclaimed", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  const deadPid = 2147483646;
  writeActiveRecord(schedulerDir, {
    jobId: "dead-owner",
    seq: 1,
    pid: deadPid,
    heartbeatAt: new Date(Date.now() - 60000).toISOString()
  });
  writeQueueRecord(schedulerDir, { jobId: "dead-owner", seq: 1, pid: deadPid });

  const lease = await acquireWorkloadLease({ schedulerDir, jobId: "waiter", waitTimeoutMs: 3000 });
  assert.equal(lease.jobId, "waiter");
  assert.equal(readSchedulerSnapshot({ schedulerDir }).active.jobId, "waiter");
  lease.release();
});

test("concurrent enqueue and cancel keep the queue consistent", async () => {
  const schedulerDir = makeTempDir("codex-scheduler-");
  const active = await acquireWorkloadLease({ schedulerDir, jobId: "holder" });

  const waiters = ["a", "b", "c", "d"].map((jobId) =>
    acquireWorkloadLease({ schedulerDir, jobId, waitTimeoutMs: 5000 }).catch((error) => error)
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  cancelQueuedWorkload("b", { schedulerDir });
  cancelQueuedWorkload("c", { schedulerDir });

  const remaining = readSchedulerSnapshot({ schedulerDir }).queue.map((entry) => entry.jobId);
  assert.deepEqual(remaining, ["a", "d"]);

  active.release();
  for (const waiter of waiters) {
    const result = await waiter;
    if (result instanceof Error) {
      continue;
    }
    result.release();
  }
  releaseWorkloadLease({ schedulerDir, jobId: "holder" });
  assert.equal(readSchedulerSnapshot({ schedulerDir }).active, null);
});
