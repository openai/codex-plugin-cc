## ADDED Requirements

### Requirement: Static guidance body

The `/codex:observe` slash command body in `plugins/codex/commands/observe.md` SHALL consist exclusively of non-executable static guidance content. It SHALL NOT contain any inline shell-execution blocks (Claude Code `` !`...` `` syntax) that invoke long-running processes.

#### Scenario: User invokes /codex:observe with no arguments
- **WHEN** the user types `/codex:observe` in Claude Code
- **THEN** the slash command SHALL render its guidance text immediately without blocking on any subprocess
- **THEN** the rendered text SHALL include a copy-paste command instructing the user to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe` in a separate terminal

#### Scenario: User invokes /codex:observe with arguments
- **WHEN** the user types `/codex:observe <job-id>` or `/codex:observe --cwd <path>`
- **THEN** the slash command SHALL render the same guidance text without blocking
- **THEN** the rendered command snippet SHALL include `$ARGUMENTS` so the user's arguments appear in the copy-paste line

#### Scenario: Body contains no inline exec blocks
- **WHEN** the contents of `plugins/codex/commands/observe.md` are inspected
- **THEN** no line in the body SHALL begin with `` !` `` (Claude Code inline shell-exec marker)
- **THEN** all `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe …` references SHALL appear inside fenced code blocks intended for the user to copy, not as Claude Code exec directives

### Requirement: New-terminal usage instructions

The slash command body SHALL clearly direct the user to open a new terminal window before running the observer, because the live tail uses ANSI cursor-control rendering and runs indefinitely until the underlying Codex job completes or the user sends `SIGINT`.

#### Scenario: Guidance mentions a new terminal
- **WHEN** the slash command body is rendered
- **THEN** it SHALL contain explicit wording instructing the user to open a new terminal window
- **THEN** it SHALL describe `Ctrl+C` as the way to detach the observer
- **THEN** it SHALL state that detaching does not affect the running Codex task

#### Scenario: Examples cover the common invocations
- **WHEN** the slash command body is rendered
- **THEN** it SHALL include at least one example each for:
  - observing the latest running job (no positional argument)
  - observing a specific job by ID
  - observing with a custom `--cwd`

### Requirement: CLI subcommand untouched

This change SHALL NOT modify the behavior of the `observe` subcommand in `plugins/codex/scripts/codex-companion.mjs` nor any code in `plugins/codex/scripts/lib/observe.mjs`. All requirements declared by the `observe-command` capability (from the `codex-live-observer` change) SHALL continue to hold unchanged.

#### Scenario: Direct CLI invocation still works
- **WHEN** a user runs `node plugins/codex/scripts/codex-companion.mjs observe` in a terminal
- **THEN** the observer SHALL behave exactly as specified by the `observe-command` capability — live tail with ANSI rendering, SIGINT detach, completion on COMPLETED event

#### Scenario: Existing observer tests pass
- **WHEN** `npm test` is run after this change
- **THEN** `tests/observe.test.mjs` SHALL pass without modification
- **THEN** no other test SHALL regress

### Requirement: Slash-command structural rule for long-running processes

No slash command body in `plugins/codex/commands/*.md` SHALL contain a Claude Code inline shell-exec block (`` !`...` ``) that invokes a process which does not terminate in bounded time. Claude Code's slash-exec model buffers stdout until the child process exits, so blocking on a long-running process gates the entire body from rendering.

#### Scenario: Long-running subprocess belongs in a code block, not an exec block
- **WHEN** a slash command needs to expose a long-running process (live tail, watcher, daemon) to the user
- **THEN** the command's invocation SHALL be presented inside a fenced code block as copy-paste guidance for the user to run in their own terminal
- **THEN** the slash command SHALL NOT attempt to invoke it via `` !`...` `` inline exec

#### Scenario: One-shot subprocesses may use inline exec
- **WHEN** a slash command needs to invoke a subprocess that reads state, performs a single action, and exits promptly (e.g., `cancel`, `result`, `status`)
- **THEN** the command MAY use Claude Code inline exec (`` !`...` ``) to surface that output directly in the conversation
