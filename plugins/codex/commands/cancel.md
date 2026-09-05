---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

!`bash "$(if command -v cygpath >/dev/null 2>&1; then cygpath -u "${CLAUDE_PLUGIN_ROOT}"; else printf '%s' "${CLAUDE_PLUGIN_ROOT}"; fi)/scripts/run-node.sh" "codex-companion.mjs" cancel "$ARGUMENTS"`
