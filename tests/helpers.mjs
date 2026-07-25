import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

import {
  loadBrokerSession,
  shutdownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const trackedTempDirs = [];

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

// Global teardown: any broker a test started (directly or lazily) and did not
// tear down is shut down here, so the suite never leaves broker/app-server
// processes behind — even when a test fails or returns early.
after(async () => {
  const failures = [];
  for (const dir of trackedTempDirs) {
    const session = loadBrokerSession(dir);
    // A fixture may deliberately persist an arbitrary endpoint. Only sessions
    // with the per-process secret introduced by ensureBrokerSession are ours.
    if (!session?.instanceToken) {
      continue;
    }
    try {
      await shutdownBrokerSession(dir, {
        killProcess: terminateProcessTree,
        timeoutMs: 1000,
        intervalMs: 25
      });
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Owned broker teardown did not finish.");
  }
});

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
