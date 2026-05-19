# Changelog

## 1.1.0

Observability rework for the main-loop orchestration case: the consumer of
"what is codex doing right now" is the calling Claude session, not a human
dashboard. Adds a per-job NDJSON event stream the main loop can poll, plus
a protocol-native recovery path for context overflow.

- `/codex:events <job-id>`: new slash command. Streams normalized codex
  notifications from `{stateDir}/jobs/{jobId}.events.ndjson`. Supports
  `--since <iso>` / `--after-seq <n>` / `--limit <n>` / `--json` for
  incremental polling. Each event carries `seq`, `ts`, `method`, `phase`,
  `itemType`, `message`, and the raw payload.
- `/codex:compact <thread-id>`: new slash command wrapping codex
  app-server's `thread/compact/start`. Protocol-native recovery for
  "prompt too long" — typical flow is cancel → compact → resume with an
  amended prompt via `/codex:rescue --resume`.
- `/codex:rescue` now defaults to `--background`. The main Claude loop
  receives a job id immediately and polls `/codex:events` instead of
  blocking on a synchronous Bash call; this removes the deadlock when
  codex stalls or errors silently.
- Per-job stall watchdog (60s default, override via
  `CODEX_COMPANION_STALL_SECONDS`) emits a `{type:"watchdog",
  phase:"stuck"}` event when codex produces no new notifications inside
  the window. The watchdog never cancels — the main loop decides whether
  to continue, compact, or cancel.
- New `{type:"job/exited"}` terminal event with `phase: completed|failed`
  and `exitCode`. This is the single source of truth for end-of-job;
  callers should not infer terminal state from job-level `status` alone.
- Surfaces token usage as a top-level field on `runAppServerTurn` and
  streams real-time usage via `thread/tokenUsage/updated` events
  (`phase: "metering"`).
- Coverage of codex CLI 0.131 notification methods extended to
  `thread/status/changed`, `warning`, `thread/tokenUsage/updated`, plus
  item types `userMessage`, `assistantMessage`/`agentMessage`, and
  `reasoning`. The `agentMessage` item now surfaces a content preview so
  the main loop can recognize codex's final reply from the event stream
  without fetching `/codex:result`.
- Test isolation: `tests/helpers.mjs` now unsets `CLAUDE_PLUGIN_DATA` and
  `CODEX_COMPANION_SESSION_ID` at module load. Plugin host runtimes (e.g.
  Claude Code) inject these vars; without isolation, two existing tests
  fail when contributors run `npm test` from inside a host.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
