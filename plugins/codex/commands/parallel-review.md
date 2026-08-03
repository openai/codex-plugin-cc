---
description: Shard a large Codex review into concurrent background tasks plus a cross-shard integration pass
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--max-shards 4] [--invariants-file <path>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a sharded adversarial Codex review through the shared plugin runtime.

The companion splits the diff into up to `--max-shards` balanced shards by
directory/file ownership, reviews them as concurrent background tasks, then
runs one mandatory cross-shard integration pass that verifies every finding
(CONFIRMED / SUSPECTED / REJECTED) and hunts defects that span two shards —
the class a single shard can never see whole. Small diffs (under ~300 changed
lines or 8 files) automatically fall back to one plain adversarial review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the merged report verbatim to the user.

Execution rules:
- A parallel review runs several concurrent Codex turns and costs roughly
  shard-count × the tokens of a single review. Before launching, check the
  scope with `git diff --shortstat <base>...HEAD` (or `git diff --shortstat`
  for working-tree scope) and confirm with the user once if they have not
  already accepted the cost in this conversation.
- Always run the command in a Claude background task; a full run takes
  several minutes end-to-end:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" parallel-review <arguments>`
- If the user names concrete invariants the change must uphold (contracts,
  behaviors that must not regress), write them to a temp file first and pass
  `--invariants-file <path>` — every shard receives the full list.
- While it runs, `/codex:status` shows the orchestrator plus its shard tasks;
  `/codex:cancel <job-id>` on the orchestrator cancels everything it spawned.
- When it finishes, present the merged report as-is: ranked findings with
  their verification tags and origin shards, the disproven list, any unparsed
  shard warnings, and the wall-time table.
