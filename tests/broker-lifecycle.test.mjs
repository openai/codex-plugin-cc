import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  resolveStateRoot,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  BROKER_CLEANUP_INCOMPLETE_CODE,
  BROKER_OWNER_ENDED_CODE,
  ensureBrokerSession,
  isBrokerSessionEnded,
  loadBrokerSession,
  resolveSessionId,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerForCwd,
  teardownBrokersForSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { handleSessionEnd } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observeLockAttempt(lockDir) {
  const originalMkdirSync = fs.mkdirSync;
  const originalExistsSync = fs.existsSync;
  let notify;
  const attempted = new Promise((resolve) => {
    notify = resolve;
  });
  fs.mkdirSync = (dir, ...args) => {
    if (dir === lockDir) {
      notify();
    }
    return originalMkdirSync.call(fs, dir, ...args);
  };
  fs.existsSync = (target) => {
    if (target === lockDir) {
      notify();
    }
    return originalExistsSync.call(fs, target);
  };
  return {
    attempted,
    restore() {
      fs.mkdirSync = originalMkdirSync;
      fs.existsSync = originalExistsSync;
    }
  };
}

// Minimal stand-in for app-server-broker.mjs: honors the spawn contract
// (serve --endpoint --cwd --pid-file) enough for waitForBrokerEndpoint.
const FAKE_BROKER_SCRIPT = `import fs from "node:fs";
import net from "node:net";

if (process.env.TEST_BROKER_SPAWN_MARKER) {
  fs.writeFileSync(process.env.TEST_BROKER_SPAWN_MARKER, "spawned", "utf8");
}

const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const sockPath = get("--endpoint").replace(/^(?:unix|pipe):/, "");
const server = net.createServer((socket) => socket.end());
setTimeout(() => {
  server.listen(sockPath, () => {
    fs.writeFileSync(get("--pid-file"), String(process.pid), "utf8");
  });
}, Number(process.env.TEST_BROKER_LISTEN_DELAY_MS || 0));
`;

function writeFakeBrokerScript() {
  const scriptPath = path.join(makeTempDir(), "fake-broker.mjs");
  fs.writeFileSync(scriptPath, FAKE_BROKER_SCRIPT, "utf8");
  return scriptPath;
}

const stateRootForTest = resolveStateRoot;

test("resolveStateRoot uses CLAUDE_PLUGIN_DATA/state when set", () => {
  const pluginData = makeTempDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    assert.equal(resolveStateRoot(), path.join(pluginData, "state"));
  } finally {
    if (prev == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("resolveStateRoot falls back to a tmp dir when CLAUDE_PLUGIN_DATA is unset", () => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    assert.equal(resolveStateRoot(), path.join(os.tmpdir(), "codex-companion"));
  } finally {
    if (prev != null) process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("resolveSessionId prefers explicit option, then env, then null", () => {
  assert.equal(resolveSessionId({ sessionId: "explicit" }), "explicit");
  assert.equal(resolveSessionId({ env: { CODEX_COMPANION_SESSION_ID: "from-env" } }), "from-env");
});

test("resolveSessionId reads process.env when no option/env given", () => {
  const prev = process.env.CODEX_COMPANION_SESSION_ID;
  process.env.CODEX_COMPANION_SESSION_ID = "proc-env";
  try {
    assert.equal(resolveSessionId({}), "proc-env");
  } finally {
    if (prev == null) delete process.env.CODEX_COMPANION_SESSION_ID;
    else process.env.CODEX_COMPANION_SESSION_ID = prev;
  }
});

test("resolveSessionId returns null when nothing is set", () => {
  const prev = process.env.CODEX_COMPANION_SESSION_ID;
  delete process.env.CODEX_COMPANION_SESSION_ID;
  try {
    assert.equal(resolveSessionId({ env: {} }), null);
  } finally {
    if (prev != null) process.env.CODEX_COMPANION_SESSION_ID = prev;
  }
});

function writeBrokerJson(stateRoot, dirName, session) {
  const dir = path.join(stateRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "broker.json");
  fs.writeFileSync(file, JSON.stringify(session), "utf8");
  return file;
}

function withPluginData(fn) {
  const pluginData = makeTempDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  return Promise.resolve(fn(pluginData)).finally(() => {
    if (prev == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  });
}

async function withReadyBroker(fn) {
  const sessionDir = makeTempDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      requests.push(chunk);
      socket.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      socket.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.path, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    return await fn({ endpoint, requests, sessionDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withHangingBroker(fn) {
  const sessionDir = makeTempDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const requests = [];
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      requests.push(chunk);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.path, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const destroySockets = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };

  try {
    return await fn({ endpoint, requests, sessionDir, destroySockets });
  } finally {
    destroySockets();
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

test("teardownBrokersForSession tears down a broker registered for a different cwd", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const sessionDir = makeTempDir();
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    fs.writeFileSync(pidFile, "12345\n");
    fs.writeFileSync(logFile, "");
    const brokerJson = writeBrokerJson(stateRoot, "worktree-deadbeefdeadbeef", {
      endpoint: "unix:/tmp/codex-test-nonexistent.sock",
      pidFile, logFile, sessionDir, pid: 12345, sessionId: "S"
    });

    const killed = [];
    const count = await teardownBrokersForSession("S", { killProcess: (pid) => killed.push(pid) });

    assert.equal(count, 1);
    assert.deepEqual(killed, [12345]);
    assert.equal(fs.existsSync(brokerJson), false);
  });
});

test("teardownBrokersForSession ignores broker.json without sessionId (legacy)", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const brokerJson = writeBrokerJson(stateRoot, "legacy-2222222222222222", {
      endpoint: "unix:/tmp/codex-test-nonexistent3.sock", pid: null
    });
    const count = await teardownBrokersForSession("S", { killProcess: () => {} });
    assert.equal(count, 0);
    assert.equal(fs.existsSync(brokerJson), true);
  });
});

test("teardownBrokersForSession is a no-op for empty sessionId", async () => {
  await withPluginData(async () => {
    const count = await teardownBrokersForSession("", { killProcess: () => {} });
    assert.equal(count, 0);
  });
});

test("reusing a ready broker transfers cleanup ownership to the later session", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      const pidFile = path.join(sessionDir, "broker.pid");
      const logFile = path.join(sessionDir, "broker.log");
      fs.writeFileSync(pidFile, "12345\n");
      fs.writeFileSync(logFile, "");
      saveBrokerSession(cwd, {
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: 12345,
        sessionId: "A"
      });

      const reused = await ensureBrokerSession(cwd, { env: { CODEX_COMPANION_SESSION_ID: "B" } });
      assert.equal(reused.endpoint, endpoint);
      assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["A", "B"]);

      const killed = [];
      assert.equal(await teardownBrokersForSession("A", { killProcess: (pid) => killed.push(pid) }), 0);
      assert.deepEqual(killed, []);
      assert.equal(loadBrokerSession(cwd).sessionId, "B");
      assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["B"]);
      assert.equal(requests.length, 0);

      assert.equal(await teardownBrokersForSession("B", { killProcess: (pid) => killed.push(pid) }), 1);
      assert.deepEqual(killed, [12345]);
      assert.equal(loadBrokerSession(cwd), null);
      assert.equal(requests.length, 1);
    });
  });
});

