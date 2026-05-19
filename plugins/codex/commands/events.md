---
description: Stream Codex notifications as a per-job NDJSON event log for poll-based monitoring
argument-hint: '<job-id> [--since <iso>] [--after-seq <n>] [--limit <n>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" events "$ARGUMENTS"`

How to use the output:

- Each line in the stream is a normalized notification: `seq`, `ts`, `method`, `phase`, `itemType`, `message`, and `raw`.
- Treat `{type:"job/exited"}` as the single source of truth for terminal state — its `phase` is `completed` or `failed`, and `exitCode` reflects the codex turn outcome. Do not infer end-of-job from job-level `status` alone.
- `phase:"stuck"` records (emitted by the worker's stall watchdog) mean codex produced no new notifications for the configured stall window (default 60s, override with `CODEX_COMPANION_STALL_SECONDS`). The job is not cancelled — the main loop decides whether to keep waiting, run `/codex:compact <thread-id>` to recover from context overflow, or `/codex:cancel <job-id>` to abort.
- `phase:"warning"` records carry codex-side non-fatal conditions (context budget exceeded, capabilities removed). They are informational, not failures.
- `phase:"metering"` records come from `thread/tokenUsage/updated` and stream real-time token usage; poll them to detect "this turn is burning a lot of tokens" before hitting context overflow.
- Use `--after-seq <last-seq>` for incremental polling. If both `--after-seq` and `--since` are supplied, `--after-seq` wins. Default (no filter) returns all events for the job; the main loop is responsible for dedupe-by-seq.

Output format:

- Without `--json`: one human-readable line per event.
- With `--json`: `{jobId, eventsFile, count, events: [...]}`.

If no events exist yet for the job id, the command prints `No events yet for <job-id>.` and exits 0.
