import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Keep the suite hermetic when it runs from inside a live Claude Code
// session. Two inherited variables otherwise change behavior:
// - CLAUDE_PLUGIN_DATA points at the user's real plugin data directory, so
//   in-process state writes and spawned companions (which inherit it through
//   buildEnv) leak fixture workspaces and job records into that real
//   directory. Pin it to a fresh temp root for the whole test process.
// - CODEX_COMPANION_SESSION_ID makes status/result session-filter jobs that
//   fixtures seed without a sessionId, hiding them. Session-scoped tests set
//   the variable explicitly in the env they compose.
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-cc-tests-"));
delete process.env.CODEX_COMPANION_SESSION_ID;

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
