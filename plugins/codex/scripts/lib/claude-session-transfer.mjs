import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const COMPANION_SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

function findSessionTranscripts(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return [];
  }

  const filename = `${sessionId}.jsonl`;
  const matches = [];
  const pending = [CLAUDE_PROJECTS_DIR];

  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === filename) {
        matches.push(entryPath);
      }
    }
  }

  return matches;
}

function resolveSessionIdPath(cwd, sessionId) {
  const matches = findSessionTranscripts(sessionId);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Claude transcripts matched session ${sessionId}. Retry with --source <path-to-claude-jsonl>.`
    );
  }
  return resolveTranscriptPath(cwd, matches[0]);
}

function resolveTranscriptPath(cwd, requestedPath) {
  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Codex can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  if (options.source) {
    return resolveTranscriptPath(cwd, options.source);
  }

  const claudeSessionId = process.env[CLAUDE_SESSION_ID_ENV];
  if (claudeSessionId) {
    const source = resolveSessionIdPath(cwd, claudeSessionId);
    if (source) {
      return source;
    }
  }

  const requestedPath = process.env[TRANSCRIPT_PATH_ENV];
  if (requestedPath) {
    try {
      return resolveTranscriptPath(cwd, requestedPath);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Claude session file not found:")) {
        throw error;
      }
    }
  }

  const companionSessionId = process.env[COMPANION_SESSION_ID_ENV];
  if (companionSessionId && companionSessionId !== claudeSessionId) {
    const source = resolveSessionIdPath(cwd, companionSessionId);
    if (source) {
      return source;
    }
  }

  throw new Error(
    "Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>."
  );
}
