---
description: Check availability of all Chinese model backends
argument-hint: '[--json] [--doctor]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cn-companion.mjs" setup $ARGUMENTS
```

Present the output to the user. If any models are unavailable, suggest checking `~/bin/cc-*` scripts and API key environment variables. Use `--doctor` when the user wants the deeper wrapper health check.
