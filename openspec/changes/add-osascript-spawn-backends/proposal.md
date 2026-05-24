## Why

The 1.3.0 MVP made `/codex:observe` auto-launch a live observer inside a tmux split, but only for users already running tmux. Many developers on macOS use Ghostty or iTerm2 as their daily terminal without tmux, and they still see the old "copy this command into a new terminal" hint. Both terminals expose a rich AppleScript dictionary that supports programmatic splits, so we can give those users the same one-keystroke experience.

## What Changes

- Extend `spawner.mjs` from a single tmux branch into a small strategy table mapping detected terminal kind → backend implementation.
- Add a `ghostty-mac` backend that drives Ghostty via `osascript` (split current terminal direction right, paste the observer command).
- Add an `iterm2-mac` backend that drives iTerm2 via `osascript` (split current session vertically, write the observer command).
- Update terminal detection to recognize `$TERM_PROGRAM=ghostty` and `$TERM_PROGRAM=iTerm.app` (only when `process.platform === 'darwin'`).
- Define detection precedence so users running tmux *inside* Ghostty/iTerm2 still get the tmux split (the multiplexer wins).
- Update the success and fallback messages in `handleObserveSpawn` to name the actual backend used.
- Add unit tests mirroring the existing tmux pattern (env + runner injection, AppleScript string assertion).

Out of scope (deferred to later changes): Linux Ghostty `+new-window` mode, WezTerm `wezterm cli`, kitty remote-control, Terminal.app, generic xdg-terminal-exec.

## Capabilities

### New Capabilities
- `observer-spawner`: Terminal-detection + split-launch contract for `/codex:observe --spawn`. Defines the supported backends (tmux, ghostty-mac, iterm2-mac), the detection precedence, and the fallback behavior when no supported terminal is found. Backfills the contract for the 1.3.0 tmux MVP while adding the two new backends.

### Modified Capabilities

(none — the existing `observe-command` capability is unchanged; only the launcher path changes.)

## Impact

- **Modified files**: `plugins/codex/scripts/lib/spawner.mjs` (refactor to strategy table), `plugins/codex/scripts/lib/observe.mjs` (message tweaks), `tests/spawner.test.mjs` (extend coverage).
- **New files**: none expected; backends live as small builders inside `spawner.mjs`.
- **Dependencies**: none (uses `osascript` which is part of macOS).
- **Breaking changes**: none. Tmux users see identical behavior. Non-tmux users on macOS+Ghostty/iTerm2 now get auto-split instead of the copy-paste hint; the copy-paste hint remains as the final fallback.
- **Verification**: unit tests for the new backends, plus manual smoke on a real macOS box for both Ghostty and iTerm2 (AppleScript escaping is the main risk).
