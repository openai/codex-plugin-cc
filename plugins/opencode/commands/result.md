---
description: Retrieve the result of a finished OpenCode job
argument-hint: "[job-id] [--json]"
allowed-tools: Bash(node:*)
---

Run the following command and return its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result $ARGUMENTS
```

Do not paraphrase or summarize the output.
