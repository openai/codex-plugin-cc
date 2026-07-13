# Changelog

## Unreleased

- Stop an orphaned shared Codex app-server broker after 15 minutes with no connected clients. Active foreground and background jobs keep their broker connection open, and the timeout can be configured with `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` (`0` disables the safety timer).
- Close the broker listener before asynchronous child cleanup and safely reject reconnects already queued during shutdown.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
