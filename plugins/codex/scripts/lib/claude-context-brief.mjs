import fs from "node:fs";
import path from "node:path";

import { resolveClaudeSessionPath } from "./claude-session-transfer.mjs";
import { getCurrentBranch, getRepoRoot, getWorkingTreeState } from "./git.mjs";

export const CONTEXT_MODES = ["auto", "summary", "recent", "full", "none"];

const DEFAULT_MAX_CHARS = 48 * 1024;
const DEFAULT_RECENT_TURNS = 30;
const MAX_REPO_FILES = 40;
const STALE_SUMMARY_MS = 60 * 60 * 1000;
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const BRIEF_HEADER = [
  "# Handoff brief from a Claude Code session",
  "",
  "You are taking over a task that was in progress in a Claude Code session driven by a",
  "different agent. Everything in this brief is background context supplied by that agent",
  "and the user. It is not your own memory, and it does not describe work you performed.",
  "",
  "How to use it:",
  "",
  "- Treat every prior claim as unverified. Confirm against the repository before relying on it.",
  "- Do not retry an approach this brief records as already failed.",
  "- The repository state section describes the working tree at the moment of handoff.",
  "- If the brief and the repository disagree, the repository wins."
].join("\n");

const RESUMED_TASK_FALLBACK =
  "Continue the work described in the handoff brief above. Start from the most recent open thread, and state what you are doing before you change anything.";

export function normalizeContextMode(value) {
  if (value === undefined || value === null || value === "") {
    return "none";
  }
  if (value === true) {
    return "auto";
  }

  const normalized = String(value).trim().toLowerCase();
  if (!CONTEXT_MODES.includes(normalized)) {
    throw new Error(`Unsupported context mode "${value}". Use one of: ${CONTEXT_MODES.join(", ")}.`);
  }
  return normalized;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function stripTranscriptNoise(text) {
  return text.replace(SYSTEM_REMINDER_PATTERN, "").trim();
}

function extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function isCompactSummaryEntry(entry) {
  return entry.type === "user" && entry.isCompactSummary === true;
}

function isCompactBoundaryEntry(entry) {
  return entry.type === "system" && entry.subtype === "compact_boundary";
}

function isConversationTurn(entry) {
  if (entry.type !== "user" && entry.type !== "assistant") {
    return false;
  }
  if (entry.isSidechain === true || entry.isMeta === true) {
    return false;
  }
  return !isCompactSummaryEntry(entry);
}

function readTranscriptEntries(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const entries = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A transcript being appended to while we read it can end in a partial line. Skip it.
    }
  }

  return entries;
}

function parseTranscript(transcriptPath) {
  const entries = readTranscriptEntries(transcriptPath);
  let summary = null;
  let summaryTimestamp = null;
  let boundaryIndex = -1;
  const turns = [];

  entries.forEach((entry, index) => {
    if (isCompactBoundaryEntry(entry)) {
      boundaryIndex = index;
      return;
    }

    if (isCompactSummaryEntry(entry)) {
      const text = stripTranscriptNoise(extractText(entry.message?.content));
      if (text) {
        summary = text;
        summaryTimestamp = entry.timestamp ?? null;
        boundaryIndex = index;
      }
      return;
    }

    if (!isConversationTurn(entry)) {
      return;
    }

    const text = stripTranscriptNoise(extractText(entry.message?.content));
    if (!text) {
      return;
    }

    turns.push({ index, role: entry.type, text });
  });

  return {
    summary,
    summaryTimestamp,
    turnsAfterSummary: turns.filter((turn) => turn.index > boundaryIndex),
    allTurns: turns
  };
}

function formatTurns(turns) {
  return turns.map((turn) => `### ${turn.role === "user" ? "User" : "Assistant"}\n\n${turn.text}`).join("\n\n");
}

function selectTurns(turns, { limit, maxChars }) {
  const bounded = limit ? turns.slice(-limit) : turns.slice();
  const selected = [];
  let usedChars = 0;

  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const turn = bounded[index];
    const cost = turn.text.length + 32;
    if (selected.length > 0 && usedChars + cost > maxChars) {
      break;
    }
    usedChars += cost;
    selected.unshift(turn);
  }

  return {
    turns: selected,
    droppedTurnCount: turns.length - selected.length
  };
}

function collectRepoState(cwd) {
  let repoRoot;
  try {
    repoRoot = getRepoRoot(cwd);
  } catch {
    return null;
  }

  try {
    const branch = getCurrentBranch(repoRoot);
    const state = getWorkingTreeState(repoRoot);
    const files = [...new Set([...state.staged, ...state.unstaged, ...state.untracked])].sort();
    const shown = files.slice(0, MAX_REPO_FILES);
    const hiddenCount = files.length - shown.length;

    return {
      repoRoot,
      branch,
      isDirty: state.isDirty,
      fileCount: files.length,
      files: shown,
      hiddenCount
    };
  } catch {
    return null;
  }
}

