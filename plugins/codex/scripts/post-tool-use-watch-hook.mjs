#!/usr/bin/env node
/**
 * post-tool-use-watch-hook.mjs
 *
 * PostToolUse hook — fires after every Claude tool call.
 * When /codex:watch is enabled, and Claude just wrote a file,
 * this queues a lightweight Codex lint pass on the modified file.
 *
 * The hook must exit quickly. Heavy work is dispatched as a
 * detached background child process (the same pattern as the
 * existing background-task launcher in codex-companion.mjs).
 *
 * Hook input schema (Claude Code PostToolUse):
 * {
 *   hook_event_name: "PostToolUse",
 *   tool_name: string,          // e.g. "Write", "Edit", "MultiEdit"
 *   tool_input: object,         // the arguments Claude passed to the tool
 *   tool_response: object,      // the tool's response
 *   session_id: string,
 *   cwd: string
 * }
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(SCRIPT_DIR, "codex-companion.mjs");

// Tool names that write files — expand if Claude Code adds more
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "str_replace_based_edit_tool"]);

// Extensions worth linting — skip generated/binary files
const LINTABLE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".cpp", ".h", ".cs", ".swift",
  ".sh", ".bash", ".zsh",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".html", ".css", ".scss"
]);

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Extract the affected file path from the tool input.
 * Claude Code uses different field names depending on the tool.
 */
function resolveFilePath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;

  // Write tool: { path: string, content: string }
  if (toolInput.path && typeof toolInput.path === "string") {
    return toolInput.path;
  }
  // Edit / str_replace: { file_path: string, ... }
  if (toolInput.file_path && typeof toolInput.file_path === "string") {
    return toolInput.file_path;
  }
  // MultiEdit: { file_path: string, edits: [...] }
  if (toolInput.file_path && typeof toolInput.file_path === "string") {
    return toolInput.file_path;
  }
  return null;
}

function isLintableFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LINTABLE_EXTENSIONS.has(ext);
}

function buildLintPrompt(filePath, relativePath) {
  return [
    `Run a quick lint pass on the file that was just modified: \`${relativePath}\`.`,
    "",
    "Focus only on:",
    "- Syntax errors or obvious bugs introduced by the last edit",
    "- Type errors or undefined references in the edited region",
    "- Security issues in the changed lines only (e.g. injection, secrets, unsafe eval)",
    "",
    "Do NOT report:",
    "- Style, naming, or formatting issues",
    "- Pre-existing issues outside the changed lines",
    "- Refactoring suggestions",
    "",
    "If you find no issues, respond with a single line: `LINT OK: no issues found`.",
    "If you find issues, list each one with file:line and a one-sentence description.",
    "Keep the total response under 20 lines."
  ].join("\n");
}

function launchLintJob(cwd, filePath, sessionId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const relativePath = path.relative(workspaceRoot, path.resolve(cwd, filePath));
  const prompt = buildLintPrompt(filePath, relativePath);

  const childEnv = {
    ...process.env,
    ...(sessionId ? { [SESSION_ID_ENV]: sessionId } : {})
  };

  // Fire-and-forget: detach so the hook exits immediately
  const child = spawn(
    process.execPath,
    [
      COMPANION,
      "task",
      "--background",
      "--effort", "low",
      prompt
    ],
    {
      cwd,
      env: childEnv,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
}

function main() {
  const input = readHookInput();

  const toolName = input.tool_name ?? "";
  if (!FILE_WRITE_TOOLS.has(toolName)) {
    // Not a file-write tool — nothing to do
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // Only run when the user has explicitly enabled watch mode
  if (!config.watchEnabled) {
    return;
  }

  const filePath = resolveFilePath(toolName, input.tool_input ?? {});
  if (!filePath) {
    return;
  }

  if (!isLintableFile(filePath)) {
    return;
  }

  // Check the file actually exists (tool may have deleted it)
  const absolutePath = path.resolve(cwd, filePath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  launchLintJob(cwd, filePath, input.session_id ?? null);
}

main();
