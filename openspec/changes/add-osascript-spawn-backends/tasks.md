## 1. Tests First (RED)

- [ ] 1.1 Extend `tests/spawner.test.mjs` `detectTerminal` block with cases for `ghostty-mac` (darwin + `TERM_PROGRAM=ghostty`, no `TMUX`) and `iterm2-mac` (darwin + `TERM_PROGRAM=iTerm.app`, no `TMUX`), and a non-darwin case that returns `none` even when `TERM_PROGRAM` matches.
- [ ] 1.2 Add a `Detection precedence` describe block asserting that `tmux` wins when both `$TMUX` and `$TERM_PROGRAM=ghostty` (or `iTerm.app`) are set.
- [ ] 1.3 Add `spawnObserverInTerminal` cases for the new backends using the existing injected-runner pattern: assert `cmd === 'osascript'` and inspect the `-e` arg sequence for the required AppleScript verbs (`tell application "Ghostty"`/`tell application "iTerm"`, `split`, `input text`/`write text`).
- [ ] 1.4 Add escape tests covering a command containing `"` and a command containing `\` — assert the produced AppleScript literal contains `\"` and `\\` respectively.
- [ ] 1.5 Run `node --test tests/spawner.test.mjs` and confirm the new cases fail before any implementation lands.

## 2. Refactor spawner.mjs to a strategy table

- [ ] 2.1 Introduce a backends table with three entries (`tmux`, `ghostty-mac`, `iterm2-mac`), each `{ detect(env), build({ cwd, command }), cmd }`. Order entries in priority sequence (tmux first).
- [ ] 2.2 Rewrite `detectTerminal(env)` to walk the table and return the first hit, falling back to `{ kind: 'none' }`. Keep the current return shape (`{ kind }`).
- [ ] 2.3 Rewrite `spawnObserverInTerminal({ cwd, command, env, runner })` to look up the backend record and call `runner(backend.cmd, backend.build({ cwd, command }), { stdio: 'ignore' })`. Preserve the existing success / non-zero-status / runner-error branches and their result shapes.
- [ ] 2.4 Keep `buildTmuxSplitArgs` exported (the existing tmux test depends on it). Keep `shellQuote` exported.

## 3. Implement ghostty-mac backend

- [ ] 3.1 Add an `escapeAppleScriptLiteral(value)` helper that doubles `\` and `"` (and nothing else). Place it next to `shellQuote` in `spawner.mjs`.
- [ ] 3.2 Add `buildGhosttyMacArgs({ cwd, command })` that returns the `-e <line>` arg array driving `tell application "Ghostty"` → `activate` → `set currentTerm to focused terminal of selected tab of front window` → `set newTerm to split currentTerm direction right` → `input text "cd <escaped-cwd> && <escaped-command>\n" to newTerm`.
- [ ] 3.3 Wire the backend into the strategy table from §2.

## 4. Implement iterm2-mac backend

- [ ] 4.1 Add `buildIterm2MacArgs({ cwd, command })` returning the `-e <line>` arg array driving `tell application "iTerm"` → `activate` → `set newSession to (split vertically with default profile) of current session of current window` → `write text "cd <escaped-cwd> && <escaped-command>" to newSession` (no trailing `\n` — iTerm2 `write text` adds Enter automatically).
- [ ] 4.2 Wire the backend into the strategy table.

## 5. Caller updates

- [ ] 5.1 In `plugins/codex/scripts/lib/observe.mjs` `handleObserveSpawn`, replace the hardcoded `"new tmux pane"` success string with a per-kind label (`tmux pane` / `Ghostty split` / `iTerm2 split`). Keep the existing failure / fallback paths intact.
- [ ] 5.2 Verify the existing `tests/observe.test.mjs` fallback wiring test still passes unchanged.

## 6. Verification (GREEN)

- [ ] 6.1 `npm run build` is clean (tsc checkJs against the new strategy-table types).
- [ ] 6.2 `node --test tests/spawner.test.mjs tests/observe.test.mjs` is green — the new cases from §1 now pass.
- [ ] 6.3 `npm test` full suite is green (target ≥168 tests, no regressions).
- [ ] 6.4 Regression smoke: from inside tmux, `node plugins/codex/scripts/codex-companion.mjs observe --spawn --cwd /tmp task-fake` still opens a tmux pane and prints `✓ Observer launched in tmux pane`.
- [ ] 6.5 Mac smoke (Ghostty, requires real machine): from a Ghostty window without tmux, run the same command and visually confirm a right-side split opens and runs the observer (will exit on "Job not found"). Note the macOS Automation permission dialog on first run.
- [ ] 6.6 Mac smoke (iTerm2, requires real machine): same as 6.5 but in an iTerm2 window.

## 7. Docs & version

- [ ] 7.1 Update `plugins/codex/commands/observe.md` Behavior section to list the three supported backends (tmux, Ghostty on macOS, iTerm2 on macOS) and note the fallback.
- [ ] 7.2 Run `node scripts/bump-version.mjs 1.4.0` and `npm run check-version` to confirm all four manifests sync.
- [ ] 7.3 Stage only the implementation + test + docs + version files (do NOT include `.omc/` or unrelated edits). Commit with message `feat: add ghostty + iterm2 osascript spawn backends (1.4.0)`.

## 8. Final review (Claude main thread)

- [ ] 8.1 `git diff main...HEAD --stat` — confirm the touched files match the §1–§7 scope; challenge any out-of-scope edits.
- [ ] 8.2 Cross-check tasks.md against the implementation diff and the spec scenarios; every scenario in `specs/observer-spawner/spec.md` must map to at least one test case.
- [ ] 8.3 Run `/codex:review` and `/ai-code-review` (or `code-reviewer` agent) for dual-model coverage.
- [ ] 8.4 Update HANDOFF (path TBD by Codex during §7.3) summarising what was implemented, what was manually smoke-tested, and any open follow-ups.
- [ ] 8.5 `/opsx:archive add-osascript-spawn-backends` once the change is merged.
