import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { prepareClaudeSessionImport } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("shared staged imports keep the file alive until the final cleanup", () => {
  const home = tempDir("codex-transfer-home-");
  const repo = path.join(home, "repo");
  const claudeConfigDir = path.join(home, ".claude-work");
  const projectDir = path.join(claudeConfigDir, "projects", "-repo");
  const source = path.join(projectDir, "session.jsonl");
  const previousHome = process.env.USERPROFILE;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;

  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(source, '{"type":"user","message":{"content":"hello"}}\n', "utf8");
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  try {
    const first = prepareClaudeSessionImport(repo, source);
    const second = prepareClaudeSessionImport(repo, source);

    assert.equal(path.resolve(first.importPath), path.resolve(second.importPath));
    assert.equal(fs.existsSync(first.importPath), true);

    first.cleanup();
    assert.equal(fs.existsSync(second.importPath), true);

    second.cleanup();
    assert.equal(fs.existsSync(second.importPath), false);
  } finally {
    if (previousHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
