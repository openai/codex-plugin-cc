import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearBrokerSession,
  saveBrokerSession,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-broker-test-"));
}

function epermError() {
  const error = new Error("EPERM: operation not permitted, unlink");
  error.code = "EPERM";
  return error;
}

function throwEpermFor(target, originalUnlinkSync) {
  return (filePath) => {
    if (filePath === target) {
      throw epermError();
    }
    return originalUnlinkSync(filePath);
  };
}

test("teardownBrokerSession removes pid and log files on the happy path", (t) => {
  const sessionDir = makeTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), false);
});

test("teardownBrokerSession tolerates EPERM on the pid file and still removes the log file", (t) => {
  const sessionDir = makeTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(pidFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(logFile), false);
});

test("teardownBrokerSession tolerates EPERM on the log file and completes teardown", (t) => {
  const sessionDir = makeTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(logFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), true);
});

test("teardownBrokerSession is a no-op for missing pid and log files", (t) => {
  const sessionDir = makeTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), false);
});

test("teardownBrokerSession runs remaining cleanup when the pid unlink fails", (t) => {
  const sessionDir = makeTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const endpoint = createBrokerEndpoint(sessionDir, process.platform);
  const endpointTarget = parseBrokerEndpoint(endpoint);
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");
  if (endpointTarget.kind === "unix") {
    fs.writeFileSync(endpointTarget.path, "", "utf8");
  }

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(pidFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  teardownBrokerSession({ endpoint, pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(logFile), false);
  if (endpointTarget.kind === "unix") {
    assert.equal(fs.existsSync(endpointTarget.path), false);
  }
});

test("clearBrokerSession tolerates EPERM on the state file and does not throw", (t) => {
  const dataDir = makeTempDir();
  const cwd = makeTempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  t.after(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  saveBrokerSession(cwd, { endpoint: "pipe://test", pid: 1234 });
  const stateFile = path.join(resolveStateDir(cwd), "broker.json");
  assert.equal(fs.existsSync(stateFile), true);

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(stateFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  clearBrokerSession(cwd);

  assert.equal(fs.existsSync(stateFile), true);

  fs.unlinkSync = originalUnlinkSync;
});
