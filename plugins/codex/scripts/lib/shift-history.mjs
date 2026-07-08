import fs from "node:fs";
import path from "node:path";

import { ensureStateDir, resolveStateDir } from "./state.mjs";

const SHIFT_ACTIVE_FILE = "shift-active.json";
const MAX_HISTORY_ENTRIES = 200;
const ASSISTANT_SUMMARY_LENGTH = 300;
const COMPACT_RECENT_TURNS = 8;

// ─── Path helpers ────────────────────────────────────────────────────────────

export function resolveShiftActiveFile(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), SHIFT_ACTIVE_FILE);
}

export function resolveShiftHistoryFile(workspaceRoot, shiftSessionId) {
  return path.join(resolveStateDir(workspaceRoot), `${shiftSessionId}.jsonl`);
}

export function resolveShiftCompactFile(workspaceRoot, shiftSessionId) {
  return path.join(resolveStateDir(workspaceRoot), `${shiftSessionId}-compact.json`);
}

// ─── Active session ──────────────────────────────────────────────────────────

export function readShiftActive(workspaceRoot) {
  const file = resolveShiftActiveFile(workspaceRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeShiftActive(workspaceRoot, data) {
  ensureStateDir(workspaceRoot);
  fs.writeFileSync(
    resolveShiftActiveFile(workspaceRoot),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8"
  );
}

function generateShiftSessionId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `shift-${Date.now().toString(36)}-${random}`;
}

/**
 * Initialize or resume a shift session.
 *
 * - resume=false (default): generate a new shiftSessionId, write it as active,
 *   add it to the sessions list. Previous sessions are kept on disk.
 * - resume=true, sessionId=null: resume the currently active shiftSessionId.
 *   If none exists, behaves the same as resume=false.
 * - resume=true, sessionId="shift-xxx": set the given session as active and
 *   resume it. Use this when the user picks a specific past session.
 *
 * Returns the active shiftSessionId.
 */
export function initShiftSession(workspaceRoot, options = {}) {
  const existing = readShiftActive(workspaceRoot);
  const now = new Date().toISOString();

  if (options.resume) {
    const targetId = options.sessionId ?? existing?.activeShiftSessionId ?? null;

    if (targetId) {
      // Promote the chosen session to active (it may already be active)
      const prevSessions = existing?.sessions ?? [];
      const sessionMeta = prevSessions.find((s) => s.id === targetId);
      const updatedSessions = sessionMeta
        ? prevSessions.map((s) =>
            s.id === targetId ? { ...s, resumed: true, resumedAt: now } : s
          )
        : [{ id: targetId, startedAt: now, resumed: true, resumedAt: now }, ...prevSessions];

      writeShiftActive(workspaceRoot, {
        ...(existing ?? {}),
        activeShiftSessionId: targetId,
        resumed: true,
        resumedAt: now,
        sessions: updatedSessions
      });
      return targetId;
    }
    // No existing session to resume — fall through to fresh
  }

  // Fresh session
  const id = generateShiftSessionId();
  const prevSessions = existing?.sessions ?? [];

  writeShiftActive(workspaceRoot, {
    activeShiftSessionId: id,
    startedAt: now,
    resumed: false,
    sessions: [
      { id, startedAt: now, resumed: false },
      ...prevSessions
    ]
  });

  return id;
}

/**
 * Get the currently active shiftSessionId without modifying anything.
 * Returns null if no session has been initialized.
 */
export function getActiveShiftSessionId(workspaceRoot) {
  return readShiftActive(workspaceRoot)?.activeShiftSessionId ?? null;
}

/**
 * Attach a Codex job ID to a shift session so that resume can reuse the same
 * Codex thread instead of spawning a new one each time.
 *
 * When prevCodexThreadId is supplied (a resume that already had a thread), it is
 * stored alongside the new job so that /codex:shift can fall back to that thread
 * while the replacement job is still queued and has not yet reported its own threadId.
 */
export function setShiftSessionCodexJobId(workspaceRoot, shiftSessionId, codexJobId, prevCodexThreadId = null) {
  const existing = readShiftActive(workspaceRoot);
  if (!existing) return;
  const updatedSessions = (existing.sessions ?? []).map((s) => {
    if (s.id !== shiftSessionId) return s;
    const updated = { ...s, codexJobId };
    if (prevCodexThreadId) updated.prevCodexThreadId = prevCodexThreadId;
    return updated;
  });
  writeShiftActive(workspaceRoot, { ...existing, sessions: updatedSessions });
}

/**
 * Record which Claude session_id started (or resumed) a shift session.
 * The Stop hook uses this to skip appending turns from unrelated Claude sessions.
 */
export function setShiftSessionClaudeId(workspaceRoot, shiftSessionId, claudeSessionId) {
  if (!claudeSessionId) return;
  const existing = readShiftActive(workspaceRoot);
  if (!existing) return;
  const updatedSessions = (existing.sessions ?? []).map((s) =>
    s.id === shiftSessionId ? { ...s, claudeSessionId } : s
  );
  writeShiftActive(workspaceRoot, { ...existing, sessions: updatedSessions });
}

/**
 * Return the Claude session_id stored for the currently active shift session,
 * or null if none was recorded (pre-existing sessions or session ID unavailable).
 */
export function getActiveShiftClaudeSessionId(workspaceRoot) {
  const active = readShiftActive(workspaceRoot);
  if (!active?.activeShiftSessionId) return null;
  const session = (active.sessions ?? []).find((s) => s.id === active.activeShiftSessionId);
  return session?.claudeSessionId ?? null;
}

/**
 * List all known shift sessions for this workspace, newest first.
 * Includes turnCount derived from the JSONL file.
 */
export function listShiftSessions(workspaceRoot) {
  const active = readShiftActive(workspaceRoot);
  if (!active?.sessions) return [];

  return active.sessions.map((s) => {
    const historyFile = resolveShiftHistoryFile(workspaceRoot, s.id);
    let turnCount = 0;
    let lastSummary = null;

    if (fs.existsSync(historyFile)) {
      try {
        const lines = fs.readFileSync(historyFile, "utf8").split("\n").filter(Boolean);
        turnCount = lines.length;
        // Get the last entry's assistantSummary as a one-line preview
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]);
          const raw = String(last.assistantSummary ?? "").trim();
          // Trim to first sentence or 80 chars, whichever is shorter
          const firstSentence = raw.split(/[.!?\n]/)[0].trim();
          lastSummary = firstSentence.length > 80
            ? firstSentence.slice(0, 77) + "..."
            : firstSentence || null;
        }
      } catch {
        turnCount = 0;
      }
    }

    return {
      ...s,
      turnCount,
      lastSummary,
      active: s.id === active.activeShiftSessionId
    };
  });
}

