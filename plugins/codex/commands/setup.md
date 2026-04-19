---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.

After setup completes successfully (Codex installed and authenticated):
- Use `AskUserQuestion` to ask whether the user wants to configure agent models now.
- Use these two options:
  - `Configure agent models`
  - `Skip for now`
- If the user chooses to configure, run the agent config flow:

**Agent config flow:**

1. Get available models:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/patch-agents.mjs" available-models --json
```

2. List current agents:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/patch-agents.mjs" list --json
```

3. If there are many agents (>10), use `AskUserQuestion` first:
  - `Configure all agents one by one`
  - `Select specific agents to configure`
  - `Skip`
- If user picks "Select specific", list agent names and let them pick.

4. For each agent to configure, use `AskUserQuestion` with format:
```
<agent-name> (current: <current-model>)
```
Options: all available models (mark current with `(current)`), plus `Skip` at the end.

5. For each selection that differs from current, run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/patch-agents.mjs" patch <agent-name> <model> --json
```

6. Summarize all changes made.
