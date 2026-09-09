import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { ensureBrokerSession, saveBrokerSession, sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run, shutdownTestBrokers } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for live control.");
}
async function setup(t, timeoutMs = 600000, idleTimeoutMs = 600000) {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const bin = makeTempDir();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxl-"));
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  initGitRepo(repo);
  const endpoint = createBrokerEndpoint(socketDir);
  const pidFile = path.join(socketDir, "broker.pid");
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"),
    CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint, LIVE_CODEX_RECORDING: path.join(bin, "requests.jsonl") };
  const broker = spawn(process.execPath, [path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs"),
    "serve", "--endpoint", endpoint, "--cwd", repo, "--input-timeout-ms", String(timeoutMs),
    "--idle-timeout-ms", String(idleTimeoutMs), "--pid-file", pidFile], { env });
  let errors = "";
  broker.stderr.on("data", (data) => { errors += data; });
  const closed = new Promise((resolve) => broker.on("exit", resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await sendBrokerShutdown(endpoint);
    if (broker.exitCode === null) broker.kill();
    await closed;
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 15000), true, errors);
  const connect = async () => {
    const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
    clients.push(client);
    return client;
  };
  const owner = await connect();
  const notifications = [];
  owner.setNotificationHandler((message) => notifications.push(message));
  const { thread } = await owner.request("thread/start", { cwd: repo, sandbox: "read-only" });
  const start = (text) => owner.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args, "--json"], { cwd: repo, env });
  const requests = () => fs.readFileSync(env.LIVE_CODEX_RECORDING, "utf8").trim().split("\n").map(JSON.parse);
  return { repo, env, owner, connect, thread, start, notifications, cli, requests, broker, closed, endpoint, pidFile, socketDir };
}

test("steering from another socket preserves FIFO and the owning event stream", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("hold");
  const control = await h.connect();
  const accepted = await Promise.all(["first", "finish"].map((text) => control.request("turn/steer", {
    threadId: h.thread.id, expectedTurnId: turn.id, clientUserMessageId: text, input: [{ type: "text", text }]
  })));
  assert.deepEqual(accepted.map((result) => result.turnId), [turn.id, turn.id]);
  assert.deepEqual(accepted.map((result) => result.messageId), ["first", "finish"]);
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  assert.deepEqual(h.notifications.filter((item) => item.method === "item/started" && item.params.item.type === "userMessage")
    .map((item) => item.params.item.clientId), ["first", "finish"]);
  const final = h.notifications.find((item) => item.params?.item?.type === "agentMessage");
  assert.equal(final.params.item.text, "hold|first|finish");
  assert.deepEqual((await control.request("broker/status", { threadId: h.thread.id })).pendingMessages, []);
});

