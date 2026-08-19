# Changelog

## Unreleased

- Hardened background supervision: queue records are published before spawn, and queued or running jobs with missing/dead workers are reconciled to failure.
- Added immutable startup, admission, terminal, and removal claims so late workers cannot resurrect jobs or execute duplicates.
- Stop-gate reviews now single-flight per exact Claude turn, reuse the same-turn result, and fail closed for unavailable or corrupt persistence.
- Made mutable state and job JSON writes atomic, and serialized state mutations behind a bounded crash-recovering workspace lock.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
