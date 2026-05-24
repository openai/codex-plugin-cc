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
- **AND** `args` is a sequence of `-e <line>` pairs whose concatenated script contains `tell application "Ghostty"`, a `repeat with` loop that compares `tty of` each open terminal to the caller-tty argument, a `split <matched-term> direction right` branch when a match is found, a `new window` branch when no match is found, and an `input text` call carrying the supplied command

#### Scenario: iterm2-mac backend calls osascript

- **WHEN** kind is `iterm2-mac`
- **THEN** the runner is invoked with `cmd === 'osascript'`
- **AND** `args` is a sequence of `-e <line>` pairs whose concatenated script contains `tell application "iTerm"`, a `repeat` loop that compares `tty of` each session in each window to the caller-tty argument, a `split vertically` branch when a match is found, a `create window with default profile` branch when no match is found, and a `write text` call carrying the supplied command

### Requirement: Spawn success reporting

On a successful spawn, the spawner SHALL return `{ spawned: true, kind: <detected-kind> }` so that `handleObserveSpawn` can name the actual backend in its success message.

#### Scenario: backend exits zero

- **WHEN** the runner returns `{ status: 0 }` for any detected backend
- **THEN** the spawner result is `{ spawned: true, kind: <that-backend> }` (no `error` field)

### Requirement: Spawn failure reporting

On a non-zero runner status or a thrown runner error that is NOT one of the carved-out classes (`automation-permission-denied`, `unsafe-command`), the spawner SHALL return `{ spawned: false, kind: <detected-kind>, error: <human-readable-message> }` so that `handleObserveSpawn` can show the error and fall through to the copy-paste hint.

#### Scenario: backend exits non-zero with no recognized reason

- **WHEN** the runner returns `{ status: 1 }` for any detected backend AND stderr does not match the permission-denied pattern
- **THEN** the spawner result is `{ spawned: false, kind: <that-backend>, error: <string mentioning the backend command and exit status> }` (no `reason` field)

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

Backends that build AppleScript snippets SHALL escape backslash and double-quote characters in the interpolated shell command so that the observer command — as constructed by the spawner's own `buildObserverCommand` helper plus the shell-quoting layer in the requirement below — cannot break the surrounding `"..."` literal. The escape function MUST NOT be claimed safe against arbitrary user-controlled strings; the control-character rejection requirement is what enforces that input domain.

#### Scenario: command contains a double-quote

- **WHEN** the composed shell command (after shell-quoting) contains `"`
- **THEN** the produced AppleScript contains `\"` at each occurrence inside its `"..."` literal

#### Scenario: command contains a backslash

- **WHEN** the composed shell command (after shell-quoting) contains `\`
- **THEN** the produced AppleScript contains `\\` at each occurrence inside its `"..."` literal

### Requirement: Shell-safe composition of cwd and command

Before the AppleScript escape layer runs, both `cwd` and `command` SHALL be shell-quoted (single-quote escaping, doubling internal `'` as `'\''`) and composed into a `cd <quoted-cwd> && <command>` string. The composed string SHALL be parseable by a POSIX shell when passed via `input text` / `write text`.

#### Scenario: cwd contains spaces

- **WHEN** `cwd` is `/Users/dragon.cl/work projects/codex-plugin-cc`
- **THEN** the composed string starts with `cd '/Users/dragon.cl/work projects/codex-plugin-cc' && ` (cwd wrapped in single quotes)

#### Scenario: cwd contains a single quote

- **WHEN** `cwd` is `/tmp/it's-a-trap`
- **THEN** the composed string starts with `cd '/tmp/it'\''s-a-trap' && ` (single quote escaped as `'\''`)

#### Scenario: cwd contains shell metacharacters

- **WHEN** `cwd` is `/tmp/foo;rm -rf /;`
- **THEN** the composed string is `cd '/tmp/foo;rm -rf /;' && <command>` and the embedded `;`/space/etc. are inside the single-quoted literal and have no shell effect

#### Scenario: cwd contains unicode

- **WHEN** `cwd` is `/Users/田中/プロジェクト`
- **THEN** the composed string contains the original unicode bytes verbatim inside the single-quoted literal

