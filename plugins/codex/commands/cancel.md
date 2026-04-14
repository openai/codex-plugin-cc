---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

Only cancel a job when the user has explicitly asked to cancel or stop it. Do not cancel jobs on your own initiative.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`