test("handleSessionEnd removes only the ending owner from a shared cwd broker", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      const pidFile = path.join(sessionDir, "broker.pid");
      const logFile = path.join(sessionDir, "broker.log");
      fs.writeFileSync(pidFile, "12345\n");
      fs.writeFileSync(logFile, "");
      saveBrokerSession(cwd, {
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: 12345,
        sessionId: "A",
        sessionIds: ["A", "B"]
      });

      await handleSessionEnd({ cwd, session_id: "A" });

      assert.equal(loadBrokerSession(cwd).sessionId, "B");
      assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["B"]);
      assert.equal(requests.length, 0);
    });
  });
});

test("concurrent SessionEnd hooks tear down a shared broker after the last owner exits", async () => {
  await withPluginData(async (pluginData) => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      const markerDir = makeTempDir();
      const pidFile = path.join(sessionDir, "broker.pid");
      const logFile = path.join(sessionDir, "broker.log");
      fs.writeFileSync(pidFile, "12345\n");
      fs.writeFileSync(logFile, "");
      const brokerJson = writeBrokerJson(stateRootForTest(), "worktree-race-deadbeef", {
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: 12345,
        sessionId: "A",
        sessionIds: ["A", "B"]
      });

      const moduleUrl = pathToFileURL(path.resolve("plugins/codex/scripts/lib/broker-lifecycle.mjs")).href;
      const script = `
        import fs from "node:fs";
        import path from "node:path";

        const stateFile = process.env.TEST_BROKER_STATE_FILE;
        const markerDir = process.env.TEST_MARKER_DIR;
        const sessionId = process.env.TEST_SESSION_ID;
        const otherSessionId = sessionId === "A" ? "B" : "A";
        const lockDir = stateFile + ".lock";
        const originalMkdirSync = fs.mkdirSync.bind(fs);
        let reachedBarrier = false;

        fs.mkdirSync = (dir, ...args) => {
          if (dir === lockDir && !reachedBarrier) {
            reachedBarrier = true;
            fs.writeFileSync(path.join(markerDir, sessionId + ".ready"), "", "utf8");
            const otherReady = path.join(markerDir, otherSessionId + ".ready");
            const deadline = Date.now() + 2000;
            while (!fs.existsSync(otherReady) && Date.now() < deadline) {}
            if (!fs.existsSync(otherReady)) {
              throw new Error("other SessionEnd did not reach the lock barrier");
            }
          }
          return originalMkdirSync(dir, ...args);
        };

        const { teardownBrokersForSession } = await import(process.env.TEST_BROKER_MODULE_URL);
        await teardownBrokersForSession(sessionId, { killProcess: () => {} });
      `;

      const makeChild = (sessionId) =>
        spawn(process.execPath, ["--input-type=module", "-e", script], {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: pluginData,
            TEST_BROKER_STATE_FILE: brokerJson,
            TEST_BROKER_MODULE_URL: moduleUrl,
            TEST_MARKER_DIR: markerDir,
            TEST_SESSION_ID: sessionId
          },
          stdio: ["ignore", "pipe", "pipe"]
        });

      const childA = makeChild("A");
      const childB = makeChild("B");
      const [resultA, resultB] = await Promise.all([waitForChild(childA), waitForChild(childB)]);

      assert.deepEqual([resultA.code, resultB.code], [0, 0]);
      assert.equal(fs.existsSync(brokerJson), false);
      assert.equal(requests.length, 1);
    });
  });
});

