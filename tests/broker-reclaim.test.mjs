import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  spawnBrokerProcess
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

/** A broker session whose files exist on disk, so we can see whether they survive. */
function plantSession(pid) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-cwd-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-session-"));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const socketPath = path.join(sessionDir, "broker.sock");
  fs.writeFileSync(pidFile, `${pid}\n`);
  fs.writeFileSync(logFile, "log\n");
  fs.writeFileSync(socketPath, "");
  const session = { endpoint: `unix:${socketPath}`, pidFile, logFile, sessionDir, pid };
  saveBrokerSession(cwd, session);
  return { cwd, session, socketPath };
}

// The endpoint never answers, so the readiness probe fails either way; what differs is whether the
// process behind the record is still alive.
const nowhere = { scriptPath: path.join(os.tmpdir(), "cxc-does-not-exist.mjs"), timeoutMs: 50 };

test("a broker that is merely unresponsive keeps its files", async () => {
  // process.pid is unmistakably alive. Tearing this one down would delete a running broker's
  // socket without stopping it — it would keep its app-server and every MCP server underneath,
  // now unreachable and untracked.
  const { cwd, session, socketPath } = plantSession(process.pid);

  await ensureBrokerSession(cwd, nowhere).catch(() => {});

  assert.equal(fs.existsSync(session.pidFile), true, "pid file was removed");
  assert.equal(fs.existsSync(session.logFile), true, "log was removed");
  assert.equal(fs.existsSync(socketPath), true, "socket was removed");

  fs.rmSync(session.sessionDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a broker that is gone is reclaimed", async () => {
  // A pid that cannot be running: process 0 is never a live user process, so this stands in for a
  // broker killed outright.
  const { cwd, session, socketPath } = plantSession(0);

  await ensureBrokerSession(cwd, nowhere).catch(() => {});

  assert.equal(fs.existsSync(session.pidFile), false, "pid file survived");
  assert.equal(fs.existsSync(session.logFile), false, "log survived");
  assert.equal(fs.existsSync(socketPath), false, "socket survived");
  assert.equal(loadBrokerSession(cwd), null, "record survived");

  fs.rmSync(session.sessionDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a broker is told its own log path", async () => {
  // Its record may name a successor by the time it shuts down, so it cannot rely on that to find
  // its own artifacts — it has to be given them at startup.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-args-"));
  const argvFile = path.join(dir, "argv.json");
  const scriptPath = path.join(dir, "fake-broker.mjs");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
  );
  const logFile = path.join(dir, "broker.log");

  const child = spawnBrokerProcess({
    scriptPath,
    cwd: dir,
    endpoint: `unix:${path.join(dir, "broker.sock")}`,
    pidFile: path.join(dir, "broker.pid"),
    logFile
  });
  await new Promise((resolve) => child.on("exit", resolve));

  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.equal(argv[argv.indexOf("--log-file") + 1], logFile);
  fs.rmSync(dir, { recursive: true, force: true });
});
