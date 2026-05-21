# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-05-20

### Changed

- **Flattened plugin structure** — moved all plugin content (`commands/`, `hooks/`, `agents/`, `skills/`, `prompts/`, `schemas/`, `scripts/`) from `plugins/codex/` to the repo root. This fixes the Claude Code marketplace installer not discovering slash commands due to the `source` field in `marketplace.json` not being honored.

## [1.2.0] - 2026-05-20

### Added

- **Pre-push git hook** — validates CHANGELOG, version bump, and README consistency before pushing
  - Blocks push if plugin source changed without version bump
  - Blocks push if version bumped without matching CHANGELOG entry
  - Warns if version bumped without README update
  - Auto-detects suggested bump type (major / minor / patch) from changed files and commit messages
  - Install: `npm run setup-hooks` | Bypass: `git push --no-verify`

### Fixed

- **Broker process leak** — stale broker processes were never killed, accumulating hundreds of orphans
  - `ensureBrokerSession` now defaults `killProcess` to `terminateProcessTree` so stale brokers are actually terminated
  - Broker auto-exits after 5 seconds of idle (no connected clients)
- **marketplace.json version sync** — `.claude-plugin/marketplace.json` was accidentally gitignored, causing version to silently fall behind. Now properly tracked with `.claude-plugin/*` + `!.claude-plugin/marketplace.json` pattern

## [1.1.0] - 2026-05-20

### Added

- **`/codex:observe`** — Real-time live observer for Codex tasks with ANSI color output
  - Watch tool calls, file changes, commands, messages, and reasoning as they happen
  - Color-coded output: cyan (tools), blue (commands), green (success), red (failure), yellow (file changes)
  - Read-only mode — observer never affects the running Codex task
  - `Ctrl+C` to detach without stopping the Codex task
  - Works in a separate terminal window alongside your Claude Code session
  - Automatically renders full history for completed jobs
- **JSONL event stream** — Structured event logging (`.events.jsonl`) for each job
  - Append-only format for safe concurrent reads
  - Integrated with existing progress reporter pipeline
  - Automatic cleanup with job pruning
- **26 unit tests** covering event stream writer and observer functionality

### Changed

- Job records now include `eventFile` field alongside `logFile`
- `createProgressReporter` accepts `eventStream` parameter for structured event emission

### Documentation

- Added `/codex:observe` usage examples and color legend to README
- Added Chinese translation for observer documentation

## [1.0.4] - 2026-05-20

### Added

- **`--worktree` flag** for `/codex:rescue` — Creates isolated git worktree for Codex work
  - Codex works in `.claude/worktrees/<jobId>/` on a separate branch
  - Leaves main working directory untouched
  - Mutually exclusive with `--resume`
- **`sandbox_mode` config** — Reads from `~/.codex/config.toml` or `.codex/config.toml`
  - Falls back to `workspace-write` (with `--write`) or `read-only`

### Fixed

- Thread exclusivity warning — Users cannot manually `codex resume` an active thread
- Signal file + Monitor/PushNotification callback for background tasks
- Route `/codex:rescue` through Agent tool to stop Skill recursion

### Documentation

- Added Chinese README (`README.zh-CN.md`)
- Documented `--worktree` and sandbox_mode configuration

[1.2.0]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.0.3...v1.0.4
