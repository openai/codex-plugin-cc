---
description: Configure agent models — switch between Claude and OpenAI models
allowed-tools: Bash(node:*)
---

Run the interactive TUI directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-config-tui.mjs"
```

After the TUI exits, read the applied changes from stdout and summarize them to the user.
