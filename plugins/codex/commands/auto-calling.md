---
description: Toggle whether Claude can invoke Codex commands programmatically (e.g. from /loop or automated workflows)
argument-hint: '[enable|disable]'
disable-model-invocation: true
allowed-tools: Bash, Glob, Grep, Read
---

Toggle `disable-model-invocation` on Codex plugin commands.

The argument is `$ARGUMENTS`. If empty, check current state and report it.

Target files: all `.md` files in `${CLAUDE_PLUGIN_ROOT}/commands/` that have `disable-model-invocation: true`: `review.md`, `adversarial-review.md`, `cancel.md`, `result.md`, `status.md`.

## Rules

- **`enable`**: Remove the line `disable-model-invocation: true` from the YAML frontmatter of each target file. This allows Claude to invoke these commands programmatically.
- **`disable`**: Add `disable-model-invocation: true` back to the YAML frontmatter (after the `description:` line) of each target file. This restores the default behavior.
- **No argument**: Read the target files and report whether auto-calling is currently enabled or disabled.

After making changes, report which files were modified.