test("handleSessionEnd still tears down session brokers when job cleanup fails", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const workspaceStateDir = resolveStateDir(cwd);
    saveBrokerSession(cwd, {
      endpoint: "unix:/tmp/codex-test-nonexistent-cleanup.sock",
      pidFile: null,
      logFile: null,
      sessionDir: null,
      pid: null,
      sessionId: "S",
      sessionIds: ["S"]
    });
    const badLogFile = path.join(workspaceStateDir, "bad.log");
    fs.mkdirSync(badLogFile);
    const originalKill = process.kill;
    const killedPids = [];
    process.kill = (pid, signal) => {
      assert.deepEqual(loadState(cwd).jobs.map((job) => job.id), ["running"]);
      assert.equal(fs.existsSync(badLogFile), true);
      killedPids.push({ pid, signal });
      return true;
    };
    const stateFile = path.join(workspaceStateDir, "state.json");
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({
        version: 1,
        config: { stopReviewGate: false },
        jobs: [{ id: "running", status: "running", sessionId: "S", pid: 12345, logFile: badLogFile }]
      }, null, 2)}\n`,
      "utf8"
    );

    try {
      await assert.rejects(() => handleSessionEnd({ cwd, session_id: "S" }), { code: "EISDIR" });
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(killedPids, [{ pid: -12345, signal: "SIGTERM" }]);
    assert.deepEqual(loadState(cwd).jobs.map((job) => job.id), ["running"]);
    assert.equal(fs.existsSync(path.join(workspaceStateDir, "broker.json")), false);
  });
});

test("handleSessionEnd preserves session brokers when job state locking fails", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const otherWorkspace = makeTempDir();
    const stateFile = resolveStateFile(cwd);
    const stateLock = `${stateFile}.lock`;
    saveState(cwd, {
      jobs: [{
        id: "locked-job",
        status: "running",
        sessionId: "S",
        workspaceRoot: cwd,
        pid: 999999999
      }]
    });
    saveBrokerSession(cwd, {
      endpoint: "unix:/tmp/codex-test-locked-job-cwd.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });
    saveBrokerSession(otherWorkspace, {
      endpoint: "unix:/tmp/codex-test-locked-job-other.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === stateLock) {
        throw Object.assign(new Error("state lock denied"), { code: "EACCES" });
      }
      return originalRenameSync.call(fs, source, destination);
    };

    try {
      await assert.rejects(() => handleSessionEnd({ cwd, session_id: "S" }), { code: "EACCES" });
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.deepEqual(loadState(cwd).jobs.map((job) => job.id), ["locked-job"]);
    assert.notEqual(loadBrokerSession(cwd), null);
    assert.notEqual(loadBrokerSession(otherWorkspace), null);
  });
});

test("handleSessionEnd reports incomplete cleanup when cwd job state is unreadable", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const otherWorkspace = makeTempDir();
    const stateFile = resolveStateFile(cwd);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{not-json", "utf8");
    saveBrokerSession(cwd, {
      endpoint: "unix:/tmp/codex-test-unreadable-job-cwd.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });
    saveBrokerSession(otherWorkspace, {
      endpoint: "unix:/tmp/codex-test-unreadable-job-other.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });

    await assert.rejects(
      () => handleSessionEnd({ cwd, session_id: "S" }),
      { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "job-discovery-incomplete" }
    );

    assert.equal(fs.readFileSync(stateFile, "utf8"), "{not-json");
    assert.notEqual(loadBrokerSession(cwd), null);
    assert.notEqual(loadBrokerSession(otherWorkspace), null);
  });
});

test("handleSessionEnd cleans session jobs from a different --cwd workspace before broker teardown", async () => {
  await withPluginData(async () => {
    const hookCwd = makeTempDir();
    const jobWorkspace = makeTempDir();
    const jobId = "cross-cwd-job";
    const jobLog = resolveJobLogFile(jobWorkspace, jobId);
    const job = {
      id: jobId,
      status: "running",
      sessionId: "S",
      workspaceRoot: jobWorkspace,
      pid: 999999999,
      logFile: jobLog
    };
    fs.writeFileSync(jobLog, "running\n", "utf8");
    writeJobFile(jobWorkspace, jobId, job);
    saveState(jobWorkspace, { jobs: [job] });
    saveBrokerSession(jobWorkspace, {
      endpoint: "unix:/tmp/codex-test-cross-cwd.sock",
      pidFile: null,
      logFile: null,
      sessionDir: null,
      pid: null,
      sessionId: "S",
      sessionIds: ["S"]
    });

    await handleSessionEnd({ cwd: hookCwd, session_id: "S" });

    assert.deepEqual(loadState(jobWorkspace).jobs, []);
    assert.equal(fs.existsSync(resolveJobFile(jobWorkspace, jobId)), false);
    assert.equal(fs.existsSync(jobLog), false);
    assert.equal(loadBrokerSession(jobWorkspace), null);
  });
});

test("handleSessionEnd continues cross-cwd cleanup after one workspace cleanup fails", async () => {
  await withPluginData(async () => {
    const hookCwd = makeTempDir();
    const otherWorkspace = makeTempDir();
    const badLog = path.join(resolveStateDir(hookCwd), "bad.log");
    fs.mkdirSync(badLog, { recursive: true });
    saveState(hookCwd, {
      jobs: [{
        id: "bad-job",
        status: "completed",
        sessionId: "S",
        workspaceRoot: hookCwd,
        logFile: badLog
      }]
    });

    const otherJobId = "other-job";
    const otherLog = resolveJobLogFile(otherWorkspace, otherJobId);
    const otherJob = {
      id: otherJobId,
      status: "running",
      sessionId: "S",
      workspaceRoot: otherWorkspace,
      pid: 999999999,
      logFile: otherLog
    };
    fs.writeFileSync(otherLog, "running\n", "utf8");
    writeJobFile(otherWorkspace, otherJobId, otherJob);
    saveState(otherWorkspace, { jobs: [otherJob] });
    saveBrokerSession(otherWorkspace, {
      endpoint: "unix:/tmp/codex-test-other-workspace.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });

    await assert.rejects(() => handleSessionEnd({ cwd: hookCwd, session_id: "S" }), { code: "EISDIR" });

    assert.deepEqual(loadState(otherWorkspace).jobs, []);
    assert.equal(fs.existsSync(resolveJobFile(otherWorkspace, otherJobId)), false);
    assert.equal(fs.existsSync(otherLog), false);
    assert.equal(loadBrokerSession(otherWorkspace), null);
  });
});

test("handleSessionEnd reports incomplete cleanup when the deadline skips a discovered workspace", async () => {
  await withPluginData(async () => {
    const hookCwd = makeTempDir();
    const otherWorkspace = makeTempDir();
    saveState(hookCwd, {
      jobs: [{
        id: "hook-job",
        status: "completed",
        sessionId: "S",
        workspaceRoot: hookCwd
      }]
    });
    saveState(otherWorkspace, {
      jobs: [{
        id: "other-job",
        status: "completed",
        sessionId: "S",
        workspaceRoot: otherWorkspace
      }]
    });
    saveBrokerSession(otherWorkspace, {
      endpoint: "unix:/tmp/codex-test-job-cleanup-deadline.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });

    const hookStateFile = resolveStateFile(hookCwd);
    const originalRenameSync = fs.renameSync;
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    fs.renameSync = (source, destination) => {
      const result = originalRenameSync.call(fs, source, destination);
      if (destination === hookStateFile) {
        now = 3000;
      }
      return result;
    };

    try {
      await assert.rejects(
        () => handleSessionEnd({ cwd: hookCwd, session_id: "S" }),
        { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "job-cleanup-deadline" }
      );
    } finally {
      Date.now = originalNow;
      fs.renameSync = originalRenameSync;
    }

    assert.deepEqual(loadState(otherWorkspace).jobs.map((job) => job.id), ["other-job"]);
    assert.notEqual(loadBrokerSession(otherWorkspace), null);
  });
});

test("handleSessionEnd reports incomplete cleanup when job-state discovery is incomplete", async () => {
  await withPluginData(async () => {
    const hookCwd = makeTempDir();
    const jobWorkspace = makeTempDir();
    const stateDir = resolveStateDir(jobWorkspace);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        jobs: [{
          id: "oversized-job",
          status: "running",
          sessionId: "S",
          workspaceRoot: jobWorkspace,
          padding: "x".repeat(1024 * 1024)
        }]
      }),
      "utf8"
    );
    saveBrokerSession(jobWorkspace, {
      endpoint: "unix:/tmp/codex-test-oversized-state.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });

    await assert.rejects(
      () => handleSessionEnd({ cwd: hookCwd, session_id: "S" }),
      { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "job-discovery-incomplete" }
    );

    assert.equal(loadState(jobWorkspace).jobs.length, 1);
    assert.notEqual(loadBrokerSession(jobWorkspace), null);
    assert.equal(isBrokerSessionEnded("S"), true);
  });
});

test("handleSessionEnd does not cap a complete job-state discovery scan", async () => {
  await withPluginData(async () => {
    const hookCwd = makeTempDir();
    const stateRoot = stateRootForTest();
    for (let index = 0; index < 1001; index += 1) {
      fs.mkdirSync(path.join(stateRoot, `empty-${String(index).padStart(4, "0")}`), { recursive: true });
    }

    await handleSessionEnd({ cwd: hookCwd, session_id: "S" });
  });
});

test("handleSessionEnd gives broker teardown only the remaining shared cleanup budget", async () => {
  await withPluginData(async () => {
    const hookCwd = makeTempDir();
    const brokerWorkspace = makeTempDir();
    saveBrokerSession(brokerWorkspace, {
      endpoint: "unix:/tmp/codex-test-shared-deadline.sock",
      sessionId: "S",
      sessionIds: ["S"]
    });

    const probe = fs.opendirSync(stateRootForTest());
    const dirPrototype = Object.getPrototypeOf(probe);
    probe.closeSync();
    const originalReadSync = dirPrototype.readSync;
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    dirPrototype.readSync = function (...args) {
      const entry = originalReadSync.call(this, ...args);
      if (!entry) {
        now = 3000;
      }
      return entry;
    };

    try {
      await assert.rejects(
        () => handleSessionEnd({ cwd: hookCwd, session_id: "S" }),
        { code: BROKER_CLEANUP_INCOMPLETE_CODE }
      );
    } finally {
      Date.now = originalNow;
      dirPrototype.readSync = originalReadSync;
    }

    assert.notEqual(loadBrokerSession(brokerWorkspace), null);
  });
});

test("teardownBrokersForSession times out unresponsive broker shutdown requests", async () => {
  await withPluginData(async () => {
    await withHangingBroker(async ({ endpoint, requests, sessionDir, destroySockets }) => {
      const stateRoot = stateRootForTest();
      const brokerJson = writeBrokerJson(stateRoot, "hanging-shutdown-deadbeef", {
        endpoint,
        pidFile: null,
        logFile: null,
        sessionDir,
        pid: null,
        sessionId: "S",
        sessionIds: ["S"]
      });

      let completed = false;
      const teardown = teardownBrokersForSession("S", { killProcess: () => {}, shutdownTimeoutMs: 50 })
        .then(() => {
          completed = true;
        });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(completed, true);
      } finally {
        destroySockets();
        await teardown;
      }
      assert.equal(fs.existsSync(brokerJson), false);
      assert.equal(requests.length, 1);
    });
  });
});

test("teardownBrokersForSession reports a same-session locked entry after tearing down the rest", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const stateRoot = stateRootForTest();

      // Entry 1: owned by this session but its lock is held by a concurrent hook
      // that never released it.
      const lockedCwd = makeTempDir();
      saveBrokerSession(lockedCwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "S", sessionIds: ["S"]
      });
      const lockedJson = path.join(resolveStateDir(lockedCwd), "broker.json");
      fs.mkdirSync(`${lockedJson}.lock`);

      // Entry 2: another record owned by the same session, later in the scan.
      const cleanableJson = writeBrokerJson(stateRoot, "worktree-cleanablebbbb", {
        endpoint: "invalid:endpoint", pidFile: null, logFile: null,
        sessionDir: null, pid: null, sessionId: "S"
      });

      try {
        await assert.rejects(
          () => teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 60 }),
          (error) => {
            assert.equal(error.code, BROKER_CLEANUP_INCOMPLETE_CODE);
            assert.equal(error.reason, "lock-timeout");
            assert.equal(error.count, 1);
            return true;
          }
        );
        // The locked entry is skipped, the reachable one is still cleaned.
        assert.equal(fs.existsSync(cleanableJson), false);
        assert.equal(fs.existsSync(lockedJson), true);
        assert.equal(requests.length, 0);
      } finally {
        fs.rmSync(`${lockedJson}.lock`, { recursive: true, force: true });
      }

      // The timed-out entry keeps an end marker. A later reuse applies it under
      // the lock, so B becomes the sole owner and can perform final teardown.
      const reused = await ensureBrokerSession(lockedCwd, {
        env: { CODEX_COMPANION_SESSION_ID: "B" }
      });
      assert.deepEqual(reused.sessionIds, ["B"]);
      assert.equal(await teardownBrokersForSession("B", { killProcess: () => {} }), 1);
      assert.equal(fs.existsSync(lockedJson), false);
      assert.equal(requests.length, 1);
    });
  });
});

test("ensureBrokerSession cannot re-own a broker after its session end marker is recorded", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "S", sessionIds: ["S"]
      });
      const stateFile = path.join(resolveStateDir(cwd), "broker.json");
      const lockDir = `${stateFile}.lock`;
      fs.mkdirSync(lockDir);

      try {
        await assert.rejects(
          () => teardownBrokerForCwd(cwd, "S", { killProcess: () => {}, lockTimeoutMs: 50 }),
          { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
        );
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }

      await assert.rejects(
        () => ensureBrokerSession(cwd, { env: { CODEX_COMPANION_SESSION_ID: "S" } }),
        { code: BROKER_OWNER_ENDED_CODE }
      );
      assert.equal(loadBrokerSession(cwd), null);
      assert.equal(requests.length, 0);
    });
  });
});

test("reuseExistingBroker cannot reconnect after its session end marker is recorded", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "S", sessionIds: ["S"]
      });
      const stateFile = path.join(resolveStateDir(cwd), "broker.json");
      const lockDir = `${stateFile}.lock`;
      fs.mkdirSync(lockDir);

      try {
        await assert.rejects(
          () => teardownBrokerForCwd(cwd, "S", { killProcess: () => {}, lockTimeoutMs: 50 }),
          { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
        );
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }

      await assert.rejects(
        () => CodexAppServerClient.connect(cwd, {
          env: { CODEX_COMPANION_SESSION_ID: "S" },
          reuseExistingBroker: true
        }),
        { code: BROKER_OWNER_ENDED_CODE }
      );
      assert.equal(loadBrokerSession(cwd), null);
      assert.equal(requests.length, 0);
    });
  });
});

test("reuseExistingBroker rejects a marker-only ended session before direct fallback", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();

    assert.equal(
      await teardownBrokerForCwd(cwd, "S", { killProcess: () => {} }),
      false
    );
    assert.equal(loadBrokerSession(cwd), null);

    await assert.rejects(
      () => CodexAppServerClient.connect(cwd, {
        env: { CODEX_COMPANION_SESSION_ID: "S" },
        reuseExistingBroker: true
      }),
      { code: BROKER_OWNER_ENDED_CODE }
    );
    assert.equal(loadBrokerSession(cwd), null);
  });
});

test("teardownBrokersForSession replaces an invalid non-directory lock path", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const brokerJson = writeBrokerJson(stateRoot, "worktree-invalidlockaaa", {
      endpoint: "unix:/tmp/codex-test-invalid-lock.sock",
      sessionId: "S"
    });
    const lockPath = `${brokerJson}.lock`;
    fs.writeFileSync(lockPath, "not a directory", "utf8");

    const count = await teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 60 });

    assert.equal(count, 1);
    assert.equal(fs.existsSync(brokerJson), false);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("teardownBrokersForSession never deletes a valid lock that replaces an invalid path", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const brokerJson = writeBrokerJson(stateRoot, "worktree-lockswapaaaa", {
      endpoint: "unix:/tmp/codex-test-lock-swap.sock",
      sessionId: "S"
    });
    const lockPath = `${brokerJson}.lock`;
    fs.writeFileSync(lockPath, "invalid", "utf8");
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, old, old);
    const originalLstatSync = fs.lstatSync.bind(fs);
    let swapped = false;
    fs.lstatSync = (file, ...args) => {
      const stat = originalLstatSync(file, ...args);
      if (file === lockPath && !swapped) {
        swapped = true;
        fs.unlinkSync(lockPath);
        fs.mkdirSync(lockPath);
      }
      return stat;
    };

    try {
      await assert.rejects(
        () => teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 60 }),
        { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
      );
    } finally {
      fs.lstatSync = originalLstatSync;
      fs.rmSync(lockPath, { recursive: true, force: true });
    }

    assert.equal(fs.existsSync(brokerJson), true);
  });
});

test("teardownBrokersForSession never waits on a lock for another session's workspace", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const stateRoot = stateRootForTest();

      // An unrelated workspace with a held lock, ordered before ours.
      const otherJson = writeBrokerJson(stateRoot, "worktree-0000otheraaaa", {
        endpoint: "unix:/tmp/codex-test-other.sock",
        pidFile: null, logFile: null, sessionDir: null, pid: null, sessionId: "OTHER"
      });
      fs.mkdirSync(`${otherJson}.lock`);

      const ourJson = writeBrokerJson(stateRoot, "worktree-9999oursbbbbb", {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null, sessionId: "S"
      });

      try {
        const startedAt = Date.now();
        // A large per-entry lock timeout would stall for seconds if we waited on
        // the unrelated lock; the ownership pre-check must skip it outright.
        const count = await teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 5000 });
        const elapsed = Date.now() - startedAt;

        assert.equal(count, 1);
        assert.equal(fs.existsSync(ourJson), false);
        assert.equal(fs.existsSync(otherJson), true);
        assert.ok(elapsed < 1000, `expected fast teardown, took ${elapsed}ms`);
        assert.equal(requests.length, 1);
      } finally {
        fs.rmSync(`${otherJson}.lock`, { recursive: true, force: true });
      }
    });
  });
});

test("teardownBrokersForSession reclaims a stale lock and still tears the broker down", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const stateRoot = stateRootForTest();
      const brokerJson = writeBrokerJson(stateRoot, "worktree-stalelock1234", {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null, sessionId: "S"
      });

      // A lock left behind by a crashed holder: present but aged well past the
      // stale threshold, so acquisition must reclaim it instead of timing out.
      const lockDir = `${brokerJson}.lock`;
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), "2147483647-crashed", "utf8");
      const old = new Date(Date.now() - 120000);
      fs.utimesSync(lockDir, old, old);

      const startedAt = Date.now();
      const count = await teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 2000 });
      const elapsed = Date.now() - startedAt;

      assert.equal(count, 1);
      assert.equal(fs.existsSync(brokerJson), false);
      assert.equal(requests.length, 1);
      assert.ok(elapsed < 1000, `stale lock should be reclaimed promptly, took ${elapsed}ms`);
    });
  });
});

test("teardownBrokersForSession immediately reclaims a fresh dead-owner lock", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const brokerJson = writeBrokerJson(stateRoot, "worktree-freshdeadlock", {
      endpoint: "unix:/tmp/codex-test-fresh-dead-lock.sock",
      pidFile: null,
      logFile: null,
      sessionDir: null,
      pid: null,
      sessionId: "S"
    });
    const lockDir = `${brokerJson}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), "2147483647-crashed", "utf8");

    const startedAt = Date.now();
    const count = await teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 200 });

    assert.equal(count, 1);
    assert.equal(fs.existsSync(brokerJson), false);
    assert.equal(fs.existsSync(lockDir), false);
    assert.ok(Date.now() - startedAt < 1000);
  });
});

