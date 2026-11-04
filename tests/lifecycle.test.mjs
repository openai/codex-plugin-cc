import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { BROKER_BUSY_RPC_CODE } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { reconcileOrphanedJobs } from "../plugins/codex/scripts/lib/job-control.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../plugins/codex/", import.meta.url));
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const BROKER = path.join(PLUGIN_ROOT, "scripts", "app-server-broker.mjs");

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for lifecycle transition.");
}

async function startBroker(t, behavior = "interruptible-slow-task") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("cxl-");
  initGitRepo(repo);
  installFakeCodex(binDir, behavior);
  const endpoint = createBrokerEndpoint(sessionDir);
  const env = { ...buildEnv(binDir), CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
  const broker = spawn(process.execPath, [BROKER, "serve", "--cwd", repo, "--endpoint", endpoint], {
    cwd: repo, env, stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(broker, "exit");
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
    await exited;
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 5000), true, stderr);
  const statePath = path.join(binDir, "fake-codex-state.json");
  return {
    repo, env,
    readState: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    release: (phase) => fs.writeFileSync(`${statePath}.release-${phase}`, ""),
    async connect() {
      const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
      sockets.add(socket);
      socket.setEncoding("utf8");
      const pending = new Map();
      const notifications = [];
      let nextId = 1;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.id !== undefined) {
            pending.get(message.id)?.resolve(message);
            pending.delete(message.id);
          } else {
            notifications.push(message);
          }
        }
      });
      socket.on("close", () => {
        for (const { reject } of pending.values()) reject(new Error("Connection closed."));
        pending.clear();
        sockets.delete(socket);
      });
      await once(socket, "connect");
      return {
        notifications,
        request(method, params = {}) {
          const id = nextId++;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
          });
        },
        async close() {
          const closed = once(socket, "close");
          socket.destroy();
          await closed;
        }
      };
    }
  };
}

async function startTurn(client, repo) {
  const started = await client.request("thread/start", { cwd: repo });
  assert.ok(started.result, JSON.stringify(started));
  const threadId = started.result.thread.id;
  const response = await client.request("turn/start", { threadId, input: [{ type: "text", text: "Investigate." }] });
  assert.ok(response.result, JSON.stringify(response));
  return { threadId, turnId: response.result.turn.id };
}

async function waitForAvailableBroker(client, repo) {
  const deadline = Date.now() + 5000;
  do {
    const response = await client.request("thread/start", { cwd: repo });
    if (response.result) return response.result;
    assert.equal(response.error.code, BROKER_BUSY_RPC_CODE);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("Broker stayed busy after interrupting its orphaned turn.");
}

test("broker interrupts a disconnected owner while leaving observer disconnects alone", async (t) => {
  const harness = await startBroker(t);
  const owner = await harness.connect();
  const turn = await startTurn(owner, harness.repo);
  const observer = await harness.connect();
  await observer.request("initialize");
  await observer.close();
  const probe = await harness.connect();
  assert.equal((await probe.request("thread/start", { cwd: harness.repo })).error.code, BROKER_BUSY_RPC_CODE);
  assert.equal(harness.readState().lastInterrupt, null);
  await owner.close();
  assert.deepEqual(await waitFor(() => harness.readState().lastInterrupt), turn);
  // A subsequent client can use the broker once the old turn is interrupted.
  await waitForAvailableBroker(probe, harness.repo);
});

test("broker keeps a disconnected start request busy until the turn and interrupt settle", async (t) => {
  const harness = await startBroker(t, "deferred-task");
  const owner = await harness.connect();
  const started = await owner.request("thread/start", { cwd: harness.repo });
  const threadId = started.result.thread.id;
  const request = owner.request("turn/start", { threadId, input: [] }).catch(() => null);
  const turn = await waitFor(() => harness.readState().lastTurnStart);
  await owner.close();
  await request;
  const probe = await harness.connect();
  assert.equal((await probe.request("thread/start", { cwd: harness.repo })).error.code, BROKER_BUSY_RPC_CODE);
  harness.release("start");
  assert.deepEqual(await waitFor(() => harness.readState().lastInterrupt), { threadId, turnId: turn.turnId });
  assert.equal((await probe.request("thread/start", { cwd: harness.repo })).error.code, BROKER_BUSY_RPC_CODE);
  harness.release("interrupt");
  await waitForAvailableBroker(probe, harness.repo);
});

test("broker does not interrupt normally completed turns when their clients close", async (t) => {
  const harness = await startBroker(t, "review-ok");
  const owner = await harness.connect();
  const turn = await startTurn(owner, harness.repo);
  await waitFor(() => owner.notifications.find((message) => message.method === "turn/completed"));
  await owner.close();
  const probe = await harness.connect();
  assert.ok((await probe.request("thread/start", { cwd: harness.repo })).result);
  assert.equal(harness.readState().lastInterrupt, null, `Completed turn ${turn.turnId} was interrupted.`);
});

test("broker interrupts the detached review thread owned by a disconnected client", async (t) => {
  const harness = await startBroker(t, "interruptible-review");
  const owner = await harness.connect();
  const started = await owner.request("thread/start", { cwd: harness.repo });
  const review = await owner.request("review/start", {
    threadId: started.result.thread.id, delivery: "detached", target: { type: "uncommittedChanges" }
  });
  assert.notEqual(review.result.reviewThreadId, started.result.thread.id);
  await owner.close();
  assert.deepEqual(await waitFor(() => harness.readState().lastInterrupt), {
    threadId: review.result.reviewThreadId, turnId: review.result.turn.id
  });
});

function launchCompanion(t, harness, args = ["task", "--write", "Investigate the worker."]) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: harness.repo, env: harness.env, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`companion records cancellation and interrupts Codex on ${signal}`, { skip: process.platform === "win32" }, async (t) => {
    const harness = await startBroker(t);
    const companion = launchCompanion(t, harness);
    const job = await waitFor(() => listJobs(harness.repo).find((candidate) => candidate.turnId));
    companion.child.kill(signal);
    const [code] = await companion.closed;
    assert.equal(code, 128 + os.constants.signals[signal], companion.stderr());
    assert.deepEqual(await waitFor(() => harness.readState().lastInterrupt), { threadId: job.threadId, turnId: job.turnId });
    const stored = readJobFile(resolveJobFile(harness.repo, job.id));
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.pid, null);
    assert.match(stored.errorMessage, new RegExp(signal));
    assert.equal(listJobs(harness.repo)[0].status, "cancelled");
  });
}

