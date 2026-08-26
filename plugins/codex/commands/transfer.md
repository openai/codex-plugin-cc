---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Transfer the current Claude Code session into a resumable Codex thread by running the Bash command below, then present the output to the user.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer "$ARGUMENTS"
```

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.
