---
description: Enable or disable automatic Codex lint passes after every file Claude writes
argument-hint: '[--enable|--disable|--status]'
allowed-tools: Bash(node:*)
---

Toggle or check the Codex file-watch linter.

When enabled, a lightweight Codex lint pass is automatically queued in the background every time Claude writes or edits a file in this session. Results appear via `/codex:status` and `/codex:result`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" watch $ARGUMENTS
```

Output rules:
- Present the result directly to the user.
- If watch was enabled, remind them it adds background Codex jobs after every file write and they can check progress with `/codex:status`.
- If watch was disabled, confirm it is off.
- If no flag was given (status check), show whether watch is currently on or off.
