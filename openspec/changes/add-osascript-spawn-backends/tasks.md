## 0. Spike: validate Ghostty AppleScript surface

- [ ] 0.1 In a real Ghostty window, run a 10-line `osascript` that opens two windows and prints `tty of` each `terminal in terminals` to confirm the property exists and returns `/dev/ttysNN`. Note the Ghostty version under test.
- [ ] 0.2 Run the same probe against iTerm2 using `tty of current session` and `tty of session 1 of window N`. Note the iTerm2 version under test.
- [ ] 0.3 If Ghostty's `tty of` is unavailable on the pinned version, narrow this change: Ghostty backend ships with new-window-only behavior (still safe), and an upstream feature request is filed. Update design §Risks accordingly. Otherwise proceed with the full tty-match path.

## 1. Tests First (RED)

- [ ] 1.1 Extend `tests/spawner.test.mjs` `detectTerminal` block with cases for `ghostty-mac` (darwin + `TERM_PROGRAM=ghostty`, no `TMUX`) and `iterm2-mac` (darwin + `TERM_PROGRAM=iTerm.app`, no `TMUX`), and a non-darwin case that returns `none` even when `TERM_PROGRAM` matches.
- [ ] 1.2 Add a `Detection precedence` describe block asserting that `tmux` wins when both `$TMUX` and `$TERM_PROGRAM=ghostty` (or `iTerm.app`) are set.
- [ ] 1.3 Add `spawnObserverInTerminal` cases for the new backends using the existing injected-runner pattern: assert `cmd === 'osascript'` and inspect the `-e` arg sequence for the required AppleScript verbs (`tell application "Ghostty"` / `tell application "iTerm"`, the `repeat with` loop comparing `tty of`, the `split` and `new window` / `create window` branches, `input text` / `write text` carrying the composed command).
- [ ] 1.4 Add escape tests asserting that `"` in the composed shell command becomes `\"` and `\` becomes `\\` in the AppleScript literal.
- [ ] 1.5 Add **shell-quoting** tests for the new `composeShellInvocation({ cwd, command })` helper: cwd containing spaces → wrapped in `'...'`; cwd containing a single quote → escaped as `'\''`; cwd containing `;`/`$`/space → metacharacters appear inside the quoted literal with no shell effect; cwd containing unicode → bytes preserved verbatim.
- [ ] 1.6 Add **control-char rejection** tests: composed command containing `\n`, `\r`, or `\0` → `spawnObserverInTerminal` returns `{ spawned: false, kind, reason: 'unsafe-command', error }` and the injected runner is NOT called.
- [ ] 1.7 Add **tty-match dispatch** tests: stub the tty-discovery helper to return a known `/dev/ttysNN`, then assert the produced AppleScript embeds that tty inside the `repeat` loop's comparison. Add a second test where the discovery helper returns `null` → assert the produced AppleScript goes straight to the `new window` branch (no `repeat`/`split`).
- [ ] 1.8 Add **permission-denied** tests: stub the runner to return `{ status: 1, stderr: '(-1743) Not authorized to send Apple events to ...' }` → assert `{ spawned: false, kind, reason: 'automation-permission-denied', error }`. Repeat with the lowercase phrase variant.
- [ ] 1.9 Extend `tests/observe.test.mjs` wiring tests with a `handleObserveSpawn` case that injects a fake spawner returning `{ spawned: false, reason: 'automation-permission-denied' }` and asserts the printed output contains "Automation permission needed" and does NOT contain the copy-paste fallback hint.
- [ ] 1.10 Run `node --test tests/spawner.test.mjs tests/observe.test.mjs` and confirm the new cases fail before any implementation lands.

## 2. Refactor spawner.mjs to a strategy table

- [ ] 2.1 Introduce a backends table with three entries (`tmux`, `ghostty-mac`, `iterm2-mac`), each `{ detect(env), build({ cwd, command, callerTty }), cmd, classifyFailure(result) }`. Order entries in priority sequence (tmux first).
- [ ] 2.2 Rewrite `detectTerminal(env)` to walk the table and return the first hit, falling back to `{ kind: 'none' }`. Keep the current return shape (`{ kind }`).
- [ ] 2.3 Rewrite `spawnObserverInTerminal({ cwd, command, env, runner })` to: (a) early-return `{ spawned: false, kind: 'none' }` when no backend matches; (b) run the control-char guard on the composed shell invocation (see §3.1) — early-return `unsafe-command` on hit; (c) discover `callerTty` (see §3.2) — `null` is fine; (d) call `runner(backend.cmd, backend.build({ cwd, command, callerTty }), { stdio: ['ignore', 'ignore', 'pipe'] })` (note: stderr captured for classification); (e) on non-zero status, ask `backend.classifyFailure({ status, stderr, error })` → may return `automation-permission-denied` or a generic error string.
- [ ] 2.4 Keep `buildTmuxSplitArgs` exported (the existing tmux test depends on it). Keep `shellQuote` exported. Tmux backend's `classifyFailure` only returns generic errors (no permission concept).

## 3. Shared helpers (live in spawner.mjs)

- [ ] 3.1 Add `composeShellInvocation({ cwd, command })` that returns `cd ${shellQuote(cwd)} && ${command}` (command is already shell-safe from `buildObserverCommand`). Add a `rejectControlChars(value)` helper that scans for bytes in `0x00–0x1F` minus `0x09`/`0x20` and returns `{ ok: false, byte }` on hit, `{ ok: true }` otherwise.
- [ ] 3.2 Add `discoverCallerTty()` that walks the process ancestry via `ps -o tty=,ppid= -p <pid>` (use `execFileSync` with a 250ms timeout and a `.catch(() => null)` net), returning `/dev/ttysNN` for the first ancestor with a non-`?` tty, or `null` after walking 10 levels / hitting pid 1 / a `ps` error. Pure function input: starting pid (default `process.pid`); pure dependency: an injectable `runProbe(cmd, args)` for tests.
- [ ] 3.3 Add `escapeAppleScriptLiteral(value)` that doubles `\` and `"` (and nothing else). Pure function, no env access.
- [ ] 3.4 Add `osascriptArgsFromLines(lines)` that returns `lines.flatMap(line => ['-e', line])` so backends build their script as an array of lines and the runner-args composition is a single line.