test("teardownBrokersForSession reports an incomplete scan once its time budget is exhausted", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    // Two same-session entries, both with held locks. With a tiny budget the
    // scan must return promptly rather than spending lockTimeoutMs on each.
    const a = writeBrokerJson(stateRoot, "worktree-budgetaaaaaaaa", {
      endpoint: "unix:/tmp/codex-test-b1.sock",
      pidFile: null, logFile: null, sessionDir: null, pid: null, sessionId: "S"
    });
    const b = writeBrokerJson(stateRoot, "worktree-budgetbbbbbbbb", {
      endpoint: "unix:/tmp/codex-test-b2.sock",
      pidFile: null, logFile: null, sessionDir: null, pid: null, sessionId: "S"
    });
    fs.mkdirSync(`${a}.lock`);
    fs.mkdirSync(`${b}.lock`);

    try {
      const startedAt = Date.now();
      await assert.rejects(
        () => teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 5000, budgetMs: 200 }),
        (error) => {
          assert.equal(error.code, BROKER_CLEANUP_INCOMPLETE_CODE);
          assert.equal(error.reason, "deadline");
          return true;
        }
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 1500, `expected budget-bounded scan, took ${elapsed}ms`);
    } finally {
      fs.rmSync(`${a}.lock`, { recursive: true, force: true });
      fs.rmSync(`${b}.lock`, { recursive: true, force: true });
    }
  });
});

