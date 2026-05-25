---
description: Fan a task out to several Chinese model backends in parallel, then review their outputs together
argument-hint: '[--models <a,b:profile,c>] [--all] [--timeout <sec>] [--json] [--] <task description>'
allowed-tools: Bash(node:*)
---

Fan one task out to several Chinese model backends in parallel through the companion
script, then collect every backend's output for a single unified review.

This is the elastic CN "pool" in a larger review/frontend/backend triangle: the
orchestrator hands supplementary or cross-check work to multiple backends at once and
synthesizes the results.

Raw slash-command arguments:
`$ARGUMENTS`

Member selection:
- Default pool when no `--models`/`--all` is given: `qwen, glm, kimi`
  (coder · Chinese reasoning · long-context — deliberately complementary).
- `--models qwen:token,glm:max,kimi` pins a profile per member with `model:profile`.
- `--all` runs every registered backend. Use sparingly; it costs one run per model.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cn-companion.mjs" team $ARGUMENTS
```

Result handling:
- Present each backend's section as-is, tagged `[cn:<model>]`, preserving code and
  Chinese text verbatim. Do not paraphrase a backend's answer.
- After the sections, add a short synthesis: where the backends agree, where they
  differ, and your recommended pick with reasons. Do not silently merge them into one
  blended answer that hides which backend said what.
- If a backend was skipped because it was unavailable, say so and point to `/cn:setup`.
- If a backend failed or returned nothing, report it and stop. Do not solve the task
  yourself as a fallback.
- For picking the right members per task, defer to the `cn-routing` matrix instead of
  always using the default pool.
