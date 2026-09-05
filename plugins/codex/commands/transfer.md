---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

!`bash "$(if command -v cygpath >/dev/null 2>&1; then cygpath -u "${CLAUDE_PLUGIN_ROOT}"; else printf '%s' "${CLAUDE_PLUGIN_ROOT}"; fi)/scripts/run-node.sh" "codex-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.
