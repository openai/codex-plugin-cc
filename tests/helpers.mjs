import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const TEST_TEMP_PREFIX = "codex-plugin-test-";
const tempDirs = new Set();

function isTestTempDir(dir) {
  return path.basename(dir).startsWith(TEST_TEMP_PREFIX);
}

async function teardownTempBroker(cwd) {
  const brokerSession = loadBrokerSession(cwd);
  if (!brokerSession) {
    return;
  }

  const endpoint = brokerSession.endpoint ?? null;
  if (endpoint) {
    // A wedged endpoint (accepts, never responds) must not hang the global
    // cleanup hook and strand every later-registered broker.
    await Promise.race([
      sendBrokerShutdown(endpoint).catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref?.();
      })
    ]);
  }

  teardownBrokerSession({
    endpoint,
    pidFile: brokerSession.pidFile ?? null,
    logFile: brokerSession.logFile ?? null,
    sessionDir: brokerSession.sessionDir ?? null,
    pid: brokerSession.pid ?? null,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

export async function cleanupRegisteredTempBrokers() {
  for (const dir of tempDirs) {
    await teardownTempBroker(dir);
  }
}

after(async () => {
  await cleanupRegisteredTempBrokers();
});

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (isTestTempDir(dir)) {
    tempDirs.add(dir);
  }
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