## 4. Implement ghostty-mac backend

- [ ] 4.1 Add `buildGhosttyMacArgs({ cwd, command, callerTty })`. Body:
  1. `const shell = composeShellInvocation({ cwd, command })` — Layer 1 (shell-safe).
  2. `const literal = escapeAppleScriptLiteral(shell)` — Layer 2 (AppleScript-safe).
  3. Build script lines:
     - `tell application "Ghostty"`
     - `activate`
     - if `callerTty`: `set targetTty to "${escapeAppleScriptLiteral(callerTty)}"` then `set matched to missing value` then a `repeat with t in terminals` block that sets `matched` to the first `t` whose `tty` equals `targetTty`; an `if matched is not missing value then set newTerm to split matched direction right` branch and an `else` branch that does `new window`.
     - if no `callerTty`: skip the repeat, go straight to `new window`.
     - `input text "${literal}\n" to newTerm` (final line uses whichever variable the active branch set).
     - `end tell`
  4. Return `osascriptArgsFromLines(scriptLines)`.
- [ ] 4.2 Add `classifyGhosttyFailure({ status, stderr, error })`: if `stderr.includes('(-1743)') || /not authorized to send apple events/i.test(stderr)` → return `{ reason: 'automation-permission-denied', error: <message> }`; else return `{ error: <`Failed to drive ghostty-mac: ...`> }`.
- [ ] 4.3 Wire the backend into the strategy table.

## 5. Implement iterm2-mac backend

- [ ] 5.1 Add `buildIterm2MacArgs({ cwd, command, callerTty })`. Body mirrors §4.1 but with iTerm2 verbs: `tell application "iTerm"`, iterate `windows`/`sessions of <window>` comparing `tty of <session>`, on match `tell <session>` → `split vertically with default profile`, on no match (or no `callerTty`) `create window with default profile`. Final command via `write text "${literal}" to <newSession>` (no trailing `\n` — iTerm2 `write text` adds Enter).
- [ ] 5.2 Add `classifyIterm2Failure(...)` identical in shape to §4.2.
- [ ] 5.3 Wire the backend into the strategy table.

## 6. Caller updates (observe.mjs handleObserveSpawn)

