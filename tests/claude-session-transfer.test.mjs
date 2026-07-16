import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  TRANSCRIPT_PATH_ENV,
  resolveClaudeSessionPath
} from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";

function projectSlug(cwd) {
  return path.resolve(cwd).replace(/[\\/:]/g, "-");
}

function createTranscript(projectsDir, cwd, name, contents = "{}\n") {
  const projectDir = path.join(projectsDir, projectSlug(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, name);
  fs.writeFileSync(transcriptPath, contents, "utf8");
  return transcriptPath;
}

test("transcript discovery maps cwd separators while preserving dots and underscores", () => {
  const root = makeTempDir();
  const projectsDir = path.join(root, "projects");
  const cwd = path.join(root, "work.tree_with_details");
  const transcriptPath = createTranscript(projectsDir, cwd, "session.jsonl");

  assert.match(projectSlug(cwd), /work\.tree_with_details$/);
  assert.equal(
    resolveClaudeSessionPath(cwd, { env: {}, projectsDir }),
    fs.realpathSync(transcriptPath)
  );
});

test("transcript discovery selects the newest JSONL file", () => {
  const root = makeTempDir();
  const projectsDir = path.join(root, "projects");
  const cwd = path.join(root, "repo");
  const olderPath = createTranscript(projectsDir, cwd, "older.jsonl");
  const newerPath = createTranscript(projectsDir, cwd, "newer.jsonl");
  createTranscript(projectsDir, cwd, "ignored.txt");
  fs.utimesSync(olderPath, new Date(1_000), new Date(1_000));
  fs.utimesSync(newerPath, new Date(2_000), new Date(2_000));

  assert.equal(
    resolveClaudeSessionPath(cwd, { env: {}, projectsDir }),
    fs.realpathSync(newerPath)
  );
});

test("transcript resolution prefers source, then environment, then discovery", () => {
  const root = makeTempDir();
  const projectsDir = path.join(root, "projects");
  const cwd = path.join(root, "repo");
  const discoveredPath = createTranscript(projectsDir, cwd, "discovered.jsonl");
  const environmentPath = createTranscript(projectsDir, path.join(root, "other"), "environment.jsonl");
  const sourcePath = createTranscript(projectsDir, path.join(root, "explicit"), "source.jsonl");

  assert.equal(
    resolveClaudeSessionPath(cwd, {
      source: sourcePath,
      env: { [TRANSCRIPT_PATH_ENV]: environmentPath },
      projectsDir
    }),
    fs.realpathSync(sourcePath)
  );
  assert.equal(
    resolveClaudeSessionPath(cwd, {
      env: { [TRANSCRIPT_PATH_ENV]: environmentPath },
      projectsDir
    }),
    fs.realpathSync(environmentPath)
  );
  assert.equal(
    resolveClaudeSessionPath(cwd, { env: {}, projectsDir }),
    fs.realpathSync(discoveredPath)
  );
});

test("transcript discovery keeps the fail-safe error when no JSONL exists", () => {
  const root = makeTempDir();
  const projectsDir = path.join(root, "projects");
  const cwd = path.join(root, "repo");
  fs.mkdirSync(path.join(projectsDir, projectSlug(cwd)), { recursive: true });

  assert.throws(
    () => resolveClaudeSessionPath(cwd, { env: {}, projectsDir }),
    /Could not identify the current Claude transcript/
  );
});
