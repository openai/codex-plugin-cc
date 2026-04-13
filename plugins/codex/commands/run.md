---
description: Auto-detect what to review and run the appropriate Codex command
argument-hint: '[--wait|--background] [--base <ref>]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Smart router that detects what to review and dispatches to the right Codex command.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to detect the right review mode, run it, and return output verbatim.

## Step 1: Detect what to review

Run these git commands to assess the repo state:

```bash
git status --short --untracked-files=all
git diff --shortstat
git diff --shortstat --cached
```

Also check if the current branch has commits ahead of the default base:

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
CURRENT=$(git branch --show-current 2>/dev/null || echo "HEAD")
git rev-list --count "${BASE}..HEAD" 2>/dev/null || echo "0"
```

And check for plan files:

```bash
ls HANDOFF.md 2>/dev/null
ls working-docs/*/plan*.md 2>/dev/null
```

## Step 2: Route to the right command

Apply the first matching rule:

1. **Working tree has changes** (staged, unstaged, or untracked files):
   Route to challenge with working-tree scope.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" challenge --scope working-tree $EXTRA_FLAGS
   ```

2. **Branch has commits ahead of base** (rev-list count > 0):
   Route to challenge with branch scope.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" challenge --scope branch $EXTRA_FLAGS
   ```

3. **HANDOFF.md or plan file exists** (but no code changes):
   Route to adversarial-review with plan focus.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review $EXTRA_FLAGS "Review the feasibility and completeness of this plan"
   ```

4. **Nothing to review**:
   Tell the user there are no changes to review and show available commands:
   ```
   No changes detected. Available Codex commands:
     /codex:challenge        Context-aware adversarial review
     /codex:review           Standard code review
     /codex:adversarial-review  Adversarial review with custom focus
     /codex:rescue           Delegate a task to Codex
     /codex:status           Check running jobs
     /codex:setup            Check Codex CLI status
   ```

## Step 3: Execution mode

- If `$ARGUMENTS` includes `--wait`, run in foreground. Do not ask.
- If `$ARGUMENTS` includes `--background`, run in background. Do not ask.
- Otherwise, default to background. Do not ask.

Extract `--wait`, `--background`, and `--base <ref>` from `$ARGUMENTS` and pass them through as `$EXTRA_FLAGS`. Do not pass them twice.

## Foreground flow

Run the selected companion command and return stdout verbatim.
Do not paraphrase, summarize, or add commentary before or after it.
Do not fix any issues mentioned in the review output.

## Background flow

Launch with `Bash` using `run_in_background: true`.
Tell the user which command was selected and that it is running in the background.
