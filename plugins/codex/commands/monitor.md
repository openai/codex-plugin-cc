---
description: Start a background Codex session that builds project context for this Claude Code session
argument-hint: "[--resume | --resume-session <id|number>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Start a background Codex monitor for this session.

Raw slash-command arguments:
`$ARGUMENTS`

---

## No flags — always start fresh immediately, no questions

If `$ARGUMENTS` contains no `--resume` or `--resume-session` flag:
```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" monitor $ARGUMENTS
```
Return stdout verbatim. Stop here — do not check sessions, do not ask anything.

---

## `--resume` or `--resume-session` flag present — check sessions first

Extract any runtime flags from `$ARGUMENTS` to forward (everything except `--resume` and `--resume-session <value>`):
- `--model <value>` if present → append `--model <value>` to every command below
- `--effort <value>` if present → append `--effort <value>` to every command below

Run:
```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" monitor --list-sessions --json
```

Parse `sessions` from the JSON output.

**0 sessions** — no history yet, start fresh:
```bash

CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" monitor [--model <value>] [--effort <value>]
```

**1 session** — auto-resume it, no question needed:
```bash

CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" monitor --resume-session <that-session-id> [--model <value>] [--effort <value>]
```

**2+ sessions** — use `AskUserQuestion` exactly once. Options:
- One option per session:
  - label: `<startedAt date> — <turnCount> turns` — append `[active]` if it is the active session and mark it `(Recommended)`, list it first.
  - description: use the session's `lastSummary` field verbatim if present, otherwise `"No summary available"`.
- Last option always: label `Start a fresh session`, description `"Begin a new context."`

After the user picks:

- Fresh → run without resume flags (but keep `--model`/`--effort` if supplied)
- A session → run with `--resume-session <chosen-id>` (and keep `--model`/`--effort` if supplied)

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" monitor --resume-session <chosen-id> [--model <value>] [--effort <value>]
```

Return stdout verbatim.

---

## Operating rules
- Do not paraphrase, summarize, or add commentary around the monitor output.
- Do not wait for the monitor job to complete — it runs entirely in the background.
- If Codex is not installed or unauthenticated, tell the user to run `/codex:setup`.
