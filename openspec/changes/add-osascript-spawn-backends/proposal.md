## Why

The 1.3.0 MVP made `/codex:observe` auto-launch a live observer inside a tmux split, but only for users already running tmux. Many developers on macOS use Ghostty or iTerm2 as their daily terminal without tmux, and they still see the old "copy this command into a new terminal" hint. Both terminals expose a rich AppleScript dictionary that supports programmatic splits, so we can give those users the same one-keystroke experience.

## What Changes

- Extend `spawner.mjs` from a single tmux branch into a small strategy table mapping detected terminal kind → backend implementation.
- Add a `ghostty-mac` backend that drives Ghostty via `osascript`. It MUST target the terminal that owns the calling shell's tty when discoverable, and fall back to opening a new Ghostty window — never silently split a random front window.
- Add an `iterm2-mac` backend with the same tty-match-or-new-window contract for iTerm2.
- Update terminal detection to recognize `$TERM_PROGRAM=ghostty` and `$TERM_PROGRAM=iTerm.app` (only when `process.platform === 'darwin'`).
- Define detection precedence so users running tmux *inside* Ghostty/iTerm2 still get the tmux split (the multiplexer wins).
- Introduce a **two-layer quoting contract** for osascript backends: shell-quote `cwd` and `command` first (re-using the existing `shellQuote` helper to compose `cd <cwd> && <command>`), then AppleScript-escape the resulting string for the `"..."` literal. AppleScript escaping alone is not shell-safe.
- Reject unsafe characters in the composed command (embedded newlines, NUL, other control chars) before building AppleScript — return a structured `spawned: false, error: 'unsafe-command'` instead of silently producing a broken script.
- Add a dedicated **Automation-permission UX**: when osascript fails with the macOS "not authorized" pattern, show a one-line "grant access and retry" message instead of the generic red error + copy-paste fallback (retry will work once permission is granted).
- Update the success and fallback messages in `handleObserveSpawn` to name the actual backend used.
- Add unit tests mirroring the existing tmux pattern (env + runner injection, AppleScript string assertion) plus new coverage for: cwd with spaces / single-quotes / unicode, control-char rejection, tty-match-vs-new-window dispatch, permission-denied messaging.

Out of scope (deferred to later changes): Linux Ghostty `+new-window` mode, WezTerm `wezterm cli`, kitty remote-control, Terminal.app, generic xdg-terminal-exec.

## Capabilities

### New Capabilities
- `observer-spawner`: Terminal-detection + split-launch contract for `/codex:observe --spawn`. Defines the supported backends (tmux, ghostty-mac, iterm2-mac), the detection precedence, and the fallback behavior when no supported terminal is found. Backfills the contract for the 1.3.0 tmux MVP while adding the two new backends.

### Modified Capabilities

(none — the existing `observe-command` capability is unchanged; only the launcher path changes.)

## Impact

- **Modified files**: `plugins/codex/scripts/lib/spawner.mjs` (refactor to strategy table, add tty-discovery helper, two-layer quoting, control-char guard, permission-denied detection), `plugins/codex/scripts/lib/observe.mjs` (per-kind success/failure messages, dedicated permission-denied path), `tests/spawner.test.mjs` (extend coverage).
- **New files**: none expected; backends, tty discovery, and quoting helpers live as small modules inside `spawner.mjs`.
- **Dependencies**: none (uses `osascript` and POSIX `ps`/`tty`, all available on macOS).
- **Breaking changes**: none. Tmux users see identical behavior. Non-tmux users on macOS+Ghostty/iTerm2 now get tty-targeted splits or new-window fallback instead of the copy-paste hint; the copy-paste hint remains as the final fallback for unsupported terminals.
- **Verification**: unit tests for the new backends and helpers (cwd quoting, control-char rejection, tty-match dispatch, permission-denied), plus manual smoke on a real macOS box for both Ghostty and iTerm2 — explicitly covering (a) first-run Automation permission prompt, (b) a project path containing spaces, (c) invocation from a non-frontmost window.
