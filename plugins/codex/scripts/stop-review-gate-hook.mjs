#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 15 minutes. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

/**
 * Discover sibling git repositories under the parent of [workspaceRoot].
 * Used when monorepo mode is enabled: each sibling has its own state and
 * is reviewed independently, so changes outside the cwd's repo are not
 * silently skipped by the stop-time gate.
 *
 * Depth is fixed at 1 (immediate children of the parent dir) — recursive
 * scanning is intentionally avoided to keep the hook fast and predictable.
 */
function discoverSiblingWorkspaces(workspaceRoot) {
  try {
    const parent = path.dirname(workspaceRoot);
    if (!parent || parent === workspaceRoot) {
      return [];
    }
    const entries = fs.readdirSync(parent, { withFileTypes: true });
    const siblings = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(parent, entry.name);
      if (candidate === workspaceRoot) continue;
      // Treat both `.git/` dirs and worktree `.git` files as a git repo.
      const gitMarker = path.join(candidate, ".git");
      if (fs.existsSync(gitMarker)) {
        siblings.push(candidate);
      }
    }
    return siblings;
  } catch {
    return [];
  }
}

/**
 * Return true when the workspace has uncommitted changes (tracked or
 * untracked). If git is unavailable or the directory is not a repo, the
 * function returns false so the hook does not waste a Codex review on
 * an empty diff.
 */
function workspaceHasChanges(workspaceRoot) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return false;
  }
  return String(result.stdout ?? "").trim().length > 0;
}

function reviewWorkspace(workspaceRoot, input) {
  const setupNote = buildSetupNote(workspaceRoot);
  if (setupNote) {
    return { ok: true, note: setupNote };
  }
  const review = runStopReview(workspaceRoot, input);
  if (!review.ok) {
    return {
      ok: false,
      reason: `[${path.basename(workspaceRoot)}] ${review.reason}`
    };
  }
  return { ok: true };
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  // Build the list of workspaces to review. The primary workspace is
  // always included to preserve existing single-repo behavior. When
  // monorepo mode is enabled, sibling git repos under the parent dir
  // are added if their own state has the gate enabled *and* they have
  // uncommitted changes (otherwise Codex would just respond ALLOW for
  // an empty diff and waste tokens).
  const workspaces = [workspaceRoot];
  if (config.monorepoMode) {
    for (const sibling of discoverSiblingWorkspaces(workspaceRoot)) {
      const siblingConfig = getConfig(sibling);
      if (!siblingConfig.stopReviewGate) continue;
      if (!workspaceHasChanges(sibling)) continue;
      workspaces.push(sibling);
    }
  }

  const failures = [];
  for (const ws of workspaces) {
    const result = reviewWorkspace(ws, input);
    if (result.note) {
      logNote(result.note);
    }
    if (!result.ok) {
      failures.push(result.reason);
    }
  }

  if (failures.length > 0) {
    const combined = failures.join("\n\n");
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${combined}` : combined
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
