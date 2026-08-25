import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

function ensureWindowsNodeShim(env) {
  if (process.platform !== "win32") return;
  const searchPath = env?.PATH ?? process.env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const extensionlessNode = path.join(directory, "node");
    const nodeExe = path.join(directory, "node.exe");
    const nodeCmd = path.join(directory, "node.cmd");
    if (
      fs.existsSync(extensionlessNode)
      && !fs.existsSync(nodeExe)
      && !fs.existsSync(nodeCmd)
    ) {
      fs.writeFileSync(
        nodeCmd,
        `@echo off\r\n"${process.execPath}" %*\r\n`,
        "utf8"
      );
      return;
    }
  }
}

export function run(command, args, options = {}) {
  ensureWindowsNodeShim(options.env);
  const executable = command === "node" ? process.execPath : command;
  return spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(executable)),
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
