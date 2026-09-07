import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

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
async function setup(t, timeoutMs = 600000) {
  const repo = makeTempDir();
  const bin = makeTempDir();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxl-"));
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  initGitRepo(repo);
  const endpoint = createBrokerEndpoint(socketDir);
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"),
    CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
  const broker = spawn(process.execPath, [path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs"),
    "serve", "--endpoint", endpoint, "--cwd", repo, "--input-timeout-ms", String(timeoutMs)], { env });
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
  assert.equal(await waitForBrokerEndpoint(endpoint, 5000), true, errors);
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
  return { repo, env, owner, connect, thread, start, notifications, cli };
}

test("steering from another socket preserves FIFO and the owning event stream", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("hold");
  const control = await h.connect();
  const accepted = await Promise.all(["first", "finish"].map((text) => control.request("turn/steer", {
    threadId: h.thread.id, expectedTurnId: turn.id, clientUserMessageId: text, input: [{ type: "text", text }]
  })));
  assert.deepEqual(accepted.map((result) => result.turnId), [turn.id, turn.id]);
  const snapshot = await control.request("broker/status", { threadId: h.thread.id });
  assert.deepEqual(snapshot.pendingMessages.map((item) => item.id), ["first", "finish"]);
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  const final = h.notifications.find((item) => item.params?.item?.type === "agentMessage");
  assert.equal(final.params.item.text, "hold|first|finish");
  assert.deepEqual((await control.request("broker/status", { threadId: h.thread.id })).pendingMessages, []);
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

async function startJob(t, h, prompt) {
  const child = spawn(process.execPath, [SCRIPT, "task", "--write", "--json", prompt], { cwd: h.repo, env: h.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
  const job = await waitFor(() => {
    const result = h.cli("status");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).running.find((item) => item.threadId && item.turnId);
  });
  return { job, done };
}

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