test("SIGKILL interrupts the turn and status repairs the orphan for later resume", { skip: process.platform === "win32" }, async (t) => {
  const harness = await startBroker(t);
  const companion = launchCompanion(t, harness);
  const job = await waitFor(() => listJobs(harness.repo).find((candidate) => candidate.turnId));
  companion.child.kill("SIGKILL");
  await companion.closed;
  assert.deepEqual(await waitFor(() => harness.readState().lastInterrupt), { threadId: job.threadId, turnId: job.turnId });
  const status = run(process.execPath, [SCRIPT, "status", job.id, "--json"], { cwd: harness.repo, env: harness.env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, "failed");
  assert.equal(readJobFile(resolveJobFile(harness.repo, job.id)).pid, null);
  const candidate = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], { cwd: harness.repo, env: harness.env });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, true);
  const resumed = run(process.execPath, [SCRIPT, "task", "--resume-last", "Continue."], { cwd: harness.repo, env: harness.env });
  assert.equal(resumed.status, 0, resumed.stderr);
});

test("a detached worker survives its launcher and is still cancelled through the broker", async (t) => {
  const harness = await startBroker(t);
  const companion = launchCompanion(t, harness, ["task", "--background", "--json", "Investigate the worker."]);
  const [code] = await companion.closed;
  assert.equal(code, 0, companion.stderr());
  const { jobId } = JSON.parse(companion.stdout());
  const job = await waitFor(() => listJobs(harness.repo).find((candidate) => candidate.id === jobId && candidate.turnId));
  t.after(() => { try { process.kill(job.pid, "SIGKILL"); } catch {} });
  assert.equal(job.status, "running");
  assert.equal(harness.readState().lastInterrupt, null);
  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: harness.repo, env: harness.env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).turnInterrupted, true);
  assert.equal(listJobs(harness.repo)[0].status, "cancelled");
});

test("orphan reconciliation repairs active jobs once and preserves a stored terminal result", () => {
  const repo = makeTempDir();
  const logFile = path.join(repo, "job.log");
  fs.writeFileSync(logFile, "");
  const orphan = { id: "orphan", status: "running", pid: 42, threadId: "thr_orphan", logFile };
  const finished = { id: "finished", status: "queued", pid: 43 };
  const live = { id: "live", status: "running", pid: 44 };
  const queued = { id: "queued", status: "queued", pid: null };
  for (const job of [orphan, finished, live, queued]) {
    upsertJob(repo, job);
    writeJobFile(repo, job.id, job);
  }
  writeJobFile(repo, finished.id, {
    ...finished, status: "completed", phase: "done", pid: null, threadId: "thr_finished", turnId: "turn_finished",
    completedAt: "2026-01-01T00:00:00.000Z", rendered: "Kept the finished output."
  });
  const options = { isProcessAlive: (pid) => pid === live.pid };
  reconcileOrphanedJobs(repo, options);
  const jobs = Object.fromEntries(listJobs(repo).map((job) => [job.id, job]));
  assert.equal(jobs.orphan.status, "failed");
  assert.equal(jobs.orphan.pid, null);
  assert.equal(jobs.orphan.threadId, "thr_orphan");
  assert.equal(readJobFile(resolveJobFile(repo, orphan.id)).status, "failed");
  assert.equal(jobs.finished.status, "completed");
  assert.equal(jobs.finished.threadId, "thr_finished");
  assert.equal(jobs.finished.turnId, "turn_finished");
  assert.equal(readJobFile(resolveJobFile(repo, finished.id)).rendered, "Kept the finished output.");
  assert.equal(jobs.live.status, "running");
  assert.equal(jobs.queued.status, "queued");
  reconcileOrphanedJobs(repo, options);
  assert.equal(fs.readFileSync(logFile, "utf8").split("exited before").length - 1, 1);
});
