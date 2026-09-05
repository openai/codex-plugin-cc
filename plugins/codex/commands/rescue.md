---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution controls, not natural-language task text. `--background` selects the subagent's durable detached-task protocol; `--wait` selects the attached foreground-task protocol.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is transport-only. The Agent itself is the only layer allowed to be backgrounded; inside the subagent, never set Bash `run_in_background`.
- A background rescue must use a durable `task --background --json` launch, capture its `jobId`, wait in bounded foreground calls with `status "$jobId" --wait --timeout-ms 60000 --json`, then return the stdout of `result "$jobId" --raw` exactly as-is.
- If the waiting subagent is interrupted after a background `jobId` exists, do not cancel the detached job; it remains authoritative and recoverable through `/codex:status` and `/codex:result` until it finishes or the user explicitly runs `/codex:cancel`.
- A foreground rescue uses one foreground Bash call to `task` without `--background` and returns that stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, solve the task, call user-facing `/codex:status` / `/codex:result` / `/codex:cancel`, or summarize Codex output. The direct runtime `status` / `result` calls above are allowed only for its own background job.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
