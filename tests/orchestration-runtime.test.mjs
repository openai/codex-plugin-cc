import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { ensureControllerServer } from "../plugins/codex/scripts/orchestration/controller-lifecycle.mjs";
import { OrchestrationControllerClient } from "../plugins/codex/scripts/orchestration/controller-client.mjs";

const CLI = fileURLToPath(new URL("../plugins/codex/scripts/orchestration/cli.mjs", import.meta.url));

function installFake(binDir, eventFile) {
  const script = path.join(binDir, "codex");
  writeExecutable(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const events = ${JSON.stringify(eventFile)};
let nextThread = 1;
let nextTurn = 1;
const timers = new Map();
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function event(value) { fs.appendFileSync(events, JSON.stringify({ time: Date.now(), pid: process.pid, ...value }) + "\\n"); }
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli fake"); process.exit(0); }
if (args[0] === "app-server" && args[1] === "--help") { console.log("help"); process.exit(0); }
if (args[0] !== "app-server") process.exit(1);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake" } });
      break;
    case "initialized":
      break;
    case "config/read":
      send({ id: message.id, result: { config: { model_provider: "openai" }, origins: {} } });
      break;
    case "model/list":
      send({
        id: message.id,
        result: {
          data: ["sol", "terra", "luna"].map((name) => ({
            id: "gpt-5.6-" + name,
            model: "gpt-5.6-" + name,
            isDefault: name === "terra",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }))
          })),
          nextCursor: null
        }
      });
      break;
    case "thread/start": {
      const threadId = "thr_" + nextThread++;
      send({
        id: message.id,
        result: {
          thread: { id: threadId },
          model: message.params.model || "gpt-5.6-terra",
          modelProvider: "openai",
          reasoningEffort: message.params.config?.model_reasoning_effort || null
        }
      });
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      break;
    }
    case "turn/start": {
      const threadId = message.params.threadId;
      const turnId = "turn_" + nextTurn++;
      const prompt = (message.params.input || []).map((item) => item.text || "").join("\\n");
      const packageId = (prompt.match(/<orchestration_package_id>([^<]+)/) || [])[1] || "unknown";
      const delayMs = Number((prompt.match(/delay-(\\d+)/) || [])[1] || 20);
      event({ type: "turn-started", packageId, threadId, turnId });
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      const timer = setTimeout(() => {
        const payload = JSON.stringify({
          packageId,
          status: "completed",
          summary: "Completed " + packageId,
          claims: ["claim-" + packageId],
          evidence: [{ type: "observation", description: "evidence-" + packageId, path: null, lineStart: null, lineEnd: null, command: null, exitCode: null }],
          changedFiles: [],
          verification: { passed: true, commands: [] },
          residualRisks: [],
          confidence: 0.9,
          followUpRequests: []
        });
        send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
        event({ type: "turn-completed", packageId, threadId, turnId });
      }, delayMs);
      timers.set(turnId, { timer, threadId });
      break;
    }
    case "turn/interrupt":
      for (const [turnId, current] of timers) {
        if (current.threadId === message.params.threadId) {
          clearTimeout(current.timer);
          event({ type: "turn-interrupted", turnId, threadId: current.threadId });
          send({ method: "turn/completed", params: { threadId: current.threadId, turn: { id: turnId, status: "interrupted", items: [] } } });
          timers.delete(turnId);
        }
      }
      send({ id: message.id, result: {} });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: "unknown " + message.method } });
  }
});`
  );

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0codex" %*\r\n`,
      "utf8"
    );
  }
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env,
    cwd: env.WORKSPACE
  });
}

function buildPlan(packages) {
  return {
    version: 1,
    objective: "runtime",
    complexityScore: 5,
    requestedBy: { explicit: true, sessionId: null },
    packages
  };
}

function buildPackage(id, dependencies = [], objective = `delay-250 ${id}`) {
  return {
    id,
    title: id,
    role: { class: "explorer", label: id },
    objective,
    dependencies,
    optional: false,
    access: "read-only",
    workspace: { mode: "shared" },
    model: { name: "gpt-5.6-luna", effort: "high" },
    nativeSubagents: { policy: "forbidden", maxChildren: 0 },
    acceptanceCriteria: ["evidence"],
    expectedOutputs: ["claims"]
  };
}

