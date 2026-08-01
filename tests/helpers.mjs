import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { loadBrokerSession, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

// `ensureBrokerSession` keys the app-server broker by cwd and spawns it detached, and
// every test here gets a fresh cwd -- so a suite run strands one broker tree per test
// that reached the app server. A broker exits only on a shutdown RPC or a signal, and
// the SessionEnd hook that would normally reap it never fires under `npm test`, so
// nothing else ever will. Reap them, and the mkdtemp dirs, when the test process exits.
const tempDirs = [];

function reapTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      const session = loadBrokerSession(dir);
      if (session) {
        teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort at exit: a malformed broker session, or a dir Windows still holds a
      // handle on right after the kill, must not fail an otherwise-passing test file.
    }
  }
}

// `exit` only: an interrupted run still leaks, but a signal handler here would also
// have to re-raise, and every normal run goes through `exit`.
process.once("exit", reapTempDirs);

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
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
