---
description: Attach to a running Codex job and stream its live log output until it completes
argument-hint: '[job-id] [--poll-interval-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" attach "$ARGUMENTS"`

Present the command output verbatim to the user. Do not summarize or condense it.

If no active job is found, tell the user to start one with `/codex:rescue`.
If a job ID was not specified, the command automatically attaches to the most recent active job.
