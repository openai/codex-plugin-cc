---
description: Send a task directly to Doubao (general Chinese coding)
argument-hint: '[--profile <profile>] [--] <task prompt>'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cn-companion.mjs" task --model doubao --dangerously-skip-permissions $ARGUMENTS
```

Return the output verbatim. Do not paraphrase or add commentary.
If the model is unavailable, direct the user to `/cn:setup`.
