---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--stall-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

`--wait` returns early when the job has a pending question. This is not task completion: show the questions and answer with `/codex:answer`, then wait for the same job again. Live details distinguish accepted-but-unconsumed messages, pending questions, interruption, and observed file changes. Unavailable live state must not be presented as an empty queue.

`--wait` also returns early when Codex sends a notification; this is not task completion, so wait for the same job again. Returned notifications are acknowledged and will not trigger the next wait; plain status leaves them pending.

For a Claude Code Monitor, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" events --cwd <repo> [--poll-ms <ms>] [--stall-ms <ms>]` (poll default: 2000 ms). It watches this workspace's current-session jobs until SIGINT or SIGTERM, printing each transition once:

```text
DONE job=<job-id> thread=<thread-id>
FAILED job=<job-id> thread=<thread-id> <first error line, or unknown>
QUESTION job=<job-id> request=<request-id> <first question, one line, at most 200 characters>
NOTIFIED job=<job-id> thread=<thread-id> <message with newlines replaced by spaces>
STALLED job=<job-id> thread=<thread-id> <minutes>m without progress
```

Jobs already finished when monitoring starts are omitted. Printed notifications are acknowledged, so `status --wait` will not return them again. A missing thread ID is printed as `unknown`. Both commands fail active jobs when their recorded owner has exited, or their broker is unreachable for three consecutive polls.

`--stall-ms` defaults to 900000 (15 minutes) for both `events` and `status --wait`. With no new progress log entry for this interval, `events` emits `STALLED` at most once per interval, and `status --wait --json` returns early with `stalled: true`; neither marks the job failed. Running job status shows owner liveness and minutes since last progress.

Task status and stored results show the sandbox mode and effective network access. `task --sandbox <read-only|workspace-write|danger-full-access>` overrides `--write`; `danger-full-access` permits writes and network access. `--network` enables network access for `workspace-write`. Defaults remain read-only, or workspace-write without network when `--write` is given.

The shared broker supports concurrent task threads. It shuts down after 10 minutes with no connected clients or owned streams (`app-server-broker.mjs serve --idle-timeout-ms <ms>` overrides this); the next task starts a fresh broker automatically.
