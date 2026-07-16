import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { saveState } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "codex", "scripts", "codex-rescue-completion-hook.mjs");
const COMPANION = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function withPluginData(pluginDataDir, callback) {
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return callback();
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
}

function seedHookState(cwd, pluginDataDir, jobs) {
  withPluginData(pluginDataDir, () =>
    saveState(cwd, {
      version: 1,
      config: { stopReviewGate: false },
      jobs
    })
  );
}

function runHook(input, options = {}) {
  const pluginDataDir = options.pluginDataDir ?? makeTempDir();
  return run("node", [HOOK], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify(input)
  });
}

function parseHookOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "expected hook to emit JSON");
  return JSON.parse(result.stdout);
}

function expectedWatcherContext(jobId) {
  return `codex-rescue background job ${jobId} is RUNNING — there is no automatic push notification. To be notified, arm a watcher: run this via the Bash tool with run_in_background=true:  node "${COMPANION}" status ${jobId} --wait --timeout-ms 1800000  — it blocks until the job is terminal, then exits and re-invokes you. If it returns and the job is still running, re-arm the same command. Do NOT treat the job as done until the watcher reports a terminal status.`;
}

test("codex-rescue hook emits a watcher when this return has background phrasing and active task state", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  seedHookState(workspace, pluginDataDir, [
    {
      id: "task-queued-old",
      status: "queued",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "session-main",
      updatedAt: "2026-05-25T10:00:00.000Z"
    },
    {
      id: "review-running-newer",
      status: "running",
      title: "Codex Review",
      jobClass: "review",
      updatedAt: "2026-05-25T10:10:00.000Z"
    },
    {
      id: "task-running-new",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "session-main",
      updatedAt: "2026-05-25T10:05:00.000Z"
    }
  ]);

  const result = runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      session_id: "session-main",
      cwd: workspace,
      tool_input: {
        subagent_type: "codex:codex-rescue"
      },
      tool_response: {
        status: "completed",
        agentId: "agent-paraphrased-dispatch",
        content: [
          {
            type: "text",
            text: "Codex is running in background (ID task-running-new)."
          }
        ]
      }
    },
    { pluginDataDir }
  );

  const payload = parseHookOutput(result);
  assert.deepEqual(payload, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: expectedWatcherContext("task-running-new")
    }
  });
  assert.ok(payload.hookSpecificOutput.additionalContext.includes(`node "${COMPANION}" status task-running-new`));
});

test("codex-rescue hook does not infer active state without background evidence in this return", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  seedHookState(workspace, pluginDataDir, [
    {
      id: "task-unrelated-running",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "session-main",
      updatedAt: "2026-05-25T10:05:00.000Z"
    }
  ]);

  const result = runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      session_id: "session-main",
      cwd: workspace,
      tool_input: {
        subagent_type: "codex:codex-rescue"
      },
      tool_response: {
        status: "failed",
        agentId: "agent-sentinel-less-failure",
        content: [
          {
            type: "text",
            text: "Codex could not be invoked.\n"
          }
        ]
      }
    },
    { pluginDataDir }
  );

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue exited WITHOUT a success signal — it is not running, so do not wait for a notification, but the run may have failed or produced no result. Review the output above and `git status`, then re-run or escalate instead of treating it as done."
  );
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /background job task-unrelated-running/);
});

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

test("codex-rescue hook reports failure (not success) when a failed return echoes the complete token", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "failed",
      agentId: "agent-failed-echo-complete",
      content: [
        {
          type: "text",
          text: "The original prompt mentioned this literal token:\n[[codex-task status=complete]]\nThe run still failed.\n"
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  const additionalContext = payload.hookSpecificOutput.additionalContext;
  assert.match(additionalContext, /exited WITHOUT a success signal/);
  assert.doesNotMatch(additionalContext, /COMPLETED and exited/);
});

test("codex-rescue hook treats the completion token as authoritative over active task state", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  seedHookState(workspace, pluginDataDir, [
    {
      id: "task-unrelated-running",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "other-session",
      updatedAt: "2026-05-25T10:20:00.000Z"
    }
  ]);

  const result = runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      cwd: workspace,
      tool_input: {
        subagent_type: "codex:codex-rescue"
      },
      tool_response: {
        status: "completed",
        agentId: "agent-complete-with-unrelated-active-job",
        content: [
          {
            type: "text",
            text: "Handled the requested task.\n[[codex-task status=complete]]\n"
          }
        ]
      }
    },
    { pluginDataDir }
  );

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue has COMPLETED and exited. The text above is the final result. Do NOT wait for a notification or poll status. If it ran with --write, verify changed files with git status."
  );
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /background job task-unrelated-running/);
});

