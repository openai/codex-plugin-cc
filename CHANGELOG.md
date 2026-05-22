# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.4] - 2026-05-22

### Fixed

- **`/codex:observe` slash command produced no output in Claude Code** — removed the inline `` !`...` `` shell-exec fallback from `plugins/codex/commands/observe.md`. The fallback invoked the long-running live tail (`handleObserveCommand` waits indefinitely for `COMPLETED` or `SIGINT`), and because Claude Code's slash-exec model buffers stdout until the child process exits, a never-returning process gated the entire slash-command body — including the 36 lines of "open a new terminal" guidance that preceded it. Users typing `/codex:observe` saw nothing at all.
  - The slash command body is now a pure static guidance document: it tells the user to open a new terminal and shows the copy-paste `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe …` snippet. It renders immediately regardless of job state.
  - The CLI `observe` subcommand in `codex-companion.mjs` / `lib/observe.mjs` is **unchanged** — running `node codex-companion.mjs observe` in a terminal works exactly as before (live ANSI tail, `Ctrl+C` detach, completes on `COMPLETED` event).
  - Structural rule captured in `openspec/changes/fix-observe-slash-command-hang/specs/observe-slash-command/spec.md`: slash command bodies MUST NOT contain inline shell-exec blocks that invoke processes which do not terminate in bounded time. One-shot subprocesses (`/codex:cancel`, `/codex:result`, `/codex:status`) may continue to use inline exec.

## [1.2.3] - 2026-05-21

### Changed

- **Marketplace renamed `openai-codex` → `dragon-cc-codex`** to disambiguate this fork from the upstream OpenAI marketplace and avoid the name collision that would prevent a user from having both installed side by side.
  - `.claude-plugin/marketplace.json`: `name` field updated.
  - `README.md` / `README.zh-CN.md`: install instructions now point at `dragon84867/codex-plugin-cc` (fork repo) and `codex@dragon-cc-codex` (renamed marketplace).
  - **Migration for existing users**: run `/plugin marketplace remove openai-codex` once, then re-add via `/plugin marketplace add dragon84867/codex-plugin-cc` and `/plugin install codex@dragon-cc-codex`.

## [1.2.2] - 2026-05-21

### Fixed

- **Marketplace install failure** — restored the `plugins/codex/` subdirectory layout so the Claude Code marketplace installer can discover the plugin.
  - Reverts the flatten refactor (af88f38) and its follow-up `source: "./"` patch (cf2917c). The Claude Code marketplace spec requires `source` to point at a subdirectory of the marketplace repo (e.g. `./plugins/codex`); pointing it at the marketplace root itself is unsupported and caused installs to fail with "unsupported source type" / undiscoverable commands.
  - Plugin runtime, commands, hooks, agents, skills, prompts, schemas, and `.claude-plugin/plugin.json` are back under `plugins/codex/`. `marketplace.json` stays at the repo root and now points at `./plugins/codex` again, matching the OpenAI upstream layout.
- **Align with current codex protocol** — restoring the subdirectory layout also restored correct `.d.ts` relative imports for the generated app-server types, which had been silently broken by the flatten refactor (making TypeScript treat the imported types as `any` and skip checking). With type-check re-enabled, two long-standing protocol-drift bugs surfaced and are now fixed:
  - `app-server.mjs`: `DEFAULT_CAPABILITIES` now includes `requestAttestation: false`, matching the required `InitializeCapabilities` shape.
  - `codex.mjs`: removed the obsolete `experimentalRawEvents: false` field from `buildThreadParams`; it is no longer part of `ThreadStartParams` in the current codex protocol.
  - Runtime behavior is unchanged — codex's JSON-RPC tolerated the missing/extra fields, so existing installs continue to work. This change just unblocks `npm run build` / CI type-checking.

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

[1.2.3]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.2.0...v1.2.2
[1.2.0]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/dragon84867/codex-plugin-cc/compare/v1.0.3...v1.0.4