test("parallel thread owners receive only their own events and reject another socket taking an active thread", async (t) => {
  const h = await setup(t);
  const second = await h.connect();
  const control = await h.connect();
  const secondEvents = [];
  const controlEvents = [];
  second.setNotificationHandler((message) => secondEvents.push(message));
  control.setNotificationHandler((message) => controlEvents.push(message));
  const [{ thread: secondThread }] = await Promise.all([
    second.request("thread/start", { cwd: h.repo, sandbox: "read-only" }),
    h.owner.request("thread/name/set", { threadId: h.thread.id, name: "first" })
  ]);
  const [{ turn: firstTurn }, { turn: secondTurn }] = await Promise.all([
    h.start("hold first"),
    second.request("turn/start", { threadId: secondThread.id, input: [{ type: "text", text: "hold second" }] })
  ]);
  await assert.rejects(control.request("turn/start", {
    threadId: h.thread.id, input: [{ type: "text", text: "steal" }]
  }), (error) => error.rpcCode === BROKER_BUSY_RPC_CODE && /busy/.test(error.message));
  const states = await Promise.all([h.thread, secondThread].map((thread) =>
    control.request("broker/status", { threadId: thread.id })));
  assert.deepEqual(states.map((state) => state.turnId), [firstTurn.id, secondTurn.id]);
  const accepted = await Promise.all([[h.thread, firstTurn], [secondThread, secondTurn]].map(([thread, turn]) =>
    control.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id,
      input: [{ type: "text", text: "finish" }] })));
  assert.deepEqual(accepted.map((result) => result.turnId), [firstTurn.id, secondTurn.id]);
  await waitFor(() => [h.notifications, secondEvents].every((events) =>
    events.some((message) => message.method === "turn/completed")));
  for (const [events, thread] of [[h.notifications, h.thread], [secondEvents, secondThread]]) {
    assert.ok(events.every((message) => (message.params?.threadId ?? message.params?.thread?.id) === thread.id));
    assert.ok(events.some((message) => message.method === "turn/started"));
    assert.ok(events.some((message) => message.method === "item/started"));
    assert.ok(events.some((message) => message.method === "item/completed"));
    assert.equal((await control.request("broker/status", { threadId: thread.id })).turnId, null);
  }
  assert.deepEqual(controlEvents, []);
  const [{ turn: nextFirst }, { turn: nextSecond }] = await Promise.all([
    second.request("turn/start", { threadId: h.thread.id, input: [{ type: "text", text: "next first" }] }),
    h.owner.request("turn/start", { threadId: secondThread.id, input: [{ type: "text", text: "next second" }] })
  ]);
  await waitFor(() => secondEvents.some((message) => message.method === "turn/completed" && message.params.turn.id === nextFirst.id)
    && h.notifications.some((message) => message.method === "turn/completed" && message.params.turn.id === nextSecond.id));
});

test("idle broker stays alive with an owner, exits after disconnect, and is replaced on the next request", async (t) => {
  const h = await setup(t, 600000, 250);
  process.env.CLAUDE_PLUGIN_DATA = h.env.CLAUDE_PLUGIN_DATA;
  saveBrokerSession(h.repo, { endpoint: h.endpoint, pidFile: h.pidFile, sessionDir: h.socketDir, pid: h.broker.pid });
  t.after(() => shutdownTestBrokers(h.env.CLAUDE_PLUGIN_DATA));
  await h.start("hold");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.broker.exitCode, null);
  await h.owner.close();
  await waitFor(() => h.broker.exitCode !== null);
  assert.equal(await h.closed, 0);
  assert.equal(fs.existsSync(h.pidFile), false);
  const replacement = await ensureBrokerSession(h.repo, { env: h.env });
  assert.ok(replacement);
  assert.notEqual(replacement.pid, h.broker.pid);
  assert.notEqual(replacement.endpoint, h.endpoint);
  assert.equal(await waitForBrokerEndpoint(replacement.endpoint), true);
});

test("concurrent processes share one cold-started broker and recover a departed startup lock owner", async (t) => {
  const h = await setup(t);
  process.env.CLAUDE_PLUGIN_DATA = h.env.CLAUDE_PLUGIN_DATA;
  t.after(() => shutdownTestBrokers(h.env.CLAUDE_PLUGIN_DATA));
  const source = `import { ensureBrokerSession } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href)};
console.log(JSON.stringify(await ensureBrokerSession(process.cwd())));`;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: h.repo, env: h.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
    t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
    return { child, done };
  });
  const results = await Promise.all(children.map((entry) => entry.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const sessions = results.map((result) => JSON.parse(result.stdout));
  assert.equal(sessions[0].endpoint, sessions[1].endpoint);
  assert.equal(sessions[0].pid, sessions[1].pid);
  assert.equal(h.requests().filter((request) => request.method === "initialize").length, 2);
  const stateRoot = path.join(h.env.CLAUDE_PLUGIN_DATA, "state");
  const lockFile = path.join(stateRoot, fs.readdirSync(stateRoot)[0], "broker.lock");
  fs.writeFileSync(lockFile, `${children[0].child.pid}\n`);
  const recovered = await ensureBrokerSession(h.repo, { env: h.env });
  assert.equal(recovered.endpoint, sessions[0].endpoint);
  assert.equal(fs.existsSync(lockFile), false);
});