test("teardownBrokersForSession streams the state root instead of reading it all at once", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const brokerJson = writeBrokerJson(stateRoot, "worktree-streamedscan", {
      endpoint: "unix:/tmp/codex-test-streamed-scan.sock",
      pidFile: null,
      logFile: null,
      sessionDir: null,
      pid: null,
      sessionId: "S"
    });
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (target, ...args) => {
      if (target === stateRoot) {
        throw new Error("state root must be streamed");
      }
      return originalReaddirSync.call(fs, target, ...args);
    };

    try {
      assert.equal(await teardownBrokersForSession("S", { killProcess: () => {} }), 1);
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.equal(fs.existsSync(brokerJson), false);
  });
});

test("teardownBrokersForSession does not silently cap a complete state-root scan", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    fs.mkdirSync(stateRoot, { recursive: true });
    for (let index = 0; index < 1001; index += 1) {
      fs.mkdirSync(path.join(stateRoot, `empty-${String(index).padStart(4, "0")}`));
    }

    const probe = fs.opendirSync(stateRoot);
    const dirPrototype = Object.getPrototypeOf(probe);
    probe.closeSync();
    const originalReadSync = dirPrototype.readSync;
    let reads = 0;
    dirPrototype.readSync = function (...args) {
      reads += 1;
      return originalReadSync.call(this, ...args);
    };

    try {
      assert.equal(await teardownBrokersForSession("S", { killProcess: () => {} }), 0);
    } finally {
      dirPrototype.readSync = originalReadSync;
    }
    assert.ok(reads > 1000, `expected an uncapped scan, observed ${reads} reads`);
  });
});

test("ensureBrokerSession spawns and persists a fresh broker when the recorded one is dead", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    saveBrokerSession(cwd, {
      endpoint: "unix:/tmp/codex-test-dead-spawn.sock",
      pidFile: null,
      logFile: null,
      sessionDir: null,
      pid: null,
      sessionId: "A",
      sessionIds: ["A"]
    });

    const session = await ensureBrokerSession(cwd, {
      env: { CODEX_COMPANION_SESSION_ID: "B" },
      scriptPath: writeFakeBrokerScript()
    });
    try {
      assert.ok(session);
      assert.notEqual(session.endpoint, "unix:/tmp/codex-test-dead-spawn.sock");
      assert.deepEqual(session.sessionIds, ["B"]);
      // The freshly spawned broker is the one persisted (no orphan record).
      assert.equal(loadBrokerSession(cwd).endpoint, session.endpoint);
      assert.equal(await new Promise((resolve) => {
        const socket = net.createConnection({ path: parseBrokerEndpoint(session.endpoint).path });
        socket.on("connect", () => { socket.end(); resolve(true); });
        socket.on("error", () => resolve(false));
      }), true);
    } finally {
      if (session?.pid) {
        try {
          process.kill(session.pid);
        } catch {
          // Already gone.
        }
      }
    }
  });
});

test("ensureBrokerSession never spawns without the state lock after acquisition times out", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const spawnMarker = path.join(makeTempDir(), "spawned");
    const stateFile = path.join(resolveStateDir(cwd), "broker.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.mkdirSync(`${stateFile}.lock`);

    try {
      await assert.rejects(
        () => ensureBrokerSession(cwd, {
          scriptPath: writeFakeBrokerScript(),
          lockTimeoutMs: 60,
          env: { ...process.env, TEST_BROKER_SPAWN_MARKER: spawnMarker }
        }),
        { code: "EBROKERSTATELOCKTIMEOUT" }
      );
      assert.equal(loadBrokerSession(cwd), null);
      assert.equal(fs.existsSync(spawnMarker), false);
    } finally {
      fs.rmSync(`${stateFile}.lock`, { recursive: true, force: true });
    }
  });
});

test("ensureBrokerSession does not persist a broker whose owner ended during spawn", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const spawnMarker = path.join(makeTempDir(), "spawned");
    const stateFile = path.join(resolveStateDir(cwd), "broker.json");
    const killed = [];
    const pending = ensureBrokerSession(cwd, {
      scriptPath: writeFakeBrokerScript(),
      env: {
        ...process.env,
        CODEX_COMPANION_SESSION_ID: "S",
        TEST_BROKER_SPAWN_MARKER: spawnMarker,
        TEST_BROKER_LISTEN_DELAY_MS: "200"
      },
      killProcess(pid) {
        killed.push(pid);
        process.kill(pid);
      }
    });

    const deadline = Date.now() + 2000;
    while (!fs.existsSync(spawnMarker) && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(fs.existsSync(spawnMarker), true);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(fs.existsSync(`${stateFile}.lock`), true);

    await assert.rejects(
      () => teardownBrokerForCwd(cwd, "S", { killProcess: () => {}, lockTimeoutMs: 50 }),
      { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
    );
    await assert.rejects(pending, { code: BROKER_OWNER_ENDED_CODE });
    assert.equal(loadBrokerSession(cwd), null);
    assert.equal(fs.existsSync(`${stateFile}.lock`), false);
    assert.equal(killed.length, 1);
  });
});

