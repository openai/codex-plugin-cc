---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration/dispatch.mjs" cancel "$ARGUMENTS"`


The reference may identify a legacy job, an entire orchestration, or one package.
