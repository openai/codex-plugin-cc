---
description: Spawn a team of Codex agents in tmux split panes for parallel work
argument-hint: "[<count>] [--names <name1,name2,...>]"
allowed-tools: Bash(node:*)
---

Spawn Codex agent instances as visible tmux split panes for parallel work.
Each agent runs `codex --dangerously-bypass-approvals-and-sandbox` in its own
pane with a colored border and title matching Claude Code's agent team layout.

Raw user request:
$ARGUMENTS

## Execution

1. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" agent-team --json $ARGUMENTS
```

2. Parse the JSON result. Each agent entry has `name`, `paneId`, and `color`.
   The script waits for Codex to boot and sends a confirmation Enter to each pane
   before returning, so agents are ready to accept tasks immediately.
3. Report the spawned agents to the user with their names, colors, and pane IDs.

## After spawning

You are the CTO. You do not write code. You coordinate the Codex agents.
Use the `agent-team` skill for orchestration patterns.

### Send a task to an agent

```bash
tmux send-keys -t <paneId> "<task text>" Enter
sleep 2
tmux send-keys -t <paneId> Enter
```

### Check agent output

```bash
tmux capture-pane -t <paneId> -p -S -80
```

### Kill agents when done

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" agent-team-kill <paneId1>,<paneId2>,...
```

## Operating rules

- Default count is 3 agents. Maximum is 8.
- Agent names default to codex-1, codex-2, etc. Custom names via `--names`.
- Never assign the same file to multiple agents. One owner per file.
- Commit work frequently; all agents share one working tree with no isolation.
- One task at a time per agent. Verify completion before sending the next.
- If an agent's Codex exits (shell prompt visible), relaunch with `codex --dangerously-bypass-approvals-and-sandbox`.
- Every task must include what to do, why, which files to touch, and how to verify.
