#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { loadState } from "./lib/state.mjs";
import { parseTaskStatusToken } from "./lib/task-status-token.mjs";

const COMPANION_SCRIPT_PATH = fileURLToPath(new URL("./codex-companion.mjs", import.meta.url));
const COMPLETE_CONTEXT =
  "codex-rescue has COMPLETED and exited. The text above is the final result. Do NOT wait for a notification or poll status. If it ran with --write, verify changed files with git status.";
const NEUTRAL_EXIT_CONTEXT =
  "codex-rescue has exited (synchronous return — it is not running). Treat the text above as its result and verify on disk (`git status` if it ran with --write); do not wait for a notification or poll status.";
const FAILURE_CONTEXT =
  "codex-rescue exited WITHOUT a success signal — it is not running, so do not wait for a notification, but the run may have failed or produced no result. Review the output above and `git status`, then re-run or escalate instead of treating it as done.";
// Known non-success statuses. Without the complete sentinel, one of these (or
// an empty body) means there is no success signal, so we must not claim the
// run succeeded (PR #346 review P1).
const FAILURE_STATUSES = new Set(["failed", "fail", "error", "errored", "cancelled", "canceled", "timed_out", "timeout", "aborted"]);
const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const NON_TERMINAL_AGENT_STATUSES = new Set(["async_launched", "running", "sub_agent_entered"]);
const BASH_AUTO_BACKGROUND_MARKER = "Command running in background with ID:";
const BASH_AUTO_BACKGROUND_OUTPUT_PREFIX = "Output is being written to:";
// PR #346 review: state fallback is only safe when this synchronous return
// contains invocation-specific evidence that the task was actually backgrounded.
const BACKGROUND_INTENT_PATTERN =
  /running in (?:the\s+)?background|backgrounded|dispatched|you'?ll be notified|you will be notified|will notify|will be notified/i;

function buildWatcherContext(jobId) {
  return `codex-rescue background job ${jobId} is RUNNING — there is no automatic push notification. To be notified, arm a watcher: run this via the Bash tool with run_in_background=true:  node "${COMPANION_SCRIPT_PATH}" status ${jobId} --wait --timeout-ms 1800000  — it blocks until the job is terminal, then exits and re-invokes you. If it returns and the job is still running, re-arm the same command. Do NOT treat the job as done until the watcher reports a terminal status.`;
}

function extractBashAutoBackgroundOutputPath(text) {
  const prefixIndex = text.indexOf(BASH_AUTO_BACKGROUND_OUTPUT_PREFIX);
  if (prefixIndex === -1) {
    return null;
  }

  const afterPrefix = text.slice(prefixIndex + BASH_AUTO_BACKGROUND_OUTPUT_PREFIX.length).trim();
  const endMarkers = [". You will be notified", "\n", "\r"];
  let endIndex = afterPrefix.length;
  for (const marker of endMarkers) {
    const markerIndex = afterPrefix.indexOf(marker);
    if (markerIndex !== -1 && markerIndex < endIndex) {
      endIndex = markerIndex;
    }
  }

  const outputPath = afterPrefix.slice(0, endIndex).trim();
  return outputPath || null;
}