test("stale steering is rejected without adding a pending message", async (t) => {
  const h = await setup(t);
  await h.start("hold");
  const control = await h.connect();
  await assert.rejects(control.request("turn/steer", { threadId: h.thread.id, expectedTurnId: "old",
    input: [{ type: "text", text: "wrong" }] }), /turn mismatch/);
  assert.deepEqual((await control.request("broker/status", { threadId: h.thread.id })).pendingMessages, []);
});

test("question responses use the original request ID and reject incorrect answers", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("ask");
  const control = await h.connect();
  const snapshot = await waitFor(async () => {
    const state = await control.request("broker/status", { threadId: h.thread.id });
    return state.questions.length ? state : null;
  });
  assert.equal(snapshot.questions[0].requestId, "question-1");
  const params = { threadId: h.thread.id, turnId: turn.id, requestId: "question-1" };
  await assert.rejects(control.request("broker/answer", { ...params, turnId: "old", answers: { source: { answers: ["wrong turn"] } } }), /turn mismatch/);
  await assert.rejects(control.request("broker/answer", { ...params, answers: { wrong: { answers: ["latest"] } } }), /question/);
  await control.request("broker/answer", { ...params, answers: { source: { answers: ["latest"] } } });
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  assert.match(h.notifications.find((item) => item.params?.item?.type === "agentMessage").params.item.text, /latest/);
  await assert.rejects(control.request("broker/answer", { ...params, answers: { source: { answers: ["again"] } } }), /pending/);
});

test("unanswered questions interrupt with an explicit timeout", async (t) => {
  const h = await setup(t, 80);
  await h.start("ask");
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  const control = await h.connect();
  const snapshot = await control.request("broker/status", { threadId: h.thread.id });
  assert.match(snapshot.error, /answer.*timed out/i);
  assert.deepEqual(snapshot.questions, []);
});

test("continue --write overrides a loaded read-only thread at turn/start", async (t) => {
  const h = await setup(t);
  const initial = h.cli("task", "initial");
  assert.equal(initial.status, 0, initial.stderr);
  const threadId = JSON.parse(initial.stdout).threadId;
  const resumed = h.cli("task", "--thread", threadId, "--write", "write latest");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).threadId, threadId);
  assert.equal(fs.readFileSync(path.join(h.repo, "written.txt"), "utf8"), "write latest");
  fs.unlinkSync(path.join(h.repo, "written.txt"));
  const readonly = h.cli("task", "--thread", threadId, "write forbidden");
  assert.equal(readonly.status, 1);
  assert.equal(fs.existsSync(path.join(h.repo, "written.txt")), false);
});

async function startJob(t, h, prompt, options = ["--write"]) {
  const child = spawn(process.execPath, [SCRIPT, "task", ...options, "--json", prompt], { cwd: h.repo, env: h.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
  const job = await waitFor(() => {
    const result = h.cli("status");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).running.find((item) => item.pid === child.pid && item.threadId && item.turnId);
  });
  return { job, done, child };
}

test("concurrent task jobs share a repository and retain both results and progress logs", async (t) => {
  const h = await setup(t);
  const jobs = await Promise.all([startJob(t, h, "hold first"), startJob(t, h, "hold second")]);
  assert.notEqual(jobs[0].job.threadId, jobs[1].job.threadId);
  const status = h.cli("status");
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running.map((job) => job.id).sort(), jobs.map(({ job }) => job.id).sort());
  const control = await h.connect();
  await Promise.all(jobs.map(({ job }) => control.request("turn/steer", {
    threadId: job.threadId, expectedTurnId: job.turnId, input: [{ type: "text", text: "finish" }]
  })));
  const results = await Promise.all(jobs.map(({ done }) => done));
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).threadId, jobs[index].job.threadId);
    const finished = h.cli("status", jobs[index].job.id);
    assert.equal(finished.status, 0, finished.stderr);
    const job = JSON.parse(finished.stdout).job;
    assert.equal(job.status, "completed");
    assert.ok(fs.existsSync(job.logFile));
    assert.match(fs.readFileSync(job.logFile, "utf8"), /Turn completed/);
  }
});

