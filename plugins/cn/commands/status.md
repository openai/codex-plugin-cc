---
description: Check status of Chinese model backends
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cn-companion.mjs" setup --json
```

Present a concise summary of which models are available and which are not, including profile hints when useful.