function buildBashAutoBackgroundContext(outputPath) {
  const followUp = outputPath
    ? `re-check \`git status\` (if it ran with --write) and/or read the streamed output at ${outputPath}`
    : "re-check `git status` (if it ran with --write)";
  return `codex-rescue's Codex run exceeded the foreground time cap and was auto-backgrounded by the Bash tool; it is STILL RUNNING detached. No completion notification will arrive. Do not wait passively — ${followUp} until the run lands, then act on the result.`;
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitAdditionalContext(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext
      }
    })}\n`
  );
}

function isCodexRescueAgentToolUse(input) {
  if (input?.hook_event_name !== "PostToolUse" || input?.tool_name !== "Agent") {
    return false;
  }

  const subagentType = String(
    input?.tool_input?.subagent_type ?? input?.tool_input?.subagentType ?? input?.tool_input?.agent_type ?? ""
  ).toLowerCase();
  return subagentType.includes("codex-rescue");
}

function isSynchronousAgentReturn(toolResponse) {
  const status = String(toolResponse?.status ?? "").toLowerCase();
  // PR #346 review (P2): sub_agent_entered is an interactive handoff, not a terminal
  // return — the rescue agent is still active, so the completion hook must stay silent.
  return !NON_TERMINAL_AGENT_STATUSES.has(status);
}

function getHookCwd(input) {
  const cwd = input?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
}

function compareJobsNewestFirst(left, right) {
  return String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? ""));
}

function findNewestActiveTaskJob(cwd, sessionId) {
  const activeTaskJobs = [...loadState(cwd).jobs].filter(
    (job) => job?.jobClass === "task" && ACTIVE_TASK_STATUSES.has(String(job.status ?? ""))
  );
  const normalizedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId : null;
  // Companion task jobs are session-owned; when Claude gives us the current
  // session id, only infer active state from jobs created by this same session.
  // Older hook inputs had no session_id, so those preserve the unscoped fallback.
  const candidateJobs = normalizedSessionId
    ? activeTaskJobs.filter((job) => job?.sessionId === normalizedSessionId)
    : activeTaskJobs;
  return candidateJobs.sort(compareJobsNewestFirst)[0] ?? null;
}

function isFailedOrEmptyReturn(toolResponse, responseText) {
  // codex-rescue returns nothing when Codex can't be invoked; an empty body or
  // a known failure status means there is no success signal to report.
  if (String(responseText ?? "").trim() === "") {
    return true;
  }
  const status = String(toolResponse?.status ?? "").toLowerCase();
  return FAILURE_STATUSES.has(status);
}

function hasFailureStatus(toolResponse) {
  return FAILURE_STATUSES.has(String(toolResponse?.status ?? "").toLowerCase());
}

function collectText(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") {
    return "";
  }

  const textParts = [];
  if (typeof value.text === "string") {
    textParts.push(value.text);
  }
  if (typeof value.content === "string") {
    textParts.push(value.content);
  } else if (Array.isArray(value.content)) {
    textParts.push(collectText(value.content));
  }
  if (typeof value.result === "string") {
    textParts.push(value.result);
  }
  if (typeof value.stdout === "string") {
    textParts.push(value.stdout);
  }
  return textParts.filter(Boolean).join("\n");
}

function buildCompletionContext(input) {
  const toolResponse = input?.tool_response;
  if (!isSynchronousAgentReturn(toolResponse)) {
    return null;
  }

  const responseText = collectText(toolResponse);
  // PR #346 review (P1): the structured Agent tool status is authoritative over any
  // [[codex-task ...]] line in the body. A failed return whose text echoes a complete/
  // dispatched token must not be reclassified as success or an active dispatch, so a
  // known failure status short-circuits before token handling.
  if (hasFailureStatus(toolResponse)) {
    return FAILURE_CONTEXT;
  }

  const token = parseTaskStatusToken(responseText);
  // The complete sentinel is the only positive proof of a successful run; the
  // companion stamps it solely on real completion, so it is the lone path that
  // asserts success (PR #346 review P1).
  if (token?.status === "complete") {
    return COMPLETE_CONTEXT;
  }
  // Status tokens are emitted by this codex-rescue return, so they are more
  // authoritative than any task state that may belong to another concurrent run.
  if (token?.status === "dispatched" && token.id) {
    return buildWatcherContext(token.id);
  }

  // Bash auto-backgrounds commands that exceed the ~600s foreground cap. That
  // synchronous Agent return means the Bash wrapper detached, not that Codex
  // completed, so report the still-running state before any completion claim.
  if (responseText.includes(BASH_AUTO_BACKGROUND_MARKER)) {
    return buildBashAutoBackgroundContext(extractBashAutoBackgroundOutputPath(responseText));
  }

  // PR #346 review: only consult global companion state after this return says
  // the task was backgrounded; otherwise an unrelated active task can hide a
  // sentinel-less failure from the foreground invocation that just returned.
  if (BACKGROUND_INTENT_PATTERN.test(responseText)) {
    const activeTaskJob = findNewestActiveTaskJob(getHookCwd(input), input?.session_id);
    if (activeTaskJob) {
      return buildWatcherContext(activeTaskJob.id);
    }
  }

  // No success evidence: never claim success here. A failure status or an empty
  // return gets a failure-aware line; everything else gets a neutral "exited,
  // verify on disk" line. Every branch still says "do not wait" because a
  // synchronous Agent return means the agent has exited.
  if (isFailedOrEmptyReturn(toolResponse, responseText)) {
    return FAILURE_CONTEXT;
  }
  return NEUTRAL_EXIT_CONTEXT;
}

function main() {
  const input = readHookInput();
  if (!isCodexRescueAgentToolUse(input)) {
    return;
  }

  const context = buildCompletionContext(input);
  if (context) {
    emitAdditionalContext(context);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
