---
description: Run a Codex review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Run an adversarial Codex review through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

## Execution

**If `--wait` is in the arguments**: run in the foreground.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"
```

Return stdout verbatim. Do not paraphrase, summarize, or add commentary.

**Otherwise (default)**: launch in the background immediately. This must be your FIRST and ONLY tool call. Do not run any git commands, size estimation, or other preliminary steps.

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Codex adversarial review",
  run_in_background: true
})
```

After launching, respond with only: "Codex adversarial review running in background."

## Rules

- Preserve the user's arguments exactly. Do not strip or rewrite flags.
- Do not read files, run git commands, or do any work before launching. The companion script handles all detection.
- Do not fix any issues mentioned in the review output.