async function waitFor(orchestrationId, env, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = run(["status", orchestrationId, "--cwd", env.WORKSPACE, "--json"], env);
    if (response.status === 0) {
      const value = JSON.parse(response.stdout);
      if (predicate(value)) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${orchestrationId}.`);
}

async function shutdown(workspace, env) {
  const session = await ensureControllerServer(workspace, { env });
  await new OrchestrationControllerClient(session.endpoint).shutdown(true).catch(() => {});
}

test("runs independent Codex Roots concurrently and isolates results", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const eventFile = path.join(pluginDataDir, "events.jsonl");
  installFake(binDir, eventFile);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    WORKSPACE: workspace
  };
  const planFile = path.join(workspace, "plan.json");
  fs.writeFileSync(
    planFile,
    JSON.stringify(
      buildPlan([
        buildPackage("pkg-a", [], "delay-3000 pkg-a"),
        buildPackage("pkg-b", [], "delay-3000 pkg-b"),
        buildPackage("pkg-c", ["pkg-a", "pkg-b"], "delay-20 pkg-c")
      ])
    )
  );

  const launch = run(["start", "--cwd", workspace, "--plan-file", planFile, "--json"], env);
  assert.equal(launch.status, 0, launch.stderr);
  const orchestrationId = JSON.parse(launch.stdout).orchestrationId;
  const state = await waitFor(
    orchestrationId,
    env,
    (value) => ["completed", "degraded", "failed"].includes(value.status)
  );
  assert.equal(state.status, "completed", JSON.stringify(state, null, 2));

  const resultResponse = run(["result", orchestrationId, "--cwd", workspace, "--json"], env);
  assert.equal(resultResponse.status, 0, resultResponse.stderr);
  const result = JSON.parse(resultResponse.stdout);
  assert.equal(result.packages[0].result.claims[0], "claim-pkg-a");
  assert.equal(result.packages[1].result.claims[0], "claim-pkg-b");

  const events = fs.readFileSync(eventFile, "utf8").trim().split(/\n/).map(JSON.parse);
  const starts = events.filter(
    (entry) => entry.type === "turn-started" && ["pkg-a", "pkg-b"].includes(entry.packageId)
  );
  const completions = events.filter(
    (entry) => entry.type === "turn-completed" && ["pkg-a", "pkg-b"].includes(entry.packageId)
  );
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map((entry) => entry.pid)).size, 2);
  assert.equal(
    Math.max(...starts.map((entry) => entry.time))
      < Math.min(...completions.map((entry) => entry.time)),
    true,
    JSON.stringify({ starts, completions }, null, 2)
  );
  await shutdown(workspace, env);
});

test("cancels an active orchestration with a soft turn interrupt", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const eventFile = path.join(pluginDataDir, "events.jsonl");
  installFake(binDir, eventFile);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    WORKSPACE: workspace
  };
  const planFile = path.join(workspace, "plan.json");
  fs.writeFileSync(
    planFile,
    JSON.stringify(buildPlan([buildPackage("pkg-long", [], "delay-5000 pkg-long")]))
  );

  const launch = run(["start", "--cwd", workspace, "--plan-file", planFile, "--json"], env);
  assert.equal(launch.status, 0, launch.stderr);
  const orchestrationId = JSON.parse(launch.stdout).orchestrationId;
  await waitFor(
    orchestrationId,
    env,
    (value) => value.packages?.["pkg-long"]?.status === "running"
  );

  const cancel = run(["cancel", orchestrationId, "--cwd", workspace, "--json"], env);
  assert.equal(cancel.status, 0, cancel.stderr);
  const state = await waitFor(orchestrationId, env, (value) => value.status === "cancelled");
  assert.equal(state.status, "cancelled");
  const events = fs.readFileSync(eventFile, "utf8").trim().split(/\n/).map(JSON.parse);
  assert.equal(events.some((entry) => entry.type === "turn-interrupted"), true);
  await shutdown(workspace, env);
});
