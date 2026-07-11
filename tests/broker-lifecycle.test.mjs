import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { withBrokerLock } from "../plugins/codex/scripts/lib/broker-lock.mjs";
import {
  loadBrokerSession,
  loadReusableBrokerSession,
  sendBrokerShutdown
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_LIFECYCLE = path.join(ROOT, "plugins", "codex", "scripts", "lib", "broker-lifecycle.mjs");

function startEnsureProcess(cwd, env) {
  const source = [
    `import { ensureBrokerSession } from ${JSON.stringify(BROKER_LIFECYCLE)};`,
    "const session = await ensureBrokerSession(process.cwd());",
    "console.log(JSON.stringify(session));"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function startProbeBroker(socketPath, { busy, shutdownResponseChunks = ['{"id":1,"result":{}}\n'] }) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        requests.push(message.method);
        if (message.method === "initialize") {
          socket.write('{"id":1,"result":{"userAgent":"probe"}}\n');
        } else if (message.method === "thread/list") {
          socket.write(
            busy
              ? '{"id":2,"error":{"code":-32001,"message":"Shared Codex broker is busy."}}\n'
              : '{"id":2,"result":{"data":[],"nextCursor":null}}\n'
          );
        } else if (message.method === "broker/shutdown") {
          for (const chunk of shutdownResponseChunks) {
            socket.write(chunk);
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    requests,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    }
  };
}

test("concurrent startup creates and records only one shared broker", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const [first, second] = await Promise.all([
    startEnsureProcess(repo, env),
    startEnsureProcess(repo, env)
  ]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).endpoint, JSON.parse(second.stdout).endpoint);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).appServerStarts, 1);

  const broker = loadBrokerSession(repo);
  await sendBrokerShutdown(broker.endpoint);
});

test("broker lock recovers immediately when its owner process is gone", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "broker.lock"), "2147483647:0:abandoned", "utf8");

  const result = await withBrokerLock(repo, { lockTimeoutMs: 100 }, async () => "acquired");

  assert.equal(result, "acquired");
  assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
});

test("stale reachable brokers are preserved when the broker reports an active turn", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir();
  const socketPath = path.join(sessionDir, "broker.sock");
  const probeBroker = await startProbeBroker(socketPath, { busy: true });
  installFakeCodex(binDir, "review-ok", "codex-cli 0.144.0");
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "broker.json"),
    `${JSON.stringify(
      {
        endpoint: `unix:${socketPath}`,
        pidFile: path.join(sessionDir, "broker.pid"),
        logFile: path.join(sessionDir, "broker.log"),
        sessionDir,
        pid: 999999,
        runtime: { pluginVersion: "1.0.6", codexVersion: "codex-cli 0.143.0" }
      },
      null,
      2
    )}\n`
  );

  let killed = false;
  const options = {
    env: buildEnv(binDir),
    killProcess: () => {
      killed = true;
    }
  };
  const result = await loadReusableBrokerSession(repo, options);

  assert.equal(result, null);
  assert.equal(killed, false);
  assert.equal(options.deferBrokerReplacement, true);
  assert.equal(probeBroker.requests.includes("broker/shutdown"), false);
  assert.equal(fs.existsSync(path.join(stateDir, "broker.json")), true);
  await probeBroker.close();
});

test("broker shutdown accepts a response split across socket chunks", async () => {
  const sessionDir = makeTempDir();
  const socketPath = path.join(sessionDir, "broker.sock");
  const probeBroker = await startProbeBroker(socketPath, {
    busy: false,
    shutdownResponseChunks: ['{"id":1,"result":', '{}', '}\n']
  });

  assert.equal(await sendBrokerShutdown(`unix:${socketPath}`), true);
  await probeBroker.close();
});
