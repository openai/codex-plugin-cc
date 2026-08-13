import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

/**
 * Workspaces handed out by makeTempDir, so cleanup can find the brokers that
 * were started for them.
 */
const tempDirs = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/**
 * Stop the broker registered for a workspace, if one is still running.
 *
 * The broker is deliberately long-lived so it can be reused across companion
 * invocations, which means nothing in a test run ever shuts it down. Each test
 * that runs the companion therefore leaves a broker and its app-server child
 * behind for the lifetime of the machine.
 */
export function stopBrokerFor(cwd) {
  let session = null;
  try {
    session = loadBrokerSession(cwd);
  } catch {
    return;
  }

  if (session && Number.isFinite(session.pid)) {
    terminateProcessTree(session.pid);
  }
}

/**
 * Tear down every workspace created by makeTempDir: stop its broker, then
 * remove the directory. Extra workspaces (for example the repository root,
 * which some tests use as the companion cwd) can be passed in.
 */
export function cleanupTempWorkspaces(extraWorkspaces = []) {
  for (const cwd of [...tempDirs, ...extraWorkspaces]) {
    stopBrokerFor(cwd);
  }

  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir is not worth failing the suite over.
    }
  }

  tempDirs.clear();
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