// ─── History JSONL ────────────────────────────────────────────────────────────

/**
 * Append one turn entry to the session's JSONL history log.
 */
export function appendShiftEntry(workspaceRoot, shiftSessionId, entry) {
  ensureStateDir(workspaceRoot);
  const file = resolveShiftHistoryFile(workspaceRoot, shiftSessionId);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Read all entries from a session's JSONL log.
 */
export function readShiftHistory(workspaceRoot, shiftSessionId) {
  const file = resolveShiftHistoryFile(workspaceRoot, shiftSessionId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ─── Compact ─────────────────────────────────────────────────────────────────

export function readShiftCompact(workspaceRoot, shiftSessionId) {
  const file = resolveShiftCompactFile(workspaceRoot, shiftSessionId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeShiftCompact(workspaceRoot, shiftSessionId, compact) {
  ensureStateDir(workspaceRoot);
  fs.writeFileSync(
    resolveShiftCompactFile(workspaceRoot, shiftSessionId),
    `${JSON.stringify(compact, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Script-based compaction — no LLM needed.
 * Merges all JSONL entries for the session into a compact summary object.
 */
export function compactShiftHistory(workspaceRoot, shiftSessionId) {
  const allEntries = readShiftHistory(workspaceRoot, shiftSessionId);
  if (allEntries.length === 0) return null;

  const existing = readShiftCompact(workspaceRoot, shiftSessionId);

  const touchedFilesSet = new Set(existing?.touchedFiles ?? []);
  for (const entry of allEntries) {
    for (const f of entry.touchedFiles ?? []) {
      touchedFilesSet.add(f);
    }
  }

  const lastEntry = allEntries[allEntries.length - 1];
  const compact = {
    version: 1,
    shiftSessionId,
    compactedAt: new Date().toISOString(),
    compactedThrough: lastEntry.turnIndex ?? allEntries.length - 1,
    goal: existing?.goal ?? "",
    decisions: existing?.decisions ?? [],
    openQuestions: existing?.openQuestions ?? [],
    touchedFiles: [...touchedFilesSet].sort(),
    rawTurnCount: allEntries.length,
    recentTurns: allEntries.slice(-COMPACT_RECENT_TURNS).map((e) => ({
      turnIndex: e.turnIndex,
      ts: e.ts,
      summary: e.assistantSummary
    }))
  };

  writeShiftCompact(workspaceRoot, shiftSessionId, compact);

  // Prune JSONL if it gets too large
  if (allEntries.length > MAX_HISTORY_ENTRIES) {
    const keep = allEntries.slice(-MAX_HISTORY_ENTRIES);
    fs.writeFileSync(
      resolveShiftHistoryFile(workspaceRoot, shiftSessionId),
      keep.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
  }

  return compact;
}

/**
 * Merge ALL sessions for this workspace into one combined compact.
 * Combines touched files, decisions, open questions, and recent turns
 * across every session, newest entries last.
 */
export function mergeAllShiftSessions(workspaceRoot) {
  const sessions = listShiftSessions(workspaceRoot);
  if (sessions.length === 0) return null;

  const touchedFilesSet = new Set();
  const allDecisions = [];
  const allOpenQuestions = [];
  const allTurns = [];

  // Oldest session first so newer turns appear last
  for (const session of [...sessions].reverse()) {
    const compact = compactShiftHistory(workspaceRoot, session.id);
    if (!compact) continue;

    for (const f of compact.touchedFiles ?? []) touchedFilesSet.add(f);
    for (const d of compact.decisions ?? []) {
      if (!allDecisions.includes(d)) allDecisions.push(d);
    }
    for (const q of compact.openQuestions ?? []) {
      if (!allOpenQuestions.includes(q)) allOpenQuestions.push(q);
    }
    for (const t of compact.recentTurns ?? []) {
      allTurns.push({ ...t, sessionId: session.id, sessionDate: session.startedAt.slice(0, 10) });
    }
  }

  return {
    version: 1,
    mergedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    touchedFiles: [...touchedFilesSet].sort(),
    decisions: allDecisions,
    openQuestions: allOpenQuestions,
    // Keep the most recent COMPACT_RECENT_TURNS * sessions worth
    recentTurns: allTurns.slice(-COMPACT_RECENT_TURNS * 2)
  };
}

// ─── Prompt formatting ───────────────────────────────────────────────────────

/**
 * Format a compact object into the context block prepended to the Codex prompt.
 */
export function formatCompactForPrompt(compact, recentHistory = []) {
  if (!compact && recentHistory.length === 0) return null;

  const lines = ["=== Claude Session Context ==="];

  if (compact?.goal) {
    lines.push(`Goal: ${compact.goal}`);
  }

  if (compact?.decisions?.length > 0) {
    lines.push("Decisions made:");
    for (const d of compact.decisions) lines.push(`  - ${d}`);
  }

  const touchedFiles = compact?.touchedFiles ?? [];
  if (touchedFiles.length > 0) {
    lines.push("Files touched this session:");
    for (const f of touchedFiles.slice(0, 20)) lines.push(`  - ${f}`);
    if (touchedFiles.length > 20) lines.push(`  ... and ${touchedFiles.length - 20} more`);
  }

  const turns = compact?.recentTurns ?? recentHistory.slice(-COMPACT_RECENT_TURNS);
  if (turns.length > 0) {
    lines.push("Recent Claude turn summaries:");
    for (const t of turns) {
      const label = t.sessionDate
        ? `[${t.sessionDate} Turn ${t.turnIndex ?? "?"}]`
        : `[Turn ${t.turnIndex ?? "?"}]`;
      lines.push(`  ${label} ${t.summary ?? t.assistantSummary ?? ""}`);
    }
  }

  if (compact?.openQuestions?.length > 0) {
    lines.push("Open questions:");
    for (const q of compact.openQuestions) lines.push(`  - ${q}`);
  }

  lines.push("==============================");
  return lines.join("\n");
}

// ─── Entry builder ────────────────────────────────────────────────────────────

export function buildShiftEntry({ turnIndex, assistantMessage, touchedFiles }) {
  return {
    ts: new Date().toISOString(),
    turnIndex: turnIndex ?? 0,
    assistantSummary: String(assistantMessage ?? "").trim().slice(0, ASSISTANT_SUMMARY_LENGTH),
    touchedFiles: touchedFiles ?? []
  };
}
