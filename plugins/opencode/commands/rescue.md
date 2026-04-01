---
description: Delegate investigation, fix request, or follow-up work to OpenCode
argument-hint: "[--background|--wait] [--resume|--fresh] [--session <id>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `opencode:opencode-rescue` subagent.
The final user-visible response must be OpenCode's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `opencode:opencode-rescue` subagent in the background.
- If the request includes `--wait`, run the `opencode:opencode-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting OpenCode, check for a resumable session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current OpenCode session or start a new one.
- The two choices must be:
  - `Continue current OpenCode session`
  - `Start a new OpenCode session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode session (Recommended)` first.
- Otherwise put `Start a new OpenCode session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...` and return that command's stdout as-is.
- Return the OpenCode companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do follow-up work of its own.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
- If the user did not supply a request, ask what OpenCode should investigate or fix.
