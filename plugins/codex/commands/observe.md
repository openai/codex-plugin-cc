---
description: Observe a Codex job's live event stream in real-time (read-only)
argument-hint: '[job-id] [--cwd <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

To observe a Codex job's live output, open a **new terminal window** and run:

```bash
cd <your-project-directory>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe $ARGUMENTS
```

**What you'll see:**
- Real-time event stream with ANSI colors (tool calls, file changes, commands, messages)
- Phase indicators showing Codex's progress (starting → investigating → finalizing → completed)
- Live updates as events happen

**Controls:**
- `Ctrl+C` to exit the observer (Codex task continues running)
- Observer exits automatically when the task completes

**Examples:**
```bash
# Observe the latest running job
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe

# Observe a specific job
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe task-abc123

# Observe with custom workspace
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe --cwd /path/to/project
```

**Note:** This command is designed to be run in a separate terminal for live observation. The slash command here shows you the exact command to copy-paste into your new terminal window.