test("message --interrupt continues the original job and reports retained changes", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold");
  const redirected = h.cli("message", job.id, "--interrupt", "write redirected");
  assert.equal(redirected.status, 0, redirected.stderr);
  const report = JSON.parse(redirected.stdout);
  assert.equal(report.threadId, job.threadId);
  assert.deepEqual(report.partialChanges, [{ path: path.join(fs.realpathSync(h.repo), "partial.txt"), status: "completed" }]);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, job.threadId);
  assert.equal(payload.interruptedTurns[0].turnId, job.turnId);
  assert.match(report.workspaceStatus, /partial.txt/);
  assert.equal(fs.readFileSync(path.join(h.repo, "partial.txt"), "utf8"), "partial");
  assert.equal(fs.readFileSync(path.join(h.repo, "written.txt"), "utf8"), "write redirected");
});

test("CLI status exposes questions and answer resumes the original job", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "ask");
  const status = h.cli("status", job.id);
  assert.equal(status.status, 0, status.stderr);
  const question = JSON.parse(status.stdout).job.live.questions[0];
  assert.equal(question.requestId, "question-1");
  const stateRoot = path.join(h.env.CLAUDE_PLUGIN_DATA, "state");
  const stateFile = path.join(stateRoot, fs.readdirSync(stateRoot)[0], "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs.find((entry) => entry.id === job.id).phase = "running";
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).waitingForAnswer, true);
  const forbidden = h.cli("message", job.id, "latest");
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /pending question/);
  fs.writeFileSync(path.join(h.repo, "answers.json"), JSON.stringify({ source: { answers: ["latest"] } }));
  const answered = h.cli("answer", job.id, "--request-id", "question-1", "--answers-file", "answers.json");
  assert.equal(answered.status, 0, answered.stderr);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, job.threadId);
  assert.match(JSON.parse(result.stdout).rawOutput, /latest/);
});

test("unrelated approval requests are not auto-approved", async (t) => {
  const h = await setup(t);
  await h.start("approve");
  await waitFor(() => h.notifications.some((message) => message.method === "turn/completed"));
  const final = h.notifications.find((message) => message.params?.item?.type === "agentMessage");
  assert.match(final.params.item.text, /Unsupported server request/);
  const control = await h.connect();
  assert.deepEqual((await control.request("broker/status", { threadId: h.thread.id })).questions, []);
});

test("interruption reports changes that finish during cancellation", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("hold-late");
  const control = await h.connect();
  const report = await control.request("turn/interrupt", { threadId: h.thread.id, turnId: turn.id });
  assert.deepEqual(report.partialChanges.map((entry) => path.basename(entry.path)), ["partial.txt", "late.txt"]);
  assert.match(report.workspaceStatus, /late.txt/);
});

test("final text does not mark an ordinary task successful before its terminal event", async (t) => {
  const h = await setup(t);
  const result = h.cli("task", "fail-late");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 1);
});

