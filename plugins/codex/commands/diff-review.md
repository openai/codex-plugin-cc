---
description: Run a Codex review and generate a draft PR description for your current changes
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--out <file>] [--clipboard]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a combined Codex diff review and PR description generator through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core behaviour:
- This command is read-only. It will not apply any fixes or patches.
- It produces two outputs: (1) a code review of the diff, (2) a ready-to-paste PR description.
- The PR description is written to a temp file by default. Pass `--out <path>` to choose a location.
- Pass `--clipboard` to also copy the PR description to the clipboard via `pbcopy` (macOS) or `xclip`/`xsel` (Linux).
- Return Codex output verbatim after writing the file. Do not paraphrase or summarise it.

Execution mode rules:
- If `--wait` is present, run in the foreground without asking.
- If `--background` is present, run in the background without asking.
- Otherwise, estimate the diff size first:
  - For working-tree review: run `git status --short --untracked-files=all` and `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review: run `git diff --shortstat <base>...HEAD`.
  - Recommend foreground only when the diff is clearly tiny (1–2 files, no large directories).
  - In all other cases — or when size is unclear — recommend background.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended one first and suffixing it with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve all user arguments exactly as given.
- Do not strip `--wait`, `--background`, `--out`, or `--clipboard`.
- `--base <ref>` and `--scope` are forwarded to the companion script for diff targeting.
- Any extra text after the flags is treated as optional focus text for the review portion.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" diff-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not add commentary, fix issues, or modify the PR description.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" diff-review "$ARGUMENTS"`,
  description: "Codex diff-review + PR description",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion.
- Tell the user: "Codex diff-review started in the background. Check `/codex:status` for progress."