test("mismatched-cwd SessionEnd marks an in-flight broker spawn before broker.json exists", async () => {
  await withPluginData(async () => {
    const brokerCwd = makeTempDir();
    const hookCwd = makeTempDir();
    const spawnMarker = path.join(makeTempDir(), "spawned");
    const stateFile = path.join(resolveStateDir(brokerCwd), "broker.json");
    const killed = [];
    const pending = ensureBrokerSession(brokerCwd, {
      scriptPath: writeFakeBrokerScript(),
      env: {
        ...process.env,
        CODEX_COMPANION_SESSION_ID: "S",
        TEST_BROKER_SPAWN_MARKER: spawnMarker,
        TEST_BROKER_LISTEN_DELAY_MS: "1000"
      },
      killProcess(pid) {
        killed.push(pid);
        process.kill(pid);
      }
    });

    const deadline = Date.now() + 2000;
    while (!fs.existsSync(spawnMarker) && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(fs.existsSync(spawnMarker), true);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(fs.existsSync(`${stateFile}.lock`), true);

    await assert.rejects(
      () => handleSessionEnd({ cwd: hookCwd, session_id: "S" }),
      { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
    );
    await assert.rejects(pending, { code: BROKER_OWNER_ENDED_CODE });
    assert.equal(loadBrokerSession(brokerCwd), null);
    assert.equal(fs.existsSync(`${stateFile}.lock`), false);
    assert.equal(killed.length, 1);
  });
});

test("session-wide teardown marks a session joining a ready broker under its lock", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint,
        pidFile: null,
        logFile: null,
        sessionDir,
        pid: null,
        sessionId: "A",
        sessionIds: ["A"]
      });
      const stateFile = path.join(resolveStateDir(cwd), "broker.json");
      const lockDir = `${stateFile}.lock`;
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}-ready-reuse`, "utf8");
      fs.writeFileSync(path.join(lockDir, "session"), "S", "utf8");

      try {
        await assert.rejects(
          () => teardownBrokersForSession("S", {
            killProcess: () => {},
            lockTimeoutMs: 50
          }),
          { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
        );
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }

      await assert.rejects(
        () => ensureBrokerSession(cwd, {
          env: { CODEX_COMPANION_SESSION_ID: "S" }
        }),
        { code: BROKER_OWNER_ENDED_CODE }
      );
      assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["A"]);
      assert.equal(requests.length, 0);
    });
  });
});

test("CodexAppServerClient does not fall back to a direct app-server after its broker owner ends", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const spawnMarker = path.join(makeTempDir(), "broker-spawned");
    const directMarker = path.join(makeTempDir(), "direct-spawned");
    const fakeBin = makeTempDir();
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      `#!/bin/sh\nprintf spawned > "${directMarker}"\nexit 1\n`,
      { encoding: "utf8", mode: 0o755 }
    );

    const env = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_COMPANION_SESSION_ID: "S",
      TEST_BROKER_SPAWN_MARKER: spawnMarker,
      TEST_BROKER_LISTEN_DELAY_MS: "200"
    };
    const pending = CodexAppServerClient.connect(cwd, {
      env,
      brokerOptions: { scriptPath: writeFakeBrokerScript() }
    });

    const deadline = Date.now() + 2000;
    while (!fs.existsSync(spawnMarker) && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(fs.existsSync(spawnMarker), true);
    await assert.rejects(
      () => teardownBrokerForCwd(cwd, "S", { killProcess: () => {}, lockTimeoutMs: 50 }),
      { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
    );

    await assert.rejects(pending, { code: BROKER_OWNER_ENDED_CODE });
    assert.equal(fs.existsSync(directMarker), false);
    assert.equal(loadBrokerSession(cwd), null);
  });
});

test("CodexAppServerClient rejects an ended session before using a supplied broker endpoint", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    await teardownBrokerForCwd(cwd, "S", { killProcess: () => {} });

    await assert.rejects(
      () => CodexAppServerClient.connect(cwd, {
        brokerEndpoint: createBrokerEndpoint(path.join(makeTempDir(), "broker.sock")),
        env: { CODEX_COMPANION_SESSION_ID: "S" }
      }),
      { code: BROKER_OWNER_ENDED_CODE }
    );
  });
});

test("CodexAppServerClient rejects a supplied endpoint when its session ends during initialize", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const sessionDir = makeTempDir();
    const endpoint = createBrokerEndpoint(sessionDir);
    const target = parseBrokerEndpoint(endpoint);
    let releaseInitialize;
    const initializeReceived = new Promise((resolve) => {
      releaseInitialize = resolve;
    });
    let socket = null;
    const server = net.createServer((connected) => {
      socket = connected;
      connected.once("data", () => releaseInitialize());
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(target.path, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const pending = CodexAppServerClient.connect(cwd, {
        brokerEndpoint: endpoint,
        env: { CODEX_COMPANION_SESSION_ID: "S" }
      });
      await initializeReceived;
      await teardownBrokerForCwd(cwd, "S", { killProcess: () => {} });
      socket.write(`${JSON.stringify({ id: 1, result: {} })}\n`);

      await assert.rejects(pending, { code: BROKER_OWNER_ENDED_CODE });
    } finally {
      socket?.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("CodexAppServerClient rejects an ended session before direct fallback", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const directMarker = path.join(makeTempDir(), "direct-spawned");
    const fakeBin = makeTempDir();
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      `#!/bin/sh\nprintf spawned > "${directMarker}"\nexit 1\n`,
      { encoding: "utf8", mode: 0o755 }
    );
    await teardownBrokerForCwd(cwd, "S", { killProcess: () => {} });

    await assert.rejects(
      () => CodexAppServerClient.connect(cwd, {
        disableBroker: true,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          CODEX_COMPANION_SESSION_ID: "S"
        }
      }),
      { code: BROKER_OWNER_ENDED_CODE }
    );
    assert.equal(fs.existsSync(directMarker), false);
  });
});

test("CodexAppServerClient does not fall back after an ended owner's broker spawn times out", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const stateFile = path.join(resolveStateDir(cwd), "broker.json");
    const spawnMarker = path.join(makeTempDir(), "broker-spawned");
    const directMarker = path.join(makeTempDir(), "direct-spawned");
    const fakeBin = makeTempDir();
    const fakeCodex = path.join(fakeBin, "codex");
    fs.writeFileSync(
      fakeCodex,
      `#!/bin/sh\nprintf spawned > "${directMarker}"\nexit 1\n`,
      { encoding: "utf8", mode: 0o755 }
    );

    const pending = CodexAppServerClient.connect(cwd, {
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_COMPANION_SESSION_ID: "S",
        TEST_BROKER_SPAWN_MARKER: spawnMarker,
        TEST_BROKER_LISTEN_DELAY_MS: "1000"
      },
      brokerOptions: { scriptPath: writeFakeBrokerScript(), timeoutMs: 2000 }
    });
    const rejected = assert.rejects(pending, { code: BROKER_OWNER_ENDED_CODE });

    const deadline = Date.now() + 2000;
    while ((!fs.existsSync(spawnMarker) || !fs.existsSync(`${stateFile}.lock`)) && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(fs.existsSync(spawnMarker), true);
    assert.equal(fs.existsSync(`${stateFile}.lock`), true);
    await assert.rejects(
      () => teardownBrokerForCwd(cwd, "S", { killProcess: () => {}, lockTimeoutMs: 50 }),
      { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
    );

    await rejected;
    assert.equal(fs.existsSync(directMarker), false);
    assert.equal(loadBrokerSession(cwd), null);
  });
});

