#!/bin/bash
# SessionStart hook: export session ID and plugin data dir to CLAUDE_ENV_FILE.
# Replaces the Node.js session-lifecycle-hook.mjs for the SessionStart path
# to avoid ~100ms V8 startup overhead on every session.

set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

[ -z "${CLAUDE_ENV_FILE:-}" ] && exit 0

shell_escape() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\"\\'\"'/g")"
}

if [ -n "$SESSION_ID" ]; then
  printf 'export CODEX_COMPANION_SESSION_ID=%s\n' "$(shell_escape "$SESSION_ID")" >> "$CLAUDE_ENV_FILE"
fi

if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  printf 'export CLAUDE_PLUGIN_DATA=%s\n' "$(shell_escape "$CLAUDE_PLUGIN_DATA")" >> "$CLAUDE_ENV_FILE"
fi

exit 0
