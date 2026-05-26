---
description: Hand off the current session to Codex — pick a monitor session, write a shift package, and open a new Codex terminal
argument-hint: ""
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Hand off to Codex.

## Step 1 — check for sessions

Run:
```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" shift --list-sessions --json
```

Parse `sessions` from the JSON output.

**0 sessions** — nothing to shift. Tell the user:
> No monitor sessions found for this project. Run `/codex:monitor` first to start recording context.

Stop here.

**1 session** — auto-select it, no question needed:
```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" shift --session <that-session-id> --launch
```

**2+ sessions** — use `AskUserQuestion` exactly once. Options:
- One option per session:
  - label: `<startedAt date> — <turnCount> turns` — if `active === true`, append `[active]` and mark it `(Recommended)`, list it first.
  - description: use the session's `lastSummary` field verbatim if present, otherwise `"No summary available"`.
- Last option always: label `All sessions`, description `"Merge context from every session for this directory"`.

After the user picks:
- A specific session → run with `--session <chosen-id> --launch`
- All sessions → run without `--session` but with `--launch`

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" shift --session <chosen-id> --launch
# or, for "All sessions":
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" shift --launch
```

Return stdout verbatim.

---

## Operating rules
- Do not paraphrase, summarize, or add commentary before or after the output.
- If Codex is not installed or unauthenticated, tell the user to run `/codex:setup`.