test("ensureBrokerSession does not resurrect a broker torn down while waiting for the state lock", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint,
        pidFile: null,
        logFile: null,
        sessionDir,
        pid: null,
        sessionId: "A",
        sessionIds: ["A"]
      });
      const stateFile = path.join(resolveStateDir(cwd), "broker.json");
      const lockDir = `${stateFile}.lock`;
      fs.mkdirSync(lockDir);
      const observer = observeLockAttempt(lockDir);

      const pending = ensureBrokerSession(cwd, {
        env: { CODEX_COMPANION_SESSION_ID: "B" },
        scriptPath: writeFakeBrokerScript()
      });

      // While B is parked on the lock (readiness probe already passed), A's
      // SessionEnd shuts the broker down and removes broker.json.
      await observer.attempted;
      observer.restore();
      fs.unlinkSync(stateFile);
      fs.rmSync(parseBrokerEndpoint(endpoint).path, { force: true });
      fs.rmdirSync(lockDir);

      const session = await pending;
      try {
        assert.ok(session);
        assert.notEqual(session.endpoint, endpoint);
        assert.deepEqual(session.sessionIds, ["B"]);
        assert.equal(loadBrokerSession(cwd).endpoint, session.endpoint);
      } finally {
        if (session?.pid) {
          try {
            process.kill(session.pid);
          } catch {
            // Already gone.
          }
        }
      }
    });
  });
});

test("ensureBrokerSession reuses a live replacement broker after losing the lock race", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint: staleEndpoint, sessionDir: staleDir }) => {
      await withReadyBroker(async ({ endpoint: freshEndpoint, sessionDir: freshDir }) => {
        const cwd = makeTempDir();
        saveBrokerSession(cwd, {
          endpoint: staleEndpoint,
          pidFile: null,
          logFile: null,
          sessionDir: staleDir,
          pid: null,
          sessionId: "A",
          sessionIds: ["A"]
        });
        const stateFile = path.join(resolveStateDir(cwd), "broker.json");
        const lockDir = `${stateFile}.lock`;
        fs.mkdirSync(lockDir);
        const observer = observeLockAttempt(lockDir);

        const pending = ensureBrokerSession(cwd, { env: { CODEX_COMPANION_SESSION_ID: "B" } });

        // While B waits, the stale broker is replaced by a different live one.
        await observer.attempted;
        observer.restore();
        saveBrokerSession(cwd, {
          endpoint: freshEndpoint,
          pidFile: null,
          logFile: null,
          sessionDir: freshDir,
          pid: null,
          sessionId: "C",
          sessionIds: ["C"]
        });
        fs.rmdirSync(lockDir);

        const session = await pending;
        assert.equal(session.endpoint, freshEndpoint);
        assert.deepEqual(session.sessionIds, ["C", "B"]);
        assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["C", "B"]);
      });
    });
  });
});

test("teardownBrokersForSession tolerates an unparseable broker.json and keeps cleaning later brokers", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const stateRoot = stateRootForTest();

      // A corrupt/half-written broker.json: the unlocked ownership pre-check
      // must not treat a parse failure as "not ours" and abort or skip the
      // rest of the scan.
      const corruptDir = path.join(stateRoot, "worktree-badjson00000");
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDir, "broker.json"), "{ not valid json", "utf8");

      const goodJson = writeBrokerJson(stateRoot, "worktree-goodjson11111", {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null, sessionId: "S"
      });

      const count = await teardownBrokersForSession("S", { killProcess: () => {}, lockTimeoutMs: 200 });

      assert.equal(count, 1);
      assert.equal(fs.existsSync(goodJson), false);
      assert.equal(requests.length, 1);
    });
  });
});

test("teardownBrokersForSession skips symlinked and oversized broker state", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    fs.mkdirSync(stateRoot, { recursive: true });
    const outside = makeTempDir();
    fs.writeFileSync(path.join(outside, "broker.json"), JSON.stringify({ sessionId: "S", pid: 12345 }));
    fs.symlinkSync(outside, path.join(stateRoot, "symlinked-workspace"));

    const linkedFileDir = path.join(stateRoot, "linked-file-workspace");
    fs.mkdirSync(linkedFileDir);
    fs.symlinkSync(path.join(outside, "broker.json"), path.join(linkedFileDir, "broker.json"));

    const oversizedDir = path.join(stateRoot, "oversized-workspace");
    fs.mkdirSync(oversizedDir);
    fs.writeFileSync(path.join(oversizedDir, "broker.json"), "x".repeat(64 * 1024 + 1));

    const killed = [];
    const count = await teardownBrokersForSession("S", { killProcess: (pid) => killed.push(pid) });

    assert.equal(count, 0);
    assert.deepEqual(killed, []);
    assert.equal(fs.existsSync(path.join(outside, "broker.json")), true);
  });
});

test("sendBrokerShutdown returns immediately for a non-positive timeout", async () => {
  await withHangingBroker(async ({ endpoint, requests }) => {
    await sendBrokerShutdown(endpoint, { timeoutMs: 0 });
    assert.equal(requests.length, 0);
  });
});

test("teardownBrokerForCwd records a global ended session before the first broker lock exists", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const tornDown = await teardownBrokerForCwd(cwd, "S");

    assert.equal(tornDown, false);
    assert.equal(isBrokerSessionEnded("S"), true);
    assert.equal(fs.existsSync(resolveStateDir(cwd)), false);
    await assert.rejects(
      () => ensureBrokerSession(cwd, { env: { CODEX_COMPANION_SESSION_ID: "S" } }),
      { code: BROKER_OWNER_ENDED_CODE }
    );
    assert.equal(loadBrokerSession(cwd), null);
  });
});

test("saveBrokerSession writes broker.json atomically", async () => {
  await withPluginData(async () => {
    const cwd = makeTempDir();
    const dir = resolveStateDir(cwd);
    const stateFile = path.join(dir, "broker.json");
    const operations = [];
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalRenameSync = fs.renameSync.bind(fs);
    fs.writeFileSync = (file, data, ...args) => {
      if (String(file).startsWith(`${stateFile}.tmp-`) || file === stateFile) {
        operations.push(["write", String(file)]);
      }
      return originalWriteFileSync(file, data, ...args);
    };
    fs.renameSync = (from, to) => {
      if (to === stateFile) {
        operations.push(["rename", String(from), String(to)]);
      }
      return originalRenameSync(from, to);
    };
    try {
      saveBrokerSession(cwd, { endpoint: "unix:/tmp/x.sock", sessionId: "S", sessionIds: ["S"] });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
    }

    assert.equal(operations[0][0], "write");
    assert.match(operations[0][1], /broker\.json\.tmp-/);
    assert.deepEqual(operations[1], ["rename", operations[0][1], stateFile]);
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes("broker.json.tmp"));
    assert.deepEqual(leftovers, []);
    assert.equal(loadBrokerSession(cwd).sessionId, "S");
  });
});

test("teardownBrokersForSession tolerates a corrupt endpoint and keeps cleaning later brokers", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const stateRoot = stateRootForTest();

      // A stale record with an unsupported endpoint: sendBrokerShutdown would
      // throw synchronously on it. It must be torn down best-effort, not abort
      // the scan.
      const corruptPid = 999999999; // non-existent; killProcess is mocked below
      const corruptJson = writeBrokerJson(stateRoot, "worktree-corrupt00000", {
        endpoint: "garbage-endpoint", pidFile: null, logFile: null,
        sessionDir: null, pid: corruptPid, sessionId: "S"
      });

      // A healthy broker owned by the same session, later in the scan.
      const goodJson = writeBrokerJson(stateRoot, "worktree-goodendpoint1", {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null, sessionId: "S"
      });

      const killed = [];
      const count = await teardownBrokersForSession("S", { killProcess: (pid) => killed.push(pid) });

      assert.equal(count, 2);
      assert.equal(fs.existsSync(corruptJson), false);
      assert.equal(fs.existsSync(goodJson), false);
      assert.ok(killed.includes(corruptPid));
      assert.equal(requests.length, 1);
    });
  });
});

