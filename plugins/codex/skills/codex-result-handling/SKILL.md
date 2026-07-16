---
name: codex-result-handling
description: Internal guidance for presenting Codex helper output back to the user
user-invocable: false
---

# Codex Result Handling

When the helper returns Codex output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Codex marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files when the helper provides them.
- For `codex:codex-rescue`, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure and stop.
- For `codex:codex-rescue`, if Codex was never successfully invoked, do not generate a substitute answer at all.
- For `codex:codex-rescue`, treat a standalone `[[codex-task status=complete]]` sentinel, or the matching PostToolUse hook context, as authoritative proof that the synchronous subagent has finished and exited. Do not wait for a notification or poll status after that signal.
- For `codex:codex-rescue`, treat a standalone `[[codex-task status=dispatched id=<jobId>]]` sentinel as a background-dispatch signal, not a completion signal. No automatic push notification will arrive; arm `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status <jobId> --wait --timeout-ms 1800000` via the Bash tool with `run_in_background=true` to be re-invoked on terminal status. If it returns while the job is still running, re-arm the same command. Never treat a dispatched/background job as done until that watcher returns a terminal status.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Codex run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/codex:setup` and do not improvise alternate auth flows.
- The Claude Code harness appends an `agentId: <id> (use SendMessage with to: '<id>' to continue this agent)` line to every `Agent(codex:codex-rescue)` return. This is a resume token for continuing the same agent thread, NOT a "still running" or "in background" status signal. By the time you see it, the agent has finished and the work is done. Do not paraphrase it as "Codex is running in background" or "task dispatched async" — read the stdout above the suffix for the real completion state, and verify with `git status --short` if the agent had `--write`.
