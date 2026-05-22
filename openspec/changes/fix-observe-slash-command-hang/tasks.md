## 1. Edit slash-command body

- [x] 1.1 Open `plugins/codex/commands/observe.md`
- [x] 1.2 Delete lines 38–40 (the paragraph "If you want to see the output inline instead, you can run:" together with the immediately following `` !`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe $ARGUMENTS` `` exec line and the blank line between them)
- [x] 1.3 Delete lines 42–48 (the model-facing prose starting "Present the command output to the user. The observer shows:" through the bulleted list ending at "Completion status with timestamp")
- [x] 1.4 Verify the resulting file ends after the existing "Note: This command is designed to be run in a separate terminal…" paragraph (the file should be ~36 lines after edits, all static guidance)
- [x] 1.5 Confirm no remaining line in the body begins with `` !` `` (Claude Code inline shell-exec marker)

## 2. Verify CLI subcommand untouched

- [x] 2.1 Confirm `plugins/codex/scripts/codex-companion.mjs` and `plugins/codex/scripts/lib/observe.mjs` are unmodified by this change
- [x] 2.2 Run `npm run build` (typecheck) and confirm it passes
- [x] 2.3 Run `npm test` and confirm `tests/observe.test.mjs` and all other tests pass without modification
  - Note: 4 pre-existing flaky failures in `runtime.test.mjs` / `state.test.mjs` (status #72, #74, result #76, resolveStateDir #93). Confirmed pre-existing by re-running on the pre-change tree (5 fails on HEAD vs 4 with this change). None of those tests reference `observe.md`; `tests/observe.test.mjs` passes cleanly.

## 3. Manual smoke test in Claude Code

- [ ] 3.1 Reload the plugin in Claude Code so the updated `observe.md` is picked up *(requires post-push reinstall by user)*
- [ ] 3.2 With **no** running Codex job in the workspace: invoke `/codex:observe` — confirm the guidance text renders immediately (no hang, no empty output) *(deferred to post-publish smoke test by user)*
- [ ] 3.3 With a running Codex job in the workspace: invoke `/codex:observe` — confirm the same guidance text renders immediately (no hang) *(deferred to post-publish smoke test by user)*
- [ ] 3.4 Verify the rendered output contains: the new-terminal instruction, a copy-paste command line including `$ARGUMENTS` placeholder semantics, the three usage examples, and the `Ctrl+C` detach note *(file content guarantees this; deferred to post-publish smoke test)*
- [x] 3.5 Open a separate terminal, paste the suggested command, and confirm the live observer still works end-to-end (renders events, handles SIGINT cleanly)
  - Verified by user: ran `node …/scripts/codex-companion.mjs observe` in a fresh terminal; observer rendered `starting → Thread ready → Turn started`.

## 4. Wrap up

- [x] 4.1 Stage the single-file change: `git add plugins/codex/commands/observe.md`
  - Extended scope: also staging version bump (1.2.3 → 1.2.4 across `package.json`, `plugins/codex/.claude-plugin/plugin.json`, `package-lock.json`, `.claude-plugin/marketplace.json`), CHANGELOG entry, and OpenSpec change artifacts.
- [x] 4.2 Commit with message following repo style (e.g., `fix: remove inline !exec from /codex:observe slash command to unblock guidance rendering`)
- [x] 4.3 Run `openspec validate fix-observe-slash-command-hang` and confirm clean
- [ ] 4.4 After the change is merged, run `/opsx:archive fix-observe-slash-command-hang` to promote `observe-slash-command` into `openspec/specs/`
