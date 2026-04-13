---
description: Auto-detect what to review and run the appropriate Codex command
argument-hint: '[--wait|--background] [--base <ref>]'
allowed-tools: Bash(node:*), Bash(git:*)
---

Smart router that detects what to review and dispatches to the right Codex command.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to detect the right review mode, run it, and return output verbatim.

## Execution

**If `--wait` is in the arguments**: run detection and companion in the foreground.

Run git commands to detect scope, then call the matching companion command:
- Working tree has changes → `challenge --scope working-tree`
- Branch ahead of base → `challenge --scope branch`
- HANDOFF.md or plan file exists → `adversarial-review "Review the feasibility and completeness of this plan"`
- Nothing to review → tell user, show available commands

Return stdout verbatim.

**Otherwise (default)**: launch the entire detection + review as a single background Bash call. This must be your FIRST and ONLY tool call. Do not run any preliminary git commands yourself.

```typescript
Bash({
  command: `PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"; EXTRA_FLAGS="$ARGUMENTS"; STATUS=$(git status --short --untracked-files=all 2>/dev/null); BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main"); AHEAD=$(git rev-list --count "${BASE}..HEAD" 2>/dev/null || echo "0"); PLAN=$(ls HANDOFF.md working-docs/*/plan*.md 2>/dev/null); if [ -n "$STATUS" ]; then node "$PLUGIN_ROOT/scripts/codex-companion.mjs" challenge --scope working-tree $EXTRA_FLAGS; elif [ "$AHEAD" -gt 0 ]; then node "$PLUGIN_ROOT/scripts/codex-companion.mjs" challenge --scope branch $EXTRA_FLAGS; elif [ -n "$PLAN" ]; then node "$PLUGIN_ROOT/scripts/codex-companion.mjs" adversarial-review $EXTRA_FLAGS "Review the feasibility and completeness of this plan"; else echo "No changes detected."; fi`,
  description: "Codex auto-detect review",
  run_in_background: true
})
```

After launching, respond with only: "Codex review running in background."

## Rules

- Extract `--wait` and `--base <ref>` from `$ARGUMENTS` for `$EXTRA_FLAGS`. Do not pass them twice.
- Do not fix any issues mentioned in the review output.
