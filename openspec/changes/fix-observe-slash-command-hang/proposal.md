## Why

Running `/codex:observe` inside Claude Code currently produces **no visible output at all** — neither the "open a new terminal" guidance text nor any event stream. The root cause: `observe.md` contains an inline `!exec` fallback (line 40) that invokes the long-running live tail (`handleObserveCommand`'s `await new Promise(...)` only resolves on `COMPLETED` event or SIGINT). Claude Code's `!exec` model captures full stdout after the process exits — a never-returning process therefore gates the entire slash-command body, including the 36 lines of guidance prose that precede it. The author added the inline `!exec` as a "if you want inline" fallback, but inline live-tail is structurally incompatible with the slash-command exec model, and the broken fallback reaches back and suffocates the primary path.

## What Changes

- Remove the inline `!exec` fallback block from `plugins/codex/commands/observe.md`:
  - Delete lines 38–40 ("If you want to see the output inline instead, you can run:" + the `!`-prefixed exec line)
  - Delete lines 42–48 (the "Present the command output to the user…" model-facing instructions, which become orphaned once there is no exec output to present)
- The slash command body becomes a **pure static guidance document**: it tells the user to open a new terminal and shows the copy-paste command, with no inline execution path
- The `observe` subcommand in `codex-companion.mjs` is **unchanged** — direct CLI invocation (`node codex-companion.mjs observe …`) keeps working exactly as today
- No behavior change to `observe.mjs`, event stream, hooks, or any other plugin component

## Capabilities

### New Capabilities

- `observe-slash-command`: Contract for the `/codex:observe` slash-command wrapper as exposed inside Claude Code — distinct from the underlying CLI `observe` subcommand. Specifies that the slash command body MUST be non-blocking static guidance and MUST NOT contain inline executions of long-running processes, since Claude Code's slash-exec model buffers stdout until process exit.

### Modified Capabilities

(none — the `observe-command` capability for the CLI subcommand lives in the still-active `codex-live-observer` change and is not touched here)

## Impact

- **Affected code**: `plugins/codex/commands/observe.md` only (1 file, deletions only — no logic changes)
- **Affected docs**: None. `README.md` and `README.zh-CN.md` already describe the "open a new terminal" workflow as the primary usage; nothing to update.
- **Affected tests**: None. There are no tests on `observe.md` rendering. `tests/observe.test.mjs` covers the CLI behavior (event reading + rendering), which is unchanged.
- **User-visible behavior**:
  - Before: `/codex:observe` produces no output (slash command hangs on inline exec)
  - After: `/codex:observe` immediately renders guidance text with a copy-paste command for a new terminal — matching the original design intent
- **Backwards compatibility**: Users who somehow relied on the broken inline path (which never worked for live jobs) lose nothing — that path was non-functional. The CLI path (`node codex-companion.mjs observe`) is unaffected.
- **No dependencies, APIs, or external contracts touched.**
