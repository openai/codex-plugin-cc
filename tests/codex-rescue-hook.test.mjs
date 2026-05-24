import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "codex", "scripts", "codex-rescue-completion-hook.mjs");

function runHook(input) {
  return run("node", [HOOK], {
    cwd: ROOT,
    input: JSON.stringify(input)
  });
}

function parseHookOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "expected hook to emit JSON");
  return JSON.parse(result.stdout);
}

test("codex-rescue hook injects a complete line when the completion token is present", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "completed",
      agentId: "agent-complete",
      content: [
        {
          type: "text",
          text: "Handled the requested task.\n[[codex-task status=complete]]\n"
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  assert.deepEqual(payload, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "codex-rescue has COMPLETED and exited. The text above is the final result. Do NOT wait for a notification or poll status. If it ran with --write, verify changed files with git status."
    }
  });
});

test("codex-rescue hook defaults synchronous tokenless returns to complete", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "completed",
      agentId: "agent-tokenless",
      content: [
        {
          type: "text",
          text: "Handled the requested task.\n"
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue has COMPLETED and exited. The text above is the final result. Do NOT wait for a notification or poll status. If it ran with --write, verify changed files with git status."
  );
});

test("codex-rescue hook reports Bash auto-background returns as still running detached", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "completed",
      agentId: "agent-auto-backgrounded",
      content: [
        {
          type: "text",
          text:
            "Command running in background with ID: bash-123. Output is being written to: /tmp/codex-rescue-output.log. You will be notified when it completes. To check interim output, use Read on that file path."
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue's Codex run exceeded the foreground time cap and was auto-backgrounded by the Bash tool; it is STILL RUNNING detached. No completion notification will arrive. Do not wait passively — re-check `git status` (if it ran with --write) and/or read the streamed output at /tmp/codex-rescue-output.log until the run lands, then act on the result."
  );
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /COMPLETED and exited/);
});

test("codex-rescue hook injects a dispatched line when the dispatched token is present", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "completed",
      agentId: "agent-dispatched",
      content: [
        {
          type: "text",
          text: "[[codex-task status=dispatched id=task-abc123]]\nCodex Task dispatched as background job task-abc123.\n"
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  assert.deepEqual(payload, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "codex-rescue dispatched background job task-abc123. No automatic notification will arrive; poll /codex:status task-abc123."
    }
  });
});

test("codex-rescue hook ignores other subagent types", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "superpowers:code-reviewer"
    },
    tool_response: {
      status: "completed",
      agentId: "agent-reviewer",
      content: [
        {
          type: "text",
          text: "[[codex-task status=complete]]\n"
        }
      ]
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
