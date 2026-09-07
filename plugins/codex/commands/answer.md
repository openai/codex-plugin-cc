---
description: Answer a pending Codex question without restarting its task or thread
argument-hint: '<job-id> --request-id <id> --answers-file <path>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" answer "$ARGUMENTS"`

Return the command output unchanged. Use the request ID and question IDs shown by `/codex:status <job-id>`. The JSON file contains the answers map, for example `{"source":{"answers":["Use the latest plan from the plan center."]}}`. Preserve the user's answer; do not invent consent or answer permission requests on the user's behalf. Stale or already answered requests are rejected.
