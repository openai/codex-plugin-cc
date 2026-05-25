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

- If the request includes `--background`, pass `--background` to the `codex:codex-rescue` subagent so it invokes companion `task --background`.
- If the request includes `--wait`, pass `--wait` to the `codex:codex-rescue` subagent so it invokes foreground `task`.
- If neither flag is present, default to `--background` (the safe path: the worker daemonizes and survives; collect the result via `/codex:status` + `/codex:result`). Only stay foreground when `--wait` is explicit AND the rescue is short and clearly bounded.
- For long, substantial, or open-ended rescues, pass `--background`; the companion returns `[[codex-task status=dispatched id=<jobId>]]`. A dispatched background job has no automatic push notification, so arm a watcher by running `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status <jobId> --wait --timeout-ms 1800000` via the Bash tool with `run_in_background=true`; it exits and re-invokes Claude when the job reaches a terminal status. If it returns while the job is still running, re-arm the same command. Fetch `/codex:result <jobId>` only after the watcher reports a terminal status.
- A foreground rescue running inside the subagent is auto-backgrounded by the harness and then reaped when the subagent ends (observed at ~143s — much sooner than the ~600s direct-Bash cap), which kills the Codex worker mid-run and loses the result. Route anything substantial to `--background`.
- `--background` and `--wait` are execution flags for Claude Code and the rescue subagent. Preserve the execution choice, and strip them only from the natural-language task text before Codex sees the prompt.
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

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- The companion stdout carries a deterministic sentinel on a standalone line: `[[codex-task status=complete]]` means a foreground task has completed and exited; `[[codex-task status=dispatched id=<jobId>]]` means a companion background job was queued. Trust this sentinel, companion state, and the PostToolUse hook over any prose. A dispatched sentinel is not an automatic-notification promise; never treat a dispatched/background job as done until `codex-companion.mjs status <jobId> --wait` returns a terminal status from a Bash watcher launched with `run_in_background=true`.
- The Claude Code harness appends an `agentId: <id> (use SendMessage with to: '<id>' to continue this agent)` line to every `Agent(codex:codex-rescue)` return. This is a resume token for continuing the same agent thread, NOT a "still running" or "in background" status signal. By the time you see it, the subagent has finished. Do not paraphrase it as "Codex is running in background" or "task dispatched async" — the stdout above the suffix is the actual completed output, which you return verbatim per the rule above.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Workspace boundary:

- A Codex `task` run can only create or modify files **within its working directory** (the Codex `workspace-write` sandbox is rooted at the run's `--cwd`). Files outside that directory are read-only.
- The `Agent`-tool `codex:codex-rescue` dispatch inherits **this Claude session's** cwd, and the `Agent` tool cannot change it. So a rescue request that needs to write to a *different* repository will silently fail to write (Codex can only probe, not edit) — do not route cross-repo write work through the subagent.
- To target a different repository, either run from a Claude session inside that repo, or invoke the companion directly with `--cwd <target-repo>`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --cwd <target-repo> --write ...`.