- [ ] 6.1 Replace the hardcoded `"new tmux pane"` success string with a per-kind label table: `tmux pane` / `Ghostty split or new window` / `iTerm2 split or new window`.
- [ ] 6.2 When the spawner result has `reason === 'automation-permission-denied'`, print a single line of the form `! macOS Automation permission needed for <Ghostty|iTerm2>. Open System Settings → Privacy & Security → Automation, enable <app>, then rerun /codex:observe.` and do NOT print the generic copy-paste fallback hint.
- [ ] 6.3 When the spawner result has `reason === 'unsafe-command'`, print `✗ Refusing to spawn: composed command contains a control character (<byte name>). Run the command manually:` followed by the copy-paste hint (this path is paranoid — should never trigger in practice — but the message must be unambiguous if it does).
- [ ] 6.4 Verify the existing `tests/observe.test.mjs` non-tmux fallback wiring test still passes unchanged.

## 7. Verification (GREEN)

- [ ] 7.1 `npm run build` is clean (tsc checkJs against the new strategy-table types and the helper signatures).
- [ ] 7.2 `node --test tests/spawner.test.mjs tests/observe.test.mjs` is green — the new cases from §1 now pass.
- [ ] 7.3 `npm test` full suite is green (target ≥168 tests, no regressions; new tests bring total higher).
- [ ] 7.4 Regression smoke: from inside tmux, `node plugins/codex/scripts/codex-companion.mjs observe --spawn --cwd /tmp task-fake` still opens a tmux pane and prints `✓ Observer launched in tmux pane`.
- [ ] 7.5 Mac smoke (Ghostty, requires real machine):
  - 7.5.1 First-run permission dialog: from a freshly Automation-denied state, run the command and confirm the printed line matches the dedicated "grant access and retry" message; grant access in System Settings; rerun and confirm a split opens.
  - 7.5.2 Cwd with spaces: invoke with `--cwd "/tmp/dir with spaces"` (mkdir first), confirm the new pane is in that directory.
  - 7.5.3 Non-frontmost invocation: open a second Ghostty window, make the second one frontmost, invoke from the first; confirm the split happens in the *first* (caller's) window via tty-match — NOT in the frontmost.
  - 7.5.4 No-match fallback: close all Ghostty windows except the calling one, then exec the binary from a non-Ghostty context that still detects ghostty-mac (e.g., setting `TERM_PROGRAM=ghostty` manually in a Terminal.app shell); confirm a brand-new Ghostty window opens instead of a misplaced split.
- [ ] 7.6 Mac smoke (iTerm2, requires real machine): repeat 7.5.1–7.5.4 with iTerm2 verbs.

## 8. Docs & version

- [ ] 8.1 Update `plugins/codex/commands/observe.md` Behavior section to list the three supported backends (tmux, Ghostty on macOS, iTerm2 on macOS), the new-window fallback when targeting fails, and the Automation-permission note.
- [ ] 8.2 Run `node scripts/bump-version.mjs 1.4.0` and `npm run check-version` to confirm all four manifests sync.
- [ ] 8.3 Stage only the implementation + test + docs + version files (do NOT include `.omc/` or unrelated edits). Commit with message `feat: add ghostty + iterm2 osascript spawn backends (1.4.0)`.

## 9. Final review (Claude main thread)

- [ ] 9.1 `git diff main...HEAD --stat` — confirm the touched files match the §0–§8 scope; challenge any out-of-scope edits.
- [ ] 9.2 Cross-check tasks.md against the implementation diff and the spec scenarios; every scenario in `specs/observer-spawner/spec.md` must map to at least one test case.
- [ ] 9.3 Run `/codex:review` and `/ai-code-review` (or `code-reviewer` agent) for dual-model coverage.
- [ ] 9.4 Run `/codex:adversarial-review` one more time on the implementation diff (separate from the spec-pass we already did) — focus on whether the implementation honors every spec requirement, including the failure-classification edge cases.
- [ ] 9.5 Update HANDOFF (path TBD by Codex during §8.3) summarising what was implemented, what was manually smoke-tested (§7.5/§7.6), the Ghostty/iTerm2 versions used, and any open follow-ups (e.g., Linux Ghostty, WezTerm).
- [ ] 9.6 `/opsx:archive add-osascript-spawn-backends` once the change is merged.
