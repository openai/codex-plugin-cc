// Runs /codex:sessions, send and queue against the real `codex` binary.
// No account or network is needed: an isolated CODEX_HOME points Codex at a
// loopback Responses API stub, so reviewers can verify the integration locally.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-sessions.mjs", import.meta.url));
const REPLY = "LIVE_STUB_OK";
const MESSAGE = `Reply only ${REPLY}; zażółć $(touch injected) \`id\` ' "`;

function nativeQueueSupport() {
  if (process.platform === "win32") return "Windows execution is unverified";
  const help = spawnSync("codex", ["queue", "--help"], { encoding: "utf8", timeout: 10000 });
  if (help.error) return "codex is not installed";
  return help.status === 0 ? null : "this codex version has no native queue";
}

const skip = nativeQueueSupport() ?? false;

function startModelStub(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(body);
      const n = requests.length;
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      send("response.created", { response: { id: `resp_${n}` } });
      send("response.output_item.done", {
        item: { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: REPLY }] }
      });
      send("response.completed", { response: { id: `resp_${n}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests })));
}

async function isolatedCodex(t) {
  const root = makeTempDir("codex-sessions-live-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const stub = await startModelStub(t);
  fs.writeFileSync(path.join(home, "config.toml"), `model = "stub-model"
model_provider = "stub"

[model_providers.stub]
name = "stub"
base_url = "http://127.0.0.1:${stub.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);
  const env = { ...process.env, CODEX_HOME: home, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, NO_PROXY: "127.0.0.1" };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_COMPANION_APP_SERVER_ENDPOINT", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    delete env[key];
  }
  return { cwd, env, stub };
}

async function connect(f) {
  return CodexAppServerClient.connect(f.cwd, { disableBroker: true, requestTimeoutMs: 15000, env: f.env });
}

function waitForTurn(client, threadId) {
  let timer;
  const turn = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("turn did not complete")), 20000);
    client.setNotificationHandler((message) => {
      if (message.method === "turn/completed" && message.params.threadId === threadId) resolve(message.params.turn);
    });
  });
  // The caller awaits only after its request succeeds; never leak the timer.
  turn.catch(() => {});
  turn.finally(() => clearTimeout(timer)).catch(() => {});
  return turn;
}

function agentText(turn) {
  return turn.items.filter((item) => item.type === "agentMessage").map((item) => item.text).join("");
}

function plugin(f, args, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: f.cwd, env: f.env, input, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("live Codex: discover, preview, queue and consume a message in an existing session", { skip, timeout: 150000 }, async (t) => {
  const f = await isolatedCodex(t);

  // A queue target needs a persisted rollout, so seed one completed turn.
  const seed = await connect(f);
  let threadId;
  try {
    ({ thread: { id: threadId } } = await seed.request("thread/start", { cwd: f.cwd }));
    const done = waitForTurn(seed, threadId);
    await seed.request("turn/start", { threadId, input: [{ type: "text", text: "seed" }] });
    assert.equal(agentText(await done), REPLY);
  } finally {
    await seed.close();
  }
  const modelCalls = f.stub.requests.length;

  const listing = JSON.parse(plugin(f, ["sessions", "--json"]));
  const listed = listing.sections.flatMap((section) => section.threads).find((thread) => thread.id === threadId);
  assert.ok(listed, `seeded thread missing from ${JSON.stringify(listing)}`);
  assert.equal(fs.realpathSync(listed.cwd), fs.realpathSync(f.cwd));

  const preview = JSON.parse(plugin(f, ["send", "--thread", threadId], MESSAGE));
  assert.equal(preview.state, "PREVIEW");
  assert.deepEqual(JSON.parse(plugin(f, ["queue", "--thread", threadId])).queue, []);

  const sent = JSON.parse(plugin(f, ["send", "--thread", threadId, "--execute"], MESSAGE));
  assert.equal(sent.state, "QUEUED");
  assert.equal(sent.execution, "not confirmed");
  const pending = plugin(f, ["queue", "--thread", threadId]);
  assert.deepEqual(JSON.parse(pending).queue.map((item) => item.id), [sent.queuedSubmissionId]);
  assert.doesNotMatch(pending, /zażółć/);
  assert.equal(f.stub.requests.length, modelCalls, "queueing must not start a turn");
  assert.equal(fs.existsSync(path.join(f.cwd, "injected")), false);

  // Opening the session, as Codex Desktop does, consumes the queued message.
  const owner = await connect(f);
  try {
    const done = waitForTurn(owner, threadId);
    await owner.request("thread/resume", { threadId });
    assert.equal(agentText(await done), REPLY);
  } finally {
    await owner.close();
  }
  assert.ok(f.stub.requests.at(-1).includes(JSON.stringify(MESSAGE).slice(1, -1)), "model did not receive the literal message");
  assert.deepEqual(JSON.parse(plugin(f, ["queue", "--thread", threadId])).queue, []);
});
