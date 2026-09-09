import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/codex/scripts/", import.meta.url));
const enabled = process.env.CODEX_REAL_APP_SERVER_TEST === "1";

test("installed app-server: question, notifications, loaded-thread write, steering, and interruption", { skip: !enabled, timeout: 120000 }, async (t) => {
  isolateTestEnvironment(t);
  const repo = fs.realpathSync(makeTempDir());
  const home = makeTempDir();
  const socketDir = makeTempDir("cxr-");
  initGitRepo(repo);
  const requests = [];
  const paths = [];
  let serverError = null;
  const call = (name, args, id) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
  const final = (text) => ({ type: "message", role: "assistant", id: "final", content: [{ type: "output_text", text }] });
  const server = http.createServer(async (req, res) => {
    paths.push(`${req.method} ${req.url}`);
    try {
      if (req.method !== "POST" || !req.url.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") body = zlib.zstdDecompressSync(body);
      if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
      requests.push(JSON.parse(body));
      const count = requests.length;
      const item = count === 1 ? call("request_user_input", { questions: [{ id: "source", header: "Source",
        question: "Which source?", options: [{ label: "Latest", description: "Read the latest plan." },
          { label: "Stored", description: "Read the stored plan." }] }] }, "question")
        : count === 2 || count === 4 ? call("notify_director", { message: count === 2 ? "Latest source selected." : "Resumed work can notify." }, `notification-${count}`)
        : count === 5 ? call("exec_command", { cmd: "node -e \"require('fs').writeFileSync('live-proof.mjs', 'export const value = 2;\\n'); require('child_process').execFileSync(process.execPath, ['--check', 'live-proof.mjs']); setTimeout(() => {}, 2000)\"",
          yield_time_ms: 10000 }, "write")
        : count === 7 ? call("exec_command", { cmd: "node -e \"require('fs').writeFileSync('shell-partial.txt', 'partial'); setTimeout(() => {}, 20000)\"", yield_time_ms: 10000 }, "partial")
        : final(count === 3 ? "answer received" : "write and steering complete");
      const id = `response-${count}`;
      const events = [{ type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      serverError = error;
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-5.4"
model_provider = "local_test"
[model_providers.local_test]
name = "Local test"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
shell_snapshot = false
code_mode = false
unified_exec = true
`);
  const endpoint = createBrokerEndpoint(socketDir);
  const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", CODEX_HOME: home, CODEX_SQLITE_HOME: home,
    CLAUDE_PLUGIN_DATA: path.join(home, "plugin-data"), CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
  const children = [];
  const launch = (script, args) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: repo, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
    children.push({ child, done, inspect: () => ({ script, args, pid: child.pid, exitCode: child.exitCode, stdout: stdout.slice(-1000), stderr: stderr.slice(-2000) }) });
    return done;
  };
  launch("app-server-broker.mjs", ["serve", "--cwd", repo, "--endpoint", endpoint]);
  let control;
  t.after(async () => {
    if (t.signal.aborted || serverError || requests.length !== 8) {
      t.diagnostic(JSON.stringify({ paths, requests: requests.length, processes: children.slice(-3).map((entry) => entry.inspect()) }));
    }
    await control?.close();
    await sendBrokerShutdown(endpoint);
    for (const entry of children) {
      if (entry.child.exitCode === null) entry.child.kill();
      await entry.done;
    }
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 15000), true);
  control = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 400; i += 1) {
      t.signal.throwIfAborted();
      if (serverError) throw serverError;
      const result = await predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No progress; model requests: ${JSON.stringify(requests)}`);
  };
  const first = launch("codex-companion.mjs", ["task", "--json", "Ask which source to use."]);
  const job = await waitFor(async () => {
    const status = await launch("codex-companion.mjs", ["status", "--json"]);
    const snapshot = JSON.parse(status.stdout);
    if (snapshot.latestFinished) {
      const result = await first;
      throw new Error(`Question was not held: ${result.stdout} ${result.stderr}; tool outputs: ${JSON.stringify(requests.flatMap((r) => r.input.filter((item) => item.type.includes("output"))))}`);
    }
    return snapshot.running.find((entry) => entry.live?.questions?.length);
  });
  const question = job.live.questions[0];
  await control.request("broker/answer", { threadId: job.threadId, turnId: question.turnId,
    requestId: question.requestId, answers: { source: { answers: ["Latest"] } } });
  const firstResult = await first;
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.match(JSON.stringify(requests[1].input), /Latest/);
  assert.ok(requests[0].tools.some((tool) => tool.name === "notify_director"));
  assert.match(JSON.stringify(requests[2].input), /Delivered to the director\./);
  const notified = await control.request("broker/status", { threadId: job.threadId });
  assert.equal(notified.notifications[0].message, "Latest source selected.");

  const second = launch("codex-companion.mjs", ["task", "--thread", job.threadId, "--write", "--json", "Write and validate the module."]);
  await waitFor(() => requests.length === 5);
  const live = await control.request("broker/status", { threadId: job.threadId });
  assert.ok(requests[3].tools.some((tool) => tool.name === "notify_director"));
  assert.match(JSON.stringify(requests[4].input), /Delivered to the director\./);
  assert.deepEqual(live.notifications.map((notification) => notification.message), ["Latest source selected.", "Resumed work can notify."]);
  await control.request("turn/steer", { threadId: job.threadId, expectedTurnId: live.turnId,
    input: [{ type: "text", text: "Use the latest plan, never the stored chargeId." }] });
  const secondResult = await second;
  assert.equal(secondResult.code, 0, secondResult.stderr);
  assert.equal(JSON.parse(secondResult.stdout).threadId, job.threadId);
  assert.equal(fs.readFileSync(path.join(repo, "live-proof.mjs"), "utf8"), "export const value = 2;\n");
  assert.match(JSON.stringify(requests[5].input), /Use the latest plan/);
  assert.match(JSON.stringify(requests[5].input), /Process exited with code 0/);

  const third = launch("codex-companion.mjs", ["task", "--thread", job.threadId, "--write", "--json", "Start the next change."]);
  await waitFor(() => fs.existsSync(path.join(repo, "shell-partial.txt")));
  const current = await control.request("broker/status", { threadId: job.threadId });
  const interruption = await control.request("broker/redirect", { threadId: job.threadId, turnId: current.turnId,
    input: [{ type: "text", text: "Stop this approach and report the retained file." }] });
  assert.match(interruption.workspaceStatus, /shell-partial.txt/);
  const thirdResult = await third;
  assert.equal(thirdResult.code, 0, thirdResult.stderr);
  const payload = JSON.parse(thirdResult.stdout);
  assert.equal(payload.threadId, job.threadId);
  assert.equal(payload.interruptedTurns[0].turnId, current.turnId);
  assert.equal(fs.readFileSync(path.join(repo, "shell-partial.txt"), "utf8"), "partial");
});
