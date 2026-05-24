#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { parseTaskStatusToken } from "./lib/task-status-token.mjs";

const COMPLETE_CONTEXT =
  "codex-rescue has COMPLETED and exited. The text above is the final result. Do NOT wait for a notification or poll status. If it ran with --write, verify changed files with git status.";
const BASH_AUTO_BACKGROUND_MARKER = "Command running in background with ID:";
const BASH_AUTO_BACKGROUND_OUTPUT_PREFIX = "Output is being written to:";

function buildDispatchedContext(jobId) {
  return `codex-rescue dispatched background job ${jobId}. No automatic notification will arrive; poll /codex:status ${jobId}.`;
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
  return status !== "async_launched" && status !== "running";
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
  const token = parseTaskStatusToken(responseText);
  if (token?.status === "dispatched" && token.id) {
    return buildDispatchedContext(token.id);
  }
  if (token?.status === "complete") {
    return COMPLETE_CONTEXT;
  }

  // Bash auto-backgrounds commands that exceed the 600s foreground cap. That
  // synchronous Agent return means the Bash wrapper detached, not that Codex
  // completed, so report the still-running state before tokenless completion.
  if (responseText.includes(BASH_AUTO_BACKGROUND_MARKER)) {
    return buildBashAutoBackgroundContext(extractBashAutoBackgroundOutputPath(responseText));
  }

  // Token absence still means completion here because PostToolUse fires only
  // after a synchronous Agent tool call has returned to the parent thread.
  return COMPLETE_CONTEXT;
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