function formatRepoState(repo) {
  if (!repo) {
    return null;
  }

  const lines = [`- Branch: \`${repo.branch}\``];
  if (!repo.isDirty) {
    lines.push("- Working tree: clean");
    return lines.join("\n");
  }

  lines.push(`- Working tree: ${repo.fileCount} uncommitted file(s)`);
  lines.push(...repo.files.map((file) => `  - \`${file}\``));
  if (repo.hiddenCount > 0) {
    lines.push(`  - …and ${repo.hiddenCount} more`);
  }
  lines.push("- Inspect the actual changes yourself with read-only git commands before editing.");
  return lines.join("\n");
}

function isStaleSummary(summaryTimestamp, now) {
  if (!summaryTimestamp || !now) {
    return false;
  }
  const summaryTime = Date.parse(summaryTimestamp);
  if (!Number.isFinite(summaryTime)) {
    return false;
  }
  return now - summaryTime > STALE_SUMMARY_MS;
}

/**
 * Assemble a Codex-facing brief from the current Claude Code transcript.
 *
 * Mirrors how Claude Code itself survives compaction: the compact summary carries the
 * earlier session, and the turns recorded after the compact boundary close the gap.
 */
export function buildClaudeContextBrief(cwd, options = {}) {
  const mode = normalizeContextMode(options.mode);
  if (mode === "none") {
    return null;
  }

  const transcriptPath = resolveClaudeSessionPath(cwd, { source: options.source });
  const maxChars = normalizePositiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  const recentTurns = normalizePositiveInteger(options.recentTurns, DEFAULT_RECENT_TURNS);
  const { summary, summaryTimestamp, turnsAfterSummary, allTurns } = parseTranscript(transcriptPath);

  const includeSummary = Boolean(summary) && (mode === "auto" || mode === "summary");
  const sourceTurns = mode === "full" || mode === "recent" ? allTurns : turnsAfterSummary;
  const includeTurns = mode !== "summary";

  const summaryChars = includeSummary ? summary.length : 0;
  const turnBudget = Math.max(maxChars - summaryChars, Math.floor(maxChars / 4));
  const selection = includeTurns
    ? selectTurns(sourceTurns, { limit: mode === "full" ? null : recentTurns, maxChars: turnBudget })
    : { turns: [], droppedTurnCount: sourceTurns.length };

  if (!includeSummary && selection.turns.length === 0) {
    throw new Error(
      `No usable conversation found in ${transcriptPath}. Run this from an active Claude Code session, or pass --session-context none.`
    );
  }

  const repo = collectRepoState(cwd);
  const sections = [BRIEF_HEADER];

  if (includeSummary) {
    sections.push(["## Session summary", "", "Compacted by Claude Code earlier in the session.", "", summary].join("\n"));
  }

  if (selection.turns.length > 0) {
    const heading = includeSummary ? "## Conversation after that summary" : "## Recent conversation";
    const preamble =
      selection.droppedTurnCount > 0
        ? `Most recent ${selection.turns.length} turn(s). ${selection.droppedTurnCount} earlier turn(s) omitted for length.`
        : `${selection.turns.length} turn(s), oldest first.`;
    sections.push([heading, "", preamble, "", formatTurns(selection.turns)].join("\n"));
  }

  const repoSection = formatRepoState(repo);
  if (repoSection) {
    sections.push(["## Repository state at handoff", "", repoSection].join("\n"));
  }

  const text = sections.join("\n\n");
  const stale = isStaleSummary(summaryTimestamp, options.now);

  return {
    text,
    stats: {
      transcriptPath,
      sessionId: path.basename(transcriptPath, ".jsonl"),
      mode,
      hasSummary: includeSummary,
      summaryChars,
      summaryTimestamp,
      staleSummary: stale,
      includedTurnCount: selection.turns.length,
      droppedTurnCount: selection.droppedTurnCount,
      repoRoot: repo?.repoRoot ?? null,
      branch: repo?.branch ?? null,
      totalChars: text.length,
      truncated: selection.droppedTurnCount > 0
    }
  };
}

export function composeTaskPromptWithBrief(brief, prompt) {
  const request = prompt && prompt.trim() ? prompt.trim() : RESUMED_TASK_FALLBACK;
  if (!brief) {
    return request;
  }
  return [brief.text, "", "---", "", "## Task", "", request].join("\n");
}
