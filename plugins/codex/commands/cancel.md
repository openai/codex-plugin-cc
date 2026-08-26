---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Cancel the requested background Codex job by running the Bash command below.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"
```