test("director notifications reply immediately, survive turns, and acknowledge only selected IDs", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("notify:Use the alternate source");
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  const response = h.requests().find((item) => item.id === `tool-${turn.id}`);
  assert.deepEqual(response.result, {
    contentItems: [{ type: "inputText", text: "Delivered to the director." }], success: true
  });
  const first = await h.owner.request("broker/status", { threadId: h.thread.id });
  assert.equal(first.notifications.length, 1);
  const notification = first.notifications[0];
  assert.deepEqual(Object.keys(notification).sort(), ["id", "message", "receivedAt", "turnId"]);
  assert.equal(typeof notification.id, "string");
  assert.ok(notification.id.length > 0);
  assert.equal(notification.message, "Use the alternate source");
  assert.equal(notification.turnId, turn.id);
  assert.equal(new Date(notification.receivedAt).toISOString(), notification.receivedAt);
  assert.deepEqual(h.notifications.find((item) => item.method === "companion/notification").params,
    { threadId: h.thread.id, ...notification });
  await h.start("hold notify:Phase two ready");
  const second = await waitFor(async () => {
    const state = await h.owner.request("broker/status", { threadId: h.thread.id });
    return state.notifications.length === 2 ? state : null;
  });
  assert.notEqual(second.notifications[1].id, notification.id);
  assert.deepEqual(await h.owner.request("broker/ack-notifications", {
    threadId: h.thread.id, ids: [notification.id, "not-pending"]
  }), { remaining: 1 });
  assert.deepEqual((await h.owner.request("broker/status", { threadId: h.thread.id })).notifications,
    [second.notifications[1]]);
});

test("invalid director notifications and unknown tools do not create notifications", async (t) => {
  const h = await setup(t);
  for (const input of ["notify-invalid", "notify-missing", "unknown-tool", `notify:${"a".repeat(401)}`]) {
    const { turn } = await h.start(input);
    const response = await waitFor(() => h.requests().find((item) => item.id === `tool-${turn.id}`));
    if (input === "unknown-tool") {
      assert.equal(response.error.code, -32601);
      assert.match(response.error.message, /Unsupported server request/);
    } else {
      assert.equal(response.result.success, false);
      assert.equal(response.result.contentItems[0].type, "inputText");
      assert.match(response.result.contentItems[0].text, input.startsWith("notify:") ? /400/ : /message.*string/i);
    }
    await waitFor(() => h.notifications.some((item) => item.method === "turn/completed" && item.params.turn.id === turn.id));
    assert.deepEqual((await h.owner.request("broker/status", { threadId: h.thread.id })).notifications, []);
  }
  const message = "😀".repeat(400);
  const { turn } = await h.start(`notify:${message}`);
  const response = await waitFor(() => h.requests().find((item) => item.id === `tool-${turn.id}`));
  assert.equal(response.result.success, true);
  assert.equal((await h.owner.request("broker/status", { threadId: h.thread.id })).notifications[0].message, message);
});

test("plain status retains notifications and status --wait consumes them once while work continues", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold notify:Build phase ready");
  const plain = h.cli("status", job.id);
  assert.equal(plain.status, 0, plain.stderr);
  const notification = JSON.parse(plain.stdout).job.live.notifications[0];
  assert.equal(notification.message, "Build phase ready");
  assert.deepEqual((await h.owner.request("broker/status", { threadId: job.threadId })).notifications, [notification]);
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  const report = JSON.parse(waiting.stdout);
  assert.equal(report.hasNotifications, true);
  assert.equal(report.waitTimedOut, false);
  assert.equal(report.timeoutMs, 5000);
  assert.equal(report.job.status, "running");
  assert.equal(report.job.phase, "notified");
  assert.deepEqual(report.job.live.notifications, [notification]);
  assert.deepEqual((await h.owner.request("broker/status", { threadId: job.threadId })).notifications, []);
  const again = h.cli("status", job.id, "--wait", "--timeout-ms", "150");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).hasNotifications, undefined);
  assert.equal(JSON.parse(again.stdout).waitTimedOut, true);
  assert.match(fs.readFileSync(report.job.logFile, "utf8"), /Build phase ready/);
  const finished = h.cli("message", job.id, "finish");
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal((await done).code, 0);
});

