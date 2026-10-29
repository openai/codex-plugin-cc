import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { listSessions, listQueue, sendSession, readPages, nativeQueue, normalizeThreadId } from "../plugins/codex/scripts/lib/sessions.mjs";

const ID = "00000000-0000-4000-8000-000000000001";
const RECEIPT = "00000000-0000-4000-8000-000000000002";
const THREAD = { id: ID, name: "Existing chat", cwd: "/project", model: "selected-model", reasoningEffort: "high" };
const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-sessions.mjs", import.meta.url));

test("pagination retains filters and fails on repeated cursors or malformed pages", async () => {
  const calls = [];
  const rpc = { request: async (method, params) => {
    calls.push(params);
    return params.cursor ? { data: [2], nextCursor: null } : { data: [1], nextCursor: "next" };
  } };
  assert.deepEqual(await readPages(rpc, "thread/list", { archived: true }), [1, 2]);
  assert.equal(calls[1].archived, true);
  assert.equal(calls[1].cursor, "next");
  await assert.rejects(readPages({ request: async () => ({ data: [], nextCursor: "loop" }) }, "thread/list"), /Repeated/);
  for (const result of [{}, { data: [], nextCursor: 1 }]) {
    await assert.rejects(readPages({ request: async () => result }, "thread/list"), /Invalid/);
  }
});

test("listing groups one unfiltered thread enumeration by actual sections", async () => {
  const calls = [];
  const rpc = { request: async (method, params) => {
    calls.push([method, params]);
    if (method === "threadSection/list") return { data: [{ id: "s", name: "Work" }, { id: "empty", name: "Empty" }] };
    return { data: [{ ...THREAD, section: { id: "s", name: "Work" } }, { ...THREAD, id: RECEIPT, name: null }] };
  } };
  const result = await listSessions(rpc, { archived: true });
  assert.equal(result.sections[0].threads[0].id, ID);
  assert.deepEqual(result.sections[1].threads, []);
  assert.equal(result.sections[2].name, "Unsectioned");
  assert.equal(result.sections[2].threads[0].title, RECEIPT);
  const params = calls.find(([method]) => method === "thread/list")[1];
  assert.equal(params.archived, true);
  assert.equal("sectionId" in params, false);
  assert.deepEqual(params.modelProviders, []);
  assert.ok(params.sourceKinds.includes("appServer"));
  assert.ok(params.sourceKinds.includes("subAgent"));
  assert.equal(result.scope, "local");
  assert.equal(result.consistency, "best-effort; not an atomic snapshot");
});

test("listing keeps newly observed sections but rejects duplicated thread IDs", async () => {
  const rpc = { request: async (method) => ({ data: method === "threadSection/list" ? [] : [{ ...THREAD, section: { id: "new", name: "New" } }] }) };
  assert.equal((await listSessions(rpc)).sections[1].name, "New");
  await assert.rejects(listSessions({ request: async (method) => ({ data: method === "threadSection/list" ? [] : [THREAD, THREAD] }) }), /changed during/);
});

test("send previews only metadata; explicit execution queues exactly once without settings overrides", async () => {
  const calls = [];
  const rpc = { request: async (...args) => { calls.push(args); return { thread: THREAD }; } };
  let writes = 0;
  const queue = async (threadId, message) => { writes++; assert.equal(threadId, ID); assert.equal(message, "Follow up"); return RECEIPT; };
  const preview = await sendSession(rpc, { threadId: ID, message: "Follow up" }, queue);
  assert.equal(preview.state, "PREVIEW");
  assert.equal(preview.target.model, "selected-model");
  assert.equal(writes, 0);
  assert.deepEqual(calls, [["thread/read", { threadId: ID, includeTurns: false }]]);
  const result = await sendSession(rpc, { threadId: ID, message: "Follow up", execute: true }, queue);
  assert.equal(writes, 1);
  assert.equal(result.state, "QUEUED");
  assert.equal(result.queuedSubmissionId, RECEIPT);
  assert.equal(result.execution, "not confirmed");
  assert.equal(result.target.reasoningEffort, "high");
});

test("invalid identifiers and messages fail before RPC; mismatched identity cannot queue", async () => {
  assert.equal(normalizeThreadId(ID.toUpperCase()), ID);
  for (const id of ["Existing chat", "", undefined, ID + " --model other"]) assert.throws(() => normalizeThreadId(id), /UUID/);
  const rpc = { request: () => { throw new Error("must not read"); } };
  for (const message of ["", " ", "nul\0byte", "é".repeat(32769)]) {
    await assert.rejects(sendSession(rpc, { threadId: ID, message, execute: true }), /message|KiB/i);
  }
  await assert.rejects(sendSession({ request: async () => ({ thread: { ...THREAD, id: RECEIPT } }) }, { threadId: ID, message: "test", execute: true }), /identity mismatch/);
});