test("codex-rescue hook scopes background-evidenced active task state to the current session", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  seedHookState(workspace, pluginDataDir, [
    {
      id: "task-current-session",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "session-current",
      updatedAt: "2026-05-25T10:00:00.000Z"
    },
    {
      id: "task-other-session-newer",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "session-other",
      updatedAt: "2026-05-25T10:30:00.000Z"
    }
  ]);

  const scopedResult = runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      session_id: "session-current",
      cwd: workspace,
      tool_input: {
        subagent_type: "codex:codex-rescue"
      },
      tool_response: {
        status: "completed",
        agentId: "agent-tokenless-current-session",
        content: [
          {
            type: "text",
            text: "Codex is still running in the background."
          }
        ]
      }
    },
    { pluginDataDir }
  );

  const scopedPayload = parseHookOutput(scopedResult);
  assert.equal(scopedPayload.hookSpecificOutput.additionalContext, expectedWatcherContext("task-current-session"));
  assert.doesNotMatch(scopedPayload.hookSpecificOutput.additionalContext, /task-other-session-newer/);

  const unscopedResult = runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      cwd: workspace,
      tool_input: {
        subagent_type: "codex:codex-rescue"
      },
      tool_response: {
        status: "completed",
        agentId: "agent-tokenless-without-session",
        content: [
          {
            type: "text",
            text: "Codex is still running in the background."
          }
        ]
      }
    },
    { pluginDataDir }
  );

  const unscopedPayload = parseHookOutput(unscopedResult);
  assert.equal(unscopedPayload.hookSpecificOutput.additionalContext, expectedWatcherContext("task-other-session-newer"));
});

test("codex-rescue hook reports synchronous tokenless returns neutrally", () => {
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
    "codex-rescue has exited (synchronous return — it is not running). Treat the text above as its result and verify on disk (`git status` if it ran with --write); do not wait for a notification or poll status."
  );
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /final result/);
});

test("codex-rescue hook reports failed tokenless returns without a success signal", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "failed",
      agentId: "agent-failed",
      content: [
        {
          type: "text",
          text: "Codex could not be invoked.\n"
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue exited WITHOUT a success signal — it is not running, so do not wait for a notification, but the run may have failed or produced no result. Review the output above and `git status`, then re-run or escalate instead of treating it as done."
  );
});

test("codex-rescue hook stays silent on sub_agent_entered handoff", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "sub_agent_entered",
      agentId: "agent-interactive-handoff",
      content: [
        {
          type: "text",
          text: "codex-rescue entered an interactive subagent handoff.\n"
        }
      ]
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("codex-rescue hook reports empty tokenless returns without a success signal", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "completed",
      agentId: "agent-empty",
      content: [
        {
          type: "text",
          text: ""
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue exited WITHOUT a success signal — it is not running, so do not wait for a notification, but the run may have failed or produced no result. Review the output above and `git status`, then re-run or escalate instead of treating it as done."
  );
});

test("codex-rescue hook reports Bash auto-background returns as still running detached", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  seedHookState(workspace, pluginDataDir, [
    {
      id: "task-unrelated-running",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: "session-main",
      updatedAt: "2026-05-25T10:05:00.000Z"
    }
  ]);

  const result = runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      session_id: "session-main",
      cwd: workspace,
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
    },
    { pluginDataDir }
  );

  const payload = parseHookOutput(result);
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    "codex-rescue's Codex run exceeded the foreground time cap and was auto-backgrounded by the Bash tool; it is STILL RUNNING detached. No completion notification will arrive. Do not wait passively — re-check `git status` (if it ran with --write) and/or read the streamed output at /tmp/codex-rescue-output.log until the run lands, then act on the result."
  );
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /COMPLETED and exited/);
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /background job task-unrelated-running/);
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
      additionalContext: expectedWatcherContext("task-abc123")
    }
  });
});

test("codex-rescue hook reports failure (not dispatch) when a failed return echoes a dispatched token", () => {
  const result = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "codex:codex-rescue"
    },
    tool_response: {
      status: "failed",
      agentId: "agent-failed-echo-dispatched",
      content: [
        {
          type: "text",
          text:
            "The model output echoed a dispatch example:\n[[codex-task status=dispatched id=task-xxxx]]\nNo worker was actually launched.\n"
        }
      ]
    }
  });

  const payload = parseHookOutput(result);
  const additionalContext = payload.hookSpecificOutput.additionalContext;
  assert.match(additionalContext, /exited WITHOUT a success signal/);
  assert.doesNotMatch(additionalContext, /status .* --wait/);
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
