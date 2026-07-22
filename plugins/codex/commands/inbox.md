---
description: Read and act on new messages from Codex in the shared collaboration workspace
argument-hint: "[--peek]"
allowed-tools: Bash(node:*), Bash(git:*), Read, AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collab.mjs" inbox --for claude $ARGUMENTS
```

Present each message compactly (time · type · issue · body), then act:

- `question` — answer it with a `post --from claude --type question` reply, or do the small thing it asks and post a grounded `status`.
- `handoff` — start the cross-review of that issue's diff.
- `claim` with a CONFLICT — coordinate: agree who owns the overlapping paths and post the outcome.
- `status` / `assign` — context only; no action unless something looks wrong.

If there are no new messages, say so and stop.