test("teardownBrokersForSession continues after one broker cleanup fails", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const firstJson = writeBrokerJson(stateRoot, "worktree-0000failureaaa", {
      endpoint: "unix:/tmp/codex-test-cleanup-failure.sock",
      sessionId: "S"
    });
    const secondJson = writeBrokerJson(stateRoot, "worktree-9999successbbb", {
      endpoint: "unix:/tmp/codex-test-cleanup-success.sock",
      sessionId: "S"
    });
    const originalUnlinkSync = fs.unlinkSync.bind(fs);
    fs.unlinkSync = (file) => {
      if (file === firstJson) {
        throw Object.assign(new Error("simulated unlink failure"), { code: "EACCES" });
      }
      return originalUnlinkSync(file);
    };

    try {
      await assert.rejects(
        () => teardownBrokersForSession("S", { killProcess: () => {} }),
        { code: "EACCES" }
      );
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }

    assert.equal(fs.existsSync(firstJson), true);
    assert.equal(fs.existsSync(secondJson), false);
  });
});

test("teardownBrokersForSession does not mutate brokers when the global end marker cannot be published", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const firstJson = writeBrokerJson(stateRoot, "worktree-0000first", {
      endpoint: "unix:/tmp/codex-test-marker-failure.sock",
      sessionId: "S"
    });
    const secondJson = writeBrokerJson(stateRoot, "worktree-9999second", {
      endpoint: "unix:/tmp/codex-test-marker-success.sock",
      sessionId: "S"
    });
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (file, ...args) => {
      if (path.dirname(String(file)) === path.join(stateRoot, ".ended-sessions")) {
        throw Object.assign(new Error("simulated marker write failure"), { code: "EACCES" });
      }
      return originalWriteFileSync(file, ...args);
    };

    try {
      await assert.rejects(
        () => teardownBrokersForSession("S", { killProcess: () => {} }),
        { code: "EACCES" }
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(fs.existsSync(firstJson), true);
    assert.equal(fs.existsSync(secondJson), true);
  });
});

test("an unrelated broker reuse cannot consume another session's ended status", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "A", sessionIds: ["A"]
      });

      assert.equal(await teardownBrokerForCwd(makeTempDir(), "S"), false);
      assert.equal(isBrokerSessionEnded("S"), true);

      const reused = await ensureBrokerSession(cwd, {
        env: { CODEX_COMPANION_SESSION_ID: "C" }
      });
      assert.deepEqual(reused.sessionIds, ["A", "C"]);
      assert.equal(isBrokerSessionEnded("S"), true);

      await assert.rejects(
        () => ensureBrokerSession(cwd, { env: { CODEX_COMPANION_SESSION_ID: "S" } }),
        { code: BROKER_OWNER_ENDED_CODE }
      );
      assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["A", "C"]);
    });
  });
});

test("handleSessionEnd skips the cwd fallback while broker state remains locked", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "S", sessionIds: ["S"]
      });
      // Hold the broker's lock through both teardown attempts. The cwd fallback
      // must not use its stale unlocked snapshot to tear the broker down.
      const lockDir = `${path.join(resolveStateDir(cwd), "broker.json")}.lock`;
      fs.mkdirSync(lockDir);

      try {
        await assert.rejects(
          () => handleSessionEnd({ cwd, session_id: "S" }),
          { code: BROKER_CLEANUP_INCOMPLETE_CODE, reason: "lock-timeout" }
        );
        assert.notEqual(loadBrokerSession(cwd), null);
        assert.equal(requests.length, 0);
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }

      const reused = await ensureBrokerSession(cwd, {
        env: { CODEX_COMPANION_SESSION_ID: "B" }
      });
      assert.deepEqual(reused.sessionIds, ["B"]);
      await handleSessionEnd({ cwd, session_id: "B" });
      assert.equal(loadBrokerSession(cwd), null);
      assert.equal(requests.length, 1);
    });
  });
});

test("teardownBrokerForCwd rechecks owners under the lock before fallback teardown", async () => {
  await withPluginData(async () => {
    await withReadyBroker(async ({ endpoint, requests, sessionDir }) => {
      const cwd = makeTempDir();
      saveBrokerSession(cwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "A", sessionIds: ["A"]
      });
      const stateFile = path.join(resolveStateDir(cwd), "broker.json");
      const lockDir = `${stateFile}.lock`;
      fs.mkdirSync(lockDir);
      const observer = observeLockAttempt(lockDir);

      const pending = teardownBrokerForCwd(cwd, "A", {
        killProcess: () => {},
        lockTimeoutMs: 500
      });
      await observer.attempted;
      observer.restore();
      saveBrokerSession(cwd, {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "A", sessionIds: ["A", "B"]
      });
      fs.rmdirSync(lockDir);

      const tornDown = await pending;

      assert.equal(tornDown, false);
      assert.deepEqual(loadBrokerSession(cwd).sessionIds, ["B"]);
      assert.equal(requests.length, 0);
    });
  });
});

test("teardownBrokersForSession caps shutdown waits to the remaining budget", async () => {
  await withPluginData(async () => {
    await withHangingBroker(async ({ endpoint, requests, sessionDir, destroySockets }) => {
      const stateRoot = stateRootForTest();
      const first = writeBrokerJson(stateRoot, "worktree-hang1aaaaaaaaa", {
        endpoint, pidFile: null, logFile: null, sessionDir, pid: null,
        sessionId: "S", sessionIds: ["S"]
      });
      const second = writeBrokerJson(stateRoot, "worktree-hang2bbbbbbbbb", {
        endpoint, pidFile: null, logFile: null, sessionDir: null, pid: null,
        sessionId: "S", sessionIds: ["S"]
      });

      try {
        const startedAt = Date.now();
        // Endpoints accept but never reply; a per-RPC 1s wait on each would blow
        // the budget. The scan must honor budgetMs across shutdown waits.
        await assert.rejects(
          () => teardownBrokersForSession("S", {
            killProcess: () => {},
            shutdownTimeoutMs: 1000,
            budgetMs: 300
          }),
          { code: BROKER_CLEANUP_INCOMPLETE_CODE }
        );
        const elapsed = Date.now() - startedAt;
        assert.ok(elapsed < 900, `expected budget-capped shutdown, took ${elapsed}ms`);
        assert.equal(Number(fs.existsSync(first)) + Number(fs.existsSync(second)), 1);
        assert.equal(requests.length, 1);
      } finally {
        destroySockets();
      }
    });
  });
});

test("handleSessionEnd tears down broker even when cwd mismatches (regression #380)", async () => {
  await withPluginData(async () => {
    const stateRoot = stateRootForTest();
    const sessionDir = makeTempDir();
    const pidFile = path.join(sessionDir, "broker.pid");
    fs.writeFileSync(pidFile, "999999999\n"); // non-existent pid, harmless to signal
    const brokerJson = writeBrokerJson(stateRoot, "worktree-33333333deadbeef", {
      endpoint: "unix:/tmp/codex-test-nonexistent4.sock",
      pidFile, logFile: null, sessionDir, pid: 999999999, sessionId: "S"
    });

    // cwd is a DIFFERENT path than the broker's workspace — the cwd-based path
    // would miss; the session-based path must still tear it down.
    await handleSessionEnd({ cwd: makeTempDir(), session_id: "S" });

    assert.equal(fs.existsSync(brokerJson), false);
  });
});