test("status --wait does not acknowledge notifications after the job completes", async (t) => {
  const h = await setup(t);
  const task = h.cli("task", "notify:Final phase ready");
  assert.equal(task.status, 0, task.stderr);
  const status = h.cli("status");
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).latestFinished;
  const before = await h.owner.request("broker/status", { threadId: job.threadId });
  assert.equal(before.notifications[0].message, "Final phase ready");
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).hasNotifications, undefined);
  assert.equal(JSON.parse(waiting.stdout).waitTimedOut, false);
  assert.deepEqual((await h.owner.request("broker/status", { threadId: job.threadId })).notifications,
    before.notifications);
  assert.match(fs.readFileSync(job.logFile, "utf8"), /\] Notification: Final phase ready\n/);
  const empty = h.cli("task", "notify:");
  assert.equal(empty.status, 0, empty.stderr);
  const emptyJob = JSON.parse(h.cli("status").stdout).latestFinished;
  assert.match(fs.readFileSync(emptyJob.logFile, "utf8"), /\] Notification:\n/);
});

test("pending questions take precedence over director notifications", async (t) => {
  const h = await setup(t);
  const { job } = await startJob(t, h, "ask notify:Need a source decision");
  await waitFor(async () => (await h.owner.request("broker/status", { threadId: job.threadId })).questions.length);
  const result = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.waitingForAnswer, true);
  assert.equal(report.hasNotifications, undefined);
  assert.equal(report.job.live.notifications[0].message, "Need a source decision");
  assert.deepEqual((await h.owner.request("broker/status", { threadId: job.threadId })).notifications,
    report.job.live.notifications);
});

test("task thread starts declare notify_director and initialize enables experimental API", async (t) => {
  const h = await setup(t);
  const task = h.cli("task", "initial");
  assert.equal(task.status, 0, task.stderr);
  const threadId = JSON.parse(task.stdout).threadId;
  const requests = h.requests();
  assert.equal(requests.find((item) => item.method === "initialize").params.capabilities.experimentalApi, true);
  const starts = requests.filter((item) => item.method === "thread/start");
  assert.equal(starts[0].params.dynamicTools, undefined);
  assert.deepEqual(starts[1].params.dynamicTools, [{
    type: "function", name: "notify_director",
    description: "Send a short note to the director agent that started you, without stopping your work. Use it only for conclusions that change the plan, blockers you are working around, or a finished phase the director could act on now. Do not report routine progress. Returns immediately; the director does not reply through this tool. Notes longer than 400 characters are rejected.",
    inputSchema: { type: "object", properties: { message: { type: "string", maxLength: 400 } }, required: ["message"], additionalProperties: false },
    deferLoading: false
  }]);
  const resumed = h.cli("task", "--thread", threadId, "continue");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(h.requests().find((item) => item.method === "thread/resume").params.dynamicTools, undefined);
});

function startEvents(t, h) {
  const child = spawn(process.execPath, [SCRIPT, "events", "--cwd", h.repo, "--poll-ms", "20"], {
    cwd: h.repo, env: h.env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
  return { child, done, lines: () => stdout.split("\n").slice(0, -1) };
}

test("events emits one notification and one completion, acknowledges the note, and exits cleanly on SIGINT", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold notify:Build phase ready");
  const events = startEvents(t, h);
  const notified = `NOTIFIED job=${job.id} thread=${job.threadId} Build phase ready`;
  const completed = `DONE job=${job.id} thread=${job.threadId}`;
  await waitFor(() => events.lines().includes(notified));
  await waitFor(async () => !(await h.owner.request("broker/status", { threadId: job.threadId })).notifications.length);
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "150");
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).hasNotifications, undefined);
  assert.equal(JSON.parse(waiting.stdout).waitTimedOut, true);
  const finished = h.cli("message", job.id, "finish");
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal((await done).code, 0);
  await waitFor(() => events.lines().includes(completed));
  events.child.kill("SIGINT");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [notified, completed]);
});

test("events exits cleanly on SIGTERM while the task remains active", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold notify:Listener ready");
  const events = startEvents(t, h);
  await waitFor(() => events.lines().some((line) => line.startsWith(`NOTIFIED job=${job.id} `)));
  events.child.kill("SIGTERM");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(JSON.parse(h.cli("status", job.id).stdout).job.status, "running");
  const finished = h.cli("message", job.id, "finish");
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal((await done).code, 0);
});

