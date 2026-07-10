# Changelog

## 1.1.6 - 2026-07-10

### Added

- Fable-owned GPT-5.6 routing for fresh rescue tasks.
- Model-neutral Codex prompt shaping.
- Read-only `codex-reviewer` agent.
- Exact `task --resume-id <thread-id>` support.

### Fixed

- Removed unsupported hook manifest metadata.
- Isolated test state from live Claude Code sessions.

### Compatibility

- Based on upstream `openai/codex-plugin-cc` v1.0.6 at `db52e28`.
- Preserves upstream runtime and state-format compatibility while deliberately using the `codex-relay` plugin identity and `/codex-relay:*` commands; retains the Apache-2.0 license.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
