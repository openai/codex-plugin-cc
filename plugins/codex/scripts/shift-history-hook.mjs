#!/usr/bin/env node

/**
 * Stop hook — fires after each Claude turn.
 * Appends a compact entry (assistant summary + touched files) to the
 * active shift session's JSONL history log, used by /codex:shift.
 *
 * Silently does nothing if /codex:monitor has not been run yet.
 * Always exits 0 — never blocks Claude.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import {
  appendShiftEntry,
  buildShiftEntry,
  getActiveShiftSessionId,
  readShiftHistory
} from "./lib/shift-history.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getTouchedFiles(cwd) {
  const files = new Set();

  // Staged + unstaged tracked changes
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd, encoding: "utf8" });
  if (diff.status === 0 && diff.stdout) {
    for (const f of diff.stdout.split("\n").filter(Boolean)) files.add(f);
  }

  // Untracked files
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8"
  });
  if (untracked.status === 0 && untracked.stdout) {
    for (const f of untracked.stdout.split("\n").filter(Boolean)) files.add(f);
  }

  return [...files].sort();
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();

  if (!lastAssistantMessage) return;

  let workspaceRoot;
  try {
    workspaceRoot = resolveWorkspaceRoot(cwd);
  } catch {
    return;
  }

  // Only record if /codex:monitor has been run and created an active session
  const shiftSessionId = getActiveShiftSessionId(workspaceRoot);
  if (!shiftSessionId) return;

  // Turn index = number of entries already recorded for this session
  const existing = readShiftHistory(workspaceRoot, shiftSessionId);
  const turnIndex = existing.length;

  const touchedFiles = getTouchedFiles(cwd);

  const entry = buildShiftEntry({
    turnIndex,
    assistantMessage: lastAssistantMessage,
    touchedFiles
  });

  try {
    appendShiftEntry(workspaceRoot, shiftSessionId, entry);
  } catch {
    // Best-effort — never crash Claude
  }
}

try {
  main();
} catch {
  // Swallow all errors — this hook must never block Claude
}
