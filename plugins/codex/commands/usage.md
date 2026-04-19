---
description: Show Codex rate limits and usage for your current plan
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" usage $ARGUMENTS`

Present the command output to the user as-is. Do not summarize or condense it.
