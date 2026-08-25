
---
description: Plan and start a Claude-managed read-only Multi-Codex orchestration
argument-hint: '<repository task>'
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*)
---

Use the `codex-orchestration` skill as the binding policy.

Inspect only enough repository context to identify genuinely independent read-only work packages, their dependencies, models, efforts, and acceptance criteria. Phase 1 rejects writer packages.

Create canonical plan JSON in a collision-safe temporary file. Before execution, show a compressed 3–6 line plan including package roles, model/effort, parallelism, budget, and the fact that no external actions are authorized. Do not wait for approval for this local read-only run.

Start it with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration/cli.mjs" start --cwd "$PWD" --plan-file "<absolute-plan-path>"
```

Delete the temporary plan file after the command returns. Report only that the orchestration was accepted or started; never claim queued work has completed. Preserve the orchestration ID and status/result/cancel commands verbatim.

User objective:
$ARGUMENTS
