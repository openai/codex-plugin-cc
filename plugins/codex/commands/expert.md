---
description: Automatically ask a user-selected named Codex expert when the current model needs a stronger bounded pass
argument-hint: "[--name <name>] [--write] [handoff]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Use the companion expert broker for a deliberate, user-approved escalation when the current model has reached its supported effort ceiling, has failed a bounded task, or identifies an ambiguous/high-risk decision that needs a stronger pass. This command is safe for model invocation because it always pauses for the user's model-and-effort choice before starting an expert, even when raw arguments contain routing flags.

Raw handoff request:
`$ARGUMENTS`

Use `AskUserQuestion` exactly once with these two questions:

1. Which expert model should handle the handoff?
   - `Sol (Recommended)` — map to `gpt-5.6-sol` and use it as the default expert.
   - `Terra` — map to `gpt-5.6-terra` for a balanced expert pass.
   - `Luna` — map to `gpt-5.6-luna` for a lower-cost expert pass.
2. How much reasoning effort should the expert use?
   - `High (Recommended)` — the default Sol setting.
   - `XHigh` — spend more effort on a difficult bounded problem.
   - `Max` — use the maximum effort supported by this harness.

After the choice, invoke exactly one foreground command, adding the selected `--model` and `--effort` values after the raw handoff arguments so the user's choice is authoritative:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" expert "$ARGUMENTS" --model <selected-model-id> --effort <selected-effort>
```

Return the command's stdout verbatim. The selected model and effort are authoritative even if raw arguments contained routing flags. Do not silently change the selected model or effort, create a second expert, or modify the handoff text. The command creates a persistent named Codex thread and returns its session ID with the expert's final answer.
