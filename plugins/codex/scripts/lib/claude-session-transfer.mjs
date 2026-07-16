import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
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

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalizeSessionPath(cwd, requestedPath, projectsDir) {
  const sourcePath = resolveUserPath(cwd, requestedPath);
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
  if (!isPathWithin(projects, source)) {
    throw new Error(`Codex can import Claude sessions only from ${projectsDir}: ${source}`);
  }
  return source;
}

function encodeCwdAsClaudeProject(cwd) {
  // Claude Code stores transcripts below a directory derived from the absolute
  // cwd. Replacing path separators and the Windows drive colon preserves dots
  // and underscores while producing the same single directory component.
  return path.resolve(cwd).replace(/[\\/:]/g, "-");
}

function discoverClaudeSessionPath(cwd, projectsDir) {
  if (!cwd) {
    return null;
  }

  let projects;
  try {
    projects = fs.realpathSync(projectsDir);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }

  const projectDir = path.join(projects, encodeCwdAsClaudeProject(cwd));
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }

  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".jsonl") {
      continue;
    }

    const candidatePath = path.join(projectDir, entry.name);
    try {
      const candidate = fs.realpathSync(candidatePath);
      const mtimeMs = fs.statSync(candidate).mtimeMs;
      if (
        !isPathWithin(projects, candidate) ||
        (newest && (mtimeMs < newest.mtimeMs || (mtimeMs === newest.mtimeMs && candidate <= newest.path)))
      ) {
        continue;
      }
      newest = { path: candidate, mtimeMs };
    } catch (error) {
      // A transcript can disappear while Claude rotates session files. Ignore
      // only that race; permission and I/O failures remain visible.
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return newest?.path ?? null;
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const requestedPath = options.source || (options.env ?? process.env)[TRANSCRIPT_PATH_ENV];
  if (requestedPath) {
    return canonicalizeSessionPath(cwd, requestedPath, projectsDir);
  }

  const discoveredPath = discoverClaudeSessionPath(cwd, projectsDir);
  if (discoveredPath) {
    return discoveredPath;
  }
  throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
}
