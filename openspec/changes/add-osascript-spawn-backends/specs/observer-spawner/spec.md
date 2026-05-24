## ADDED Requirements

### Requirement: Terminal detection

The spawner SHALL inspect the process environment to determine whether a supported terminal multiplexer or emulator hosts the current shell, returning a tagged kind that the dispatcher uses to select a backend.

#### Scenario: tmux is detected when $TMUX is set

- **WHEN** `process.env.TMUX` is a non-empty string
- **THEN** detection returns `{ kind: 'tmux' }`

#### Scenario: ghostty-mac is detected on macOS Ghostty

- **WHEN** `process.platform === 'darwin'` AND `process.env.TERM_PROGRAM === 'ghostty'` AND `process.env.TMUX` is unset or empty
- **THEN** detection returns `{ kind: 'ghostty-mac' }`

#### Scenario: iterm2-mac is detected on macOS iTerm2

- **WHEN** `process.platform === 'darwin'` AND `process.env.TERM_PROGRAM === 'iTerm.app'` AND `process.env.TMUX` is unset or empty
- **THEN** detection returns `{ kind: 'iterm2-mac' }`

#### Scenario: none is returned when no supported terminal matches

- **WHEN** no detection condition holds (e.g., running in plain Terminal.app, Alacritty, an SSH session, or a non-macOS shell)
- **THEN** detection returns `{ kind: 'none' }`

### Requirement: Detection precedence

When multiple terminal signals are present simultaneously, the spawner SHALL prefer the multiplexer over the host emulator so that users running tmux inside Ghostty or iTerm2 still get the tmux split.

#### Scenario: tmux inside Ghostty selects tmux

- **WHEN** `process.env.TMUX` is set AND `process.env.TERM_PROGRAM === 'ghostty'`
- **THEN** detection returns `{ kind: 'tmux' }` (Ghostty is ignored)

#### Scenario: tmux inside iTerm2 selects tmux

- **WHEN** `process.env.TMUX` is set AND `process.env.TERM_PROGRAM === 'iTerm.app'`
- **THEN** detection returns `{ kind: 'tmux' }` (iTerm2 is ignored)

### Requirement: Backend dispatch

The spawner SHALL select the backend matching the detected kind and invoke it through the injectable runner so that all backends remain unit-testable without invoking real `tmux` or `osascript`.

#### Scenario: tmux backend calls tmux split-window

- **WHEN** kind is `tmux`
- **THEN** the runner is invoked with `cmd === 'tmux'` and `args` starts with `['split-window', '-h', '-c', <cwd>, <command>]`

#### Scenario: ghostty-mac backend calls osascript

- **WHEN** kind is `ghostty-mac`
- **THEN** the runner is invoked with `cmd === 'osascript'`
- **AND** `args` is a sequence of `-e <line>` pairs whose concatenated script contains `tell application "Ghostty"`, `split <term> direction right`, and `input text` carrying the supplied command

#### Scenario: iterm2-mac backend calls osascript

- **WHEN** kind is `iterm2-mac`
- **THEN** the runner is invoked with `cmd === 'osascript'`
- **AND** `args` is a sequence of `-e <line>` pairs whose concatenated script contains `tell application "iTerm"`, a vertical split of the current session, and a `write text` call carrying the supplied command

### Requirement: Spawn success reporting

On a successful spawn, the spawner SHALL return `{ spawned: true, kind: <detected-kind> }` so that `handleObserveSpawn` can name the actual backend in its success message.

#### Scenario: backend exits zero

- **WHEN** the runner returns `{ status: 0 }` for any detected backend
- **THEN** the spawner result is `{ spawned: true, kind: <that-backend> }` (no `error` field)

### Requirement: Spawn failure reporting

On a non-zero runner status or a thrown runner error, the spawner SHALL return `{ spawned: false, kind: <detected-kind>, error: <human-readable-message> }` so that `handleObserveSpawn` can show the error and fall through to the copy-paste hint.

#### Scenario: backend exits non-zero

- **WHEN** the runner returns `{ status: 1 }` for any detected backend
- **THEN** the spawner result is `{ spawned: false, kind: <that-backend>, error: <string mentioning the backend command and exit status> }`

#### Scenario: backend binary missing or runner throws

- **WHEN** the runner returns `{ status: null, error: <Error> }` (e.g., `ENOENT` for `osascript` on a non-macOS system that was mis-detected)
- **THEN** the spawner result is `{ spawned: false, kind: <that-backend>, error: <string including the error message> }`

### Requirement: No-supported-terminal fallback

When detection returns `{ kind: 'none' }`, the spawner MUST NOT invoke any runner and SHALL return `{ spawned: false, kind: 'none' }` so the caller knows to print only the copy-paste hint (no per-backend failure line).

#### Scenario: outside any supported terminal

- **WHEN** detection returns `{ kind: 'none' }`
- **THEN** the runner is not called
- **AND** the spawner result is `{ spawned: false, kind: 'none' }` (no `error` field)

### Requirement: AppleScript literal escaping

Backends that build AppleScript snippets SHALL escape backslash and double-quote characters in the interpolated command so that arbitrary observer command strings cannot break the surrounding `"..."` literal.

#### Scenario: command contains a double-quote

- **WHEN** the supplied command contains `"`
- **THEN** the produced AppleScript contains `\"` at each occurrence inside its `"..."` literal

#### Scenario: command contains a backslash

- **WHEN** the supplied command contains `\`
- **THEN** the produced AppleScript contains `\\` at each occurrence inside its `"..."` literal
