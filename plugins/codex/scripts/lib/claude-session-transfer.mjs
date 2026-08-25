import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";

function resolveHomeDir(env = process.env) {
  const configured = env.HOME || env.USERPROFILE;
  return configured ? path.resolve(configured) : os.homedir();
}

function resolveUserPath(cwd, value, homeDir) {
  if (value === "~") {
    return homeDir;
  }
  if (/^~[\\/]/.test(String(value))) {
    return path.join(homeDir, String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const env = options.env ?? process.env;
  const requestedPath = options.source || env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error(
      "Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>."
    );
  }

  const homeDir = resolveHomeDir(env);
  const projectsDir = path.join(homeDir, ".claude", "projects");
  const sourcePath = resolveUserPath(cwd, requestedPath, homeDir);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(projectsDir);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }

  const relative = path.relative(projects, source);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Codex can import Claude sessions only from ${projectsDir}: ${source}`);
  }
  return source;
}
