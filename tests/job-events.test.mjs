import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { checkJobLiveness, ownerProcessAlive } from "../plugins/codex/scripts/lib/job-control.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { makeTempDir } from "./helpers.mjs";

const job = { id: "job-1", threadId: "thread-1", status: "running" };

async function monitor(reports, handlers = {}) {
  const controller = new AbortController();
  const lines = [];
  let poll = 0;
  await streamJobEvents("/repo", { pollMs: 1, signal: controller.signal }, {
    snapshot(cwd, options) {
      assert.equal(cwd, "/repo");
      assert.equal(options.all, true);
      if (poll === reports.length) controller.abort();
      return { running: [], latestFinished: null, recent: [], ...reports[poll++] };
    },
    status: async () => ({}),
    readJob: () => null,
    acknowledge: async () => assert.fail("Unexpected acknowledgement"),
    ...handlers,
    writeLine: (line) => lines.push(line)
  });
  return lines;
}

test("events acknowledges a note once and reports only jobs observed active", async () => {
  const acknowledged = [];
  const note = { id: "note-1", message: "Phase done\r\nNext step" };
  const finished = { ...job, status: "completed" };
  const old = { id: "old-job", status: "completed" };
  const lines = await monitor([
    { running: [job], latestFinished: old },
    { running: [job], latestFinished: old },
    { latestFinished: finished, recent: [old] },
    { latestFinished: finished, recent: [old] }
  ], {
    status: async () => ({ notifications: [note] }),
    acknowledge: async (cwd, current, ids) => acknowledged.push({ cwd, jobId: current.id, ids })
  });
  assert.deepEqual(lines, [
    "NOTIFIED job=job-1 thread=thread-1 Phase done Next step",
    "DONE job=job-1 thread=thread-1"
  ]);
  assert.deepEqual(acknowledged, [{ cwd: "/repo", jobId: job.id, ids: [note.id] }]);
});

test("events reports each request once and limits the first question to one line of 200 characters", async () => {
  const lines = await monitor([{ running: [job] }, { running: [job] }], {
    status: async () => ({ questions: [{ requestId: "request-1", questions: [
      { question: `Choose\n${"x".repeat(300)}` }, { question: "Do not show this" }
    ] }] })
  });
  assert.deepEqual(lines, [`QUESTION job=job-1 request=request-1 Choose ${"x".repeat(193)}`]);
});

test("events silently retries unavailable broker state before reporting a failure", async () => {
  const failed = { ...job, status: "failed", errorMessage: "First error\nMore details" };
  let calls = 0;
  const lines = await monitor([
    { running: [job] }, { latestFinished: failed }, { latestFinished: failed }, { latestFinished: failed }
  ], { status: async () => ++calls < 3 ? { unavailable: "Broker offline" } : {} });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 First error"]);
});

test("events reads a turn failure from the stored result and falls back to unknown", async () => {
  const second = { ...job, id: "job-2", threadId: null };
  const lines = await monitor([
    { running: [job, second] },
    { latestFinished: { ...job, status: "failed" }, recent: [{ ...second, status: "failed" }] }
  ], { readJob: (cwd, id) => id === job.id ? { result: { error: { message: "Turn failed\nDetails" } } } : null });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 Turn failed", "FAILED job=job-2 thread=unknown unknown"]);
});

test("events retries acknowledgement and drains terminal notifications before DONE", async () => {
  let calls = 0;
  let attempts = 0;
  const finished = { ...job, status: "completed" };
  const lines = await monitor([
    { running: [job] }, { latestFinished: finished }, { latestFinished: finished }
  ], {
    status: async () => ++calls === 1 ? {} : { notifications: [{ id: "note-1", message: "Ready" }] },
    acknowledge: async () => { if (++attempts === 1) throw new Error("Broker offline"); }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(lines, ["NOTIFIED job=job-1 thread=thread-1 Ready", "DONE job=job-1 thread=thread-1"]);
});

test("events fails a dead owner once even when its broker is unavailable", async () => {
  const current = { ...job, pid: 123 };
  const failures = [];
  const lines = await monitor([{ running: [current] }, { latestFinished: current }], {
    ownerAlive: () => false,
    status: async () => ({ unavailable: "Broker offline" }),
    fail(cwd, record, reason) {
      failures.push(reason);
      Object.assign(current, { status: "failed", errorMessage: reason });
      return current;
    }
  });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 owner process exited"]);
  assert.deepEqual(failures, ["owner process exited"]);
});

test("an owner failure already marked by status is reported without acknowledging stale notes", async () => {
  let poll = 0;
  const lines = await monitor([
    { running: [job] }, { latestFinished: { ...job, status: "failed", errorMessage: "owner process exited" } }
  ], {
    status: async () => ++poll === 1 ? {} : { notifications: [{ id: "stale", message: "Pending" }] }
  });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 owner process exited"]);
});

test("broker liveness fails on the third consecutive miss and resets after success", () => {
  const failures = new Map();
  const options = { ownerAlive: () => true, fail: (cwd, current, reason) => ({ ...current, status: "failed", errorMessage: reason }) };
  const check = (live) => checkJobLiveness("/repo", job, live, failures, options);
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({}).status, "running");
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({ unavailable: "offline" }).errorMessage, "broker unreachable");
  assert.equal(ownerProcessAlive(process.pid), true);
  assert.equal(ownerProcessAlive(null), null);
});

test("events reports a stall once per interval and new progress resets the interval", async () => {
  let clock = 20 * 60000;
  let progress = 0;
  let poll = 0;
  const lines = await monitor(Array.from({ length: 5 }, () => ({ running: [job] })), {
    now: () => clock,
    progressAt: () => progress,
    status: async () => {
      poll += 1;
      if (poll === 2) clock += 60000;
      if (poll === 3) clock += 15 * 60000;
      if (poll === 4) progress = clock;
      if (poll === 5) clock += 60000;
      return {};
    }
  });
  assert.deepEqual(lines, [
    "STALLED job=job-1 thread=thread-1 20m without progress",
    "STALLED job=job-1 thread=thread-1 36m without progress"
  ]);
});

test("live broker deadline closes a socket even when initialize never replies", async (t) => {
  const root = makeTempDir("codex-live-deadline-");
  const socketPath = path.join(root, "broker.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await assert.rejects(CodexAppServerClient.connect(root, {
    brokerEndpoint: `unix://${socketPath}`, brokerTimeoutMs: 50
  }), /Live broker request timed out/);
});