test("events and status --wait report a killed task owner as failed once", async (t) => {
  const h = await setup(t);
  const { job, done, child } = await startJob(t, h, "hold notify:Owner ready");
  const events = startEvents(t, h);
  await waitFor(() => events.lines().some((line) => line.startsWith(`NOTIFIED job=${job.id} `)));
  child.kill("SIGKILL");
  await done;
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  const snapshot = JSON.parse(waiting.stdout);
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.waitTimedOut, false);
  assert.match(snapshot.job.errorMessage, /owner process exited/i);
  const failed = `FAILED job=${job.id} thread=${job.threadId} owner process exited`;
  await waitFor(() => events.lines().includes(failed));
  events.child.kill("SIGTERM");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(events.lines().filter((line) => line.startsWith("FAILED ")), [failed]);
  assert.equal(JSON.parse(h.cli("status", job.id).stdout).job.status, "failed");
});

test("events and status --wait report a quiet live task as stalled without failing it", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold notify:Owner ready");
  const notified = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(notified.status, 0, notified.stderr);
  assert.equal(JSON.parse(notified.stdout).hasNotifications, true);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(job.logFile, old, old);
  const events = startEvents(t, h);
  await waitFor(() => events.lines().some((line) => line === `STALLED job=${job.id} thread=${job.threadId} 20m without progress`));
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  const snapshot = JSON.parse(waiting.stdout);
  assert.equal(snapshot.stalled, true);
  assert.equal(snapshot.waitTimedOut, false);
  assert.equal(snapshot.job.status, "running");
  const again = h.cli("status", job.id, "--wait", "--timeout-ms", "150");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).stalled, undefined);
  assert.equal(JSON.parse(again.stdout).waitTimedOut, true);
  events.child.kill("SIGTERM");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events.lines().filter((line) => line.startsWith("STALLED ")).length, 1);
  assert.equal(h.cli("message", job.id, "finish").status, 0);
  assert.equal((await done).code, 0);
});

test("task sandbox and network options are persisted and preserved through interrupt redirects", async (t) => {
  const h = await setup(t);
  for (const { options, sandbox, policy } of [
    { options: ["--sandbox", "danger-full-access"], sandbox: "danger-full-access", policy: { type: "dangerFullAccess" } },
    { options: ["--write", "--network"], sandbox: "workspace-write", policy: {
      type: "workspaceWrite", writableRoots: [fs.realpathSync(h.repo)], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false
    } }
  ]) {
    const { job, done } = await startJob(t, h, "hold", options);
    const status = h.cli("status", job.id);
    assert.equal(status.status, 0, status.stderr);
    const current = JSON.parse(status.stdout).job;
    assert.equal(current.sandbox, sandbox);
    assert.equal(current.request.sandbox, sandbox);
    assert.equal(current.write, true);
    assert.equal(current.network, sandbox === "workspace-write");
    assert.equal(current.request.network, sandbox === "workspace-write");
    const started = h.requests().filter((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].params.sandboxPolicy, policy);
    const redirected = h.cli("message", job.id, "--interrupt", "write redirected");
    assert.equal(redirected.status, 0, redirected.stderr);
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
    const turns = h.requests().filter((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[1].params.sandboxPolicy, policy);
    assert.equal(fs.readFileSync(path.join(h.repo, "written.txt"), "utf8"), "write redirected");
  }
  const readonly = h.cli("task", "--write", "--sandbox", "read-only", "initial");
  assert.equal(readonly.status, 0, readonly.stderr);
  const job = JSON.parse(h.cli("status").stdout).latestFinished;
  assert.equal(job.sandbox, "read-only");
  assert.equal(job.write, false);
  const started = h.requests().find((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
  assert.deepEqual(started.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
});
