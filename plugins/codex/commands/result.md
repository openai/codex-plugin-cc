---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

!`bash "$(if command -v cygpath >/dev/null 2>&1; then cygpath -u "${CLAUDE_PLUGIN_ROOT}"; else printf '%s' "${CLAUDE_PLUGIN_ROOT}"; fi)/scripts/run-node.sh" "codex-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`
