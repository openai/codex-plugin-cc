---
description: Send a correction to a running Codex task, optionally interrupting its current turn
argument-hint: '<job-id> [--interrupt] [--prompt-file <path>] [message]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" message "$ARGUMENTS"`

Return the command output unchanged. Accepted means queued for the next model request, not proof that Codex has followed the instruction. `--interrupt` cancels the current turn and continues the same job and thread with the new message, retaining existing file changes and the task's original write permissions. It does not roll back files. For a pending structured question, use `/codex:answer` instead.
