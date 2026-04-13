---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a Codex rescue task. Defaults to background.

Raw user request:
$ARGUMENTS

## Resume check (foreground, fast)

If `--resume` or `--fresh` is in the request, skip this step.

Otherwise, check for a resumable thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If `available: true`: use `AskUserQuestion` once with choices `Continue current Codex thread` / `Start a new Codex thread`. Add `--resume` or `--fresh` based on choice.
- If `available: false`: continue without asking.

If the user did not supply a task description, use `AskUserQuestion` to ask what Codex should investigate or fix.

## Execution

Build the task command arguments: strip `--wait` from the forwarded args (it's an execution flag, not a Codex flag). Preserve `--resume`, `--fresh`, `--model`, `--effort` for the companion call.

- `--model`: leave unset unless user asks. Map `spark` to `gpt-5.3-codex-spark`.
- `--effort`: leave unset unless user asks.

**If `--wait` is in the request**: run in the foreground.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [flags] "the task description"
```

Return stdout verbatim.

**Otherwise (default)**: launch in background immediately.

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [flags] "the task description"`,
  description: "Codex rescue task",
  run_in_background: true
})
```

After launching, respond with only: "Codex rescue task running in background."

## Rules

- Return Codex companion stdout verbatim. Do not paraphrase, summarize, or add commentary.
- Do not ask the subagent to inspect files, monitor progress, or do follow-up work.
- If the helper reports Codex is missing or unauthenticated, tell user to run `/codex:setup`.
