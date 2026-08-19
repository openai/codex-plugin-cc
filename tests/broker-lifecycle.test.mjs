import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  reapBrokerSessions,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getSessionRuntimeStatus } from "../plugins/codex/scripts/lib/codex.mjs";

function makeSessionDir(tmpDir, name, pidContents, { managed = true } = {}) {
  const sessionDir = path.join(tmpDir, name);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (managed) {
    fs.writeFileSync(path.join(sessionDir, "broker.managed"), "test marker\n", "utf8");
  }
  if (pidContents !== undefined) {
    fs.writeFileSync(path.join(sessionDir, "broker.pid"), pidContents, "utf8");
  }
  return sessionDir;
}

function findDeadPid() {
  // Spawn-free approach: walk down from a high pid until one is not alive.
  for (let pid = 999_999; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("could not find a dead pid to test with");
}

test("reapBrokerSessions removes only dirs whose recorded broker pid is dead", async () => {
  const tmpDir = makeTempDir();
  const deadPid = findDeadPid();

  const deadDir = makeSessionDir(tmpDir, "cxc-dead", `${deadPid}\n`);
  const liveDir = makeSessionDir(tmpDir, "cxc-live", `${process.pid}\n`);
  const pidlessDir = makeSessionDir(tmpDir, "cxc-pidless");
  const tornDir = makeSessionDir(tmpDir, "cxc-torn", "");
  const garbageDir = makeSessionDir(tmpDir, "cxc-garbage", "not-a-pid\n");
  const zeroDir = makeSessionDir(tmpDir, "cxc-zero", "0\n");
  const unrelatedDir = makeSessionDir(tmpDir, "other-prefix", `${deadPid}\n`);
  const unmarkedDir = makeSessionDir(tmpDir, "cxc-user-work", `${deadPid}\n`, { managed: false });
  fs.writeFileSync(path.join(unmarkedDir, "important.txt"), "user file", "utf8");

  await reapBrokerSessions({ tmpDir });

  assert.equal(fs.existsSync(deadDir), false, "dead-pid dir should be removed");
  assert.equal(
    fs.existsSync(path.join(unmarkedDir, "important.txt")),
    true,
    "a dir without the ownership marker is never deleted, dead pid or not"
  );
  assert.equal(fs.existsSync(liveDir), true, "live-pid dir must never be touched");
  assert.equal(fs.existsSync(pidlessDir), true, "dir without broker.pid is not a broker session");
  assert.equal(fs.existsSync(tornDir), true, "empty pid file may be a torn write; leave it");
  assert.equal(fs.existsSync(garbageDir), true, "unparseable pid file is left alone");
  assert.equal(fs.existsSync(zeroDir), true, "pid 0 is never treated as a signalable broker");
  assert.equal(fs.existsSync(unrelatedDir), true, "non cxc- prefixed dirs are ignored");
});

test("getSessionRuntimeStatus reports shared only while the recorded broker pid is alive", () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir();
  const endpoint = `unix:${path.join(sessionDir, "broker.sock")}`;

  saveBrokerSession(workspace, { endpoint, pid: process.pid });
  assert.equal(getSessionRuntimeStatus({}, workspace).mode, "shared");

  saveBrokerSession(workspace, { endpoint, pid: findDeadPid() });
  assert.equal(getSessionRuntimeStatus({}, workspace).mode, "direct");

  clearBrokerSession(workspace);
  assert.equal(getSessionRuntimeStatus({}, workspace).mode, "direct");
});

test("getSessionRuntimeStatus falls back to socket presence for records without a pid", () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir();
  const socketPath = path.join(sessionDir, "broker.sock");

  saveBrokerSession(workspace, { endpoint: `unix:${socketPath}` });
  assert.equal(getSessionRuntimeStatus({}, workspace).mode, "direct", "missing socket file means no runtime");

  fs.writeFileSync(socketPath, "", "utf8");
  assert.equal(getSessionRuntimeStatus({}, workspace).mode, "shared", "present socket is the best available signal");

  clearBrokerSession(workspace);
});

test("getSessionRuntimeStatus env override wins and an empty override masks the record", () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir();
  const socketPath = path.join(sessionDir, "broker.sock");
  fs.writeFileSync(socketPath, "", "utf8");

  saveBrokerSession(workspace, { endpoint: `unix:${socketPath}`, pid: process.pid });

  const env = { CODEX_COMPANION_APP_SERVER_ENDPOINT: "" };
  assert.equal(getSessionRuntimeStatus(env, workspace).mode, "direct", "empty env override masks the record");

  env.CODEX_COMPANION_APP_SERVER_ENDPOINT = `unix:${socketPath}`;
  assert.equal(getSessionRuntimeStatus(env, workspace).mode, "shared");

  const missing = path.join(sessionDir, "gone.sock");
  env.CODEX_COMPANION_APP_SERVER_ENDPOINT = `unix:${missing}`;
  assert.equal(getSessionRuntimeStatus(env, workspace).mode, "direct", "stale env endpoint is not reported as live");

  clearBrokerSession(workspace);
});

test("loadBrokerSession round-trips and clearBrokerSession removes the record", () => {
  const workspace = makeTempDir();
  const session = { endpoint: "unix:/tmp/nowhere.sock", pid: 12345 };
  saveBrokerSession(workspace, session);
  assert.deepEqual(loadBrokerSession(workspace), session);
  clearBrokerSession(workspace);
  assert.equal(loadBrokerSession(workspace), null);
});
