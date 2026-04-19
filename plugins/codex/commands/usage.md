---
description: Show Codex rate limits and account plan for the current account
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" usage $ARGUMENTS`

Present the output as a compact status display.
If there is an auth error, tell the user to run `!codex login`.
