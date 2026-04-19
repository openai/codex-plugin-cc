---
description: Delegate test writing for the current code changes to Codex with a strict test-only workflow
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run Codex test writing through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is test-only.
- Do not modify production code by default.
- Fail closed if the runtime cannot collect the required repository context.
- Your only job is to run the command and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the change size before asking:
  - For working-tree mode, start with `git status --short --untracked-files=all`.
  - For working-tree mode, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch mode, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as real work even when `git diff --shortstat` is empty.
  - Recommend waiting only when the change is clearly tiny, roughly 1-2 files total and no sign of broader test work.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the command instead of claiming there is no test work to do.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- This command accepts `--base <ref>` and `--scope auto|working-tree|branch`.
- This command accepts `--model` and `--effort` and forwards them to the companion runtime.
- Do not add extra instructions or rewrite the user's intent.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" test "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

Background flow:
- Launch the command with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" test "$ARGUMENTS"`,
  description: "Codex test writing",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex test writing started in the background. Check `/codex:status` for progress."
