import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { clearBrokerSession, loadBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function installFileChangeFakeCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const readline = require("node:readline");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({
        id: message.id,
        result: {
          thread: {
            id: "thr_1",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "idle" },
            path: null,
            cwd: message.params.cwd,
            cliVersion: "fake-codex",
            source: "appServer",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: []
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: message.params.cwd,
          approvalPolicy: "never",
          sandbox: { type: "workspaceWrite" },
          reasoningEffort: null
        }
      });
      send({ method: "thread/started", params: { thread: { id: "thr_1" } } });
      break;
    case "thread/name/set":
      send({ id: message.id, result: {} });
      break;
    case "turn/start":
      send({ id: message.id, result: { turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
      send({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
      send({
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "fileChange",
            id: "fc_declined",
            status: "declined",
            changes: [{ path: "src/declined.js", kind: { type: "update", move_path: null }, diff: "" }]
          }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "fileChange",
            id: "fc_failed",
            status: "failed",
            changes: [{ path: "src/failed.js", kind: { type: "add" }, diff: "" }]
          }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "fileChange",
            id: "fc_in_progress",
            status: "inProgress",
            changes: [{ path: "src/in-progress.js", kind: { type: "add" }, diff: "" }]
          }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "fileChange",
            id: "fc_completed",
            status: "completed",
            changes: [
              { path: "src/added.js", kind: { type: "add" }, diff: "" },
              { path: "src/old-name.js", kind: { type: "update", move_path: "src/new-name.js" }, diff: "" }
            ]
          }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "agentMessage", id: "msg_1", text: "Applied rename and new file.", phase: "final_answer" }
        }
      });
      send({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [], error: null } } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
      break;
  }
});
`;
  writeExecutable(scriptPath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%~dp0codex" %*\r\n`, "utf8");
  }
}

test("task touchedFiles excludes non-completed fileChange items and includes move_path destinations", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFileChangeFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  t.after(async () => {
    const broker = loadBrokerSession(repo);
    if (broker?.endpoint) {
      await sendBrokerShutdown(broker.endpoint);
      teardownBrokerSession({
        ...broker,
        killProcess: terminateProcessTree
      });
      clearBrokerSession(repo);
    }
  });

  const sep = process.platform === "win32" ? ";" : ":";
  const result = run("node", [SCRIPT, "task", "--write", "--json", "rename module"], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${binDir}${sep}${process.env.PATH}`
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.touchedFiles, ["src/added.js", "src/old-name.js", "src/new-name.js"]);
});