test("uncertain sends are never retried and receipt identity is verified", async () => {
  let attempts = 0;
  const run = async () => { attempts++; throw new Error("private command output"); };
  await assert.rejects(nativeQueue(ID, "test", run), /UNKNOWN/);
  assert.equal(attempts, 1);
  for (const stdout of ["", `Queued message ${RECEIPT} for thread ${RECEIPT}.`, `Queued message invalid for thread ${ID}.`]) {
    await assert.rejects(nativeQueue(ID, "test", async () => ({ stdout })), /UNKNOWN/);
  }
  assert.equal(await nativeQueue(ID, "test", async () => ({ stdout: `Queued message ${RECEIPT} for thread ${ID}.\n` })), RECEIPT);
});

test("pending queue output excludes message bodies", async () => {
  const result = await listQueue({ request: async () => ({ data: [{ id: RECEIPT, clientUserMessageId: "request", input: [{ text: "private" }] }] }) }, ID);
  assert.deepEqual(result.queue, [{ id: RECEIPT, requestId: "request" }]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

function fakeRuntime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
if (args[0] === "queue") {
  fs.appendFileSync(log, JSON.stringify({ args }) + "\\n");
  console.log("Queued message ${RECEIPT} for thread ${ID}.");
} else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("close", () => process.exit(0));
  lines.on("line", line => {
    const m = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify(m) + "\\n");
    if (m.id === undefined || m.method === process.env.CODEX_SESSIONS_TEST_HANG) return;
    const result = m.method === "thread/read" ? { thread: ${JSON.stringify(THREAD)} } : {};
    console.log(JSON.stringify({ id: m.id, result }));
  });
}
`, { mode: 0o755 });
  return { dir, log, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, CODEX_COMPANION_APP_SERVER_ENDPOINT: "invalid-inherited-endpoint" } };
}

test("CLI previews and executes literal UTF-8 stdin without shell expansion or broker reuse", { skip: process.platform === "win32" }, (t) => {
  const f = fakeRuntime(t);
  const marker = path.join(f.dir, "injected");
  const message = `Zażółć 🐟\n$(touch ${marker}) \`touch ${marker}\` ' " ;`;
  const args = [SCRIPT, "send", "--thread", ID];
  const preview = spawnSync(process.execPath, args, { cwd: f.dir, env: f.env, input: message, encoding: "utf8", timeout: 5000 });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).state, "PREVIEW");
  assert.equal(fs.readFileSync(f.log, "utf8").includes('"args"'), false);
  const sent = spawnSync(process.execPath, [...args, "--execute"], { cwd: f.dir, env: f.env, input: message, encoding: "utf8", timeout: 5000 });
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).state, "QUEUED");
  const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.filter(c => c.args).map(c => c.args), [["queue", "--thread", ID, "--message", message]]);
  assert.ok(calls.filter(c => c.method === "initialize").every(c => c.params.capabilities.experimentalApi === true));
  assert.equal(fs.existsSync(marker), false);
});

test("CLI rejects misplaced flags before starting Codex", { skip: process.platform === "win32" }, (t) => {
  const f = fakeRuntime(t);
  for (const args of [["sessions", "--execute"], ["send", "--archived", "--thread", ID], ["queue", "--execute", "--thread", ID], ["send", "--thread", "latest"]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: f.env, input: "test", encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(f.log), false);
  }
});


test("metadata request deadlines reject and close the direct connection", { skip: process.platform === "win32" }, async (t) => {
  const f = fakeRuntime(t);
  await assert.rejects(CodexAppServerClient.connect(f.dir, {
    disableBroker: true, requestTimeoutMs: 150,
    env: { ...f.env, CODEX_SESSIONS_TEST_HANG: "initialize" }
  }), /timed out/);
  const client = await CodexAppServerClient.connect(f.dir, {
    disableBroker: true, requestTimeoutMs: 500,
    env: { ...f.env, CODEX_SESSIONS_TEST_HANG: "thread/list" }
  });
  try {
    await assert.rejects(client.request("thread/list", {}), /timed out/);
    assert.equal(client.pending.size, 0);
  } finally {
    await client.close();
  }
  assert.equal(client.proc.exitCode, 0);
});