### Requirement: Caller-terminal targeting with new-window fallback

The osascript backends SHALL discover the caller shell's controlling tty (walking the process ancestry until an ancestor with a real tty is found) and pass that path into the AppleScript. The AppleScript SHALL iterate all open terminals/sessions in the target app and split the one whose `tty` matches; when no match is found OR tty discovery itself fails, the script SHALL open a brand-new window for the observer. It MUST NOT silently split an unrelated front window.

#### Scenario: caller tty matches an open Ghostty terminal

- **WHEN** the caller-tty argument equals the `tty` of one of Ghostty's open terminals
- **THEN** the AppleScript splits *that* terminal (direction right) and runs the command in the new pane

#### Scenario: caller tty matches an open iTerm2 session

- **WHEN** the caller-tty argument equals the `tty` of one of iTerm2's open sessions
- **THEN** the AppleScript splits *that* session vertically and runs the command in the new session

#### Scenario: no matching terminal found

- **WHEN** no open terminal/session has a `tty` matching the caller-tty argument
- **THEN** the AppleScript opens a new window in the target app (NOT a split of the front window), sets its working directory, and runs the command

#### Scenario: caller tty cannot be discovered

- **WHEN** process-ancestry discovery returns no tty (e.g., sandboxed shell, `ps` unavailable)
- **THEN** the spawner builds AppleScript that goes directly to the new-window branch with no split attempt

### Requirement: Reject control characters before building AppleScript

Before any AppleScript or shell composition runs, the spawner SHALL reject composed-command strings that contain ASCII control bytes (`0x00`–`0x1F`) other than `0x09` (tab) and `0x20` (space). On rejection the spawner SHALL return `{ spawned: false, kind: <detected-kind>, reason: 'unsafe-command', error: <human-readable-message naming the offending byte category> }` and the runner MUST NOT be invoked.

#### Scenario: composed command contains a newline

- **WHEN** the composed `cd ... && <command>` string contains `\n`
- **THEN** the spawner returns `{ spawned: false, kind: <detected-kind>, reason: 'unsafe-command', error: <string mentioning embedded newline> }` and the runner is not called

#### Scenario: composed command contains a NUL byte

- **WHEN** the composed string contains `\0`
- **THEN** the spawner returns `{ spawned: false, kind: <detected-kind>, reason: 'unsafe-command', error: <string mentioning NUL> }` and the runner is not called

#### Scenario: composed command contains a carriage return

- **WHEN** the composed string contains `\r`
- **THEN** the spawner returns `{ spawned: false, kind: <detected-kind>, reason: 'unsafe-command', error: <string mentioning embedded control character> }` and the runner is not called

### Requirement: Automation-permission-denied messaging

When an osascript backend fails because the user has not granted Automation permission, the spawner SHALL classify the failure as `automation-permission-denied` (distinct from generic spawn failure), and `handleObserveSpawn` SHALL print a single dedicated message instructing the user to grant access and retry — without printing the generic copy-paste fallback hint.

#### Scenario: osascript stderr contains the documented permission error number

- **WHEN** the runner returns `{ status: 1, stderr: <string containing '(-1743)'> }`
- **THEN** the spawner result is `{ spawned: false, kind: <detected-kind>, reason: 'automation-permission-denied', error: <human-readable message> }`

#### Scenario: osascript stderr contains the "not authorized" phrase

- **WHEN** the runner returns `{ status: 1, stderr: <string containing 'not authorized to send Apple events' case-insensitive> }`
- **THEN** the spawner result is `{ spawned: false, kind: <detected-kind>, reason: 'automation-permission-denied', error: <human-readable message> }`

#### Scenario: handleObserveSpawn prints the dedicated permission message

- **WHEN** the spawner returns a result with `reason === 'automation-permission-denied'`
- **THEN** `handleObserveSpawn` prints a single line of the form `! macOS Automation permission needed for <Ghostty|iTerm2>. Open System Settings → Privacy & Security → Automation, enable <app>, then rerun /codex:observe.`
- **AND** does NOT print the generic copy-paste fallback hint
