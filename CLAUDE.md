# Development guidance

Keep user-facing transfer instructions and recovery guidance in [README.md](README.md#codextransfer).

When changing session transfer, verify that the command returns the thread containing the imported history and that this thread can be resumed. Exercise the command-level regressions, including transcript growth before and after the native read, repeat imports, and failure handling. An import-completed notification alone does not prove that the returned thread is usable.

Use the test and build scripts defined in [package.json](package.json). When running tests from an active Claude Code session, clear inherited `CLAUDE_PLUGIN_DATA`, `CODEX_COMPANION_SESSION_ID`, and `CODEX_COMPANION_TRANSCRIPT_PATH` from the test process; they otherwise change fixture storage or job selection. Keep the live Claude session's environment intact.
