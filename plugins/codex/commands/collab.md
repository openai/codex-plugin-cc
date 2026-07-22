---
description: Drive the Claude/Codex peer-collaboration loop — assign issues to parallel worktrees, run Codex, cross-review, and merge
argument-hint: "[assign|run|handoff|review|merge|status|conflicts] [issue-slug] [free text]"
allowed-tools: Bash(node:*), Bash(git:*), Read, Grep, Glob, AskUserQuestion, PushNotification
---

Drive the collaboration runtime at `${CLAUDE_PLUGIN_ROOT}/scripts/collab.mjs` (run every subcommand as `node "${CLAUDE_PLUGIN_ROOT}/scripts/collab.mjs" <command> ...`).

Raw user request:
`$ARGUMENTS`

Subcommands: `init` · `assign --agent <codex|claude> --issue <slug> [--title <t>]` · `post` · `inbox --for <agent> [--peek]` · `claim` · `conflicts` · `run --issue <slug> --prompt <text> [--effort <level>]` · `handoff --issue <slug> [--summary <t>]` · `merge --issue <slug>` · `status`.

Operating rules:

- You are the orchestrator and the claude-side worker. Codex work goes through `run`, which executes in the issue's worktree with the shared workspace writable and the collaboration protocol prepended to the prompt. `run` is synchronous — use a background Bash call for long tasks.
- Claude-side issues: do your own work inside the issue's worktree (never the main checkout), claim paths before touching shared surface, and post grounded `status` messages at milestones.
- Check the inbox (`inbox --for claude`) at every loop boundary: after each `run` completes, after finishing your own work step, and before `handoff` or `merge`. Act on questions before continuing.
- Cross-review is mandatory and capped at 2 review/fix cycles per issue: Codex-authored issues are reviewed by you (read the diff in the worktree: `git diff <base>...HEAD`); Claude-authored issues are reviewed by Codex via `run` with a report-only review prompt. Post the verdict as a `review` message — body must start with `approve` to unlock `merge`, otherwise list the findings.
- Disagreements: exactly one `rebuttal` round. Still contested → post a `decision`-type message with both positions and a recommended default (this lands in decisions.md), then surface it to Giordano: `AskUserQuestion` when interactive, `PushNotification` when running unattended. Trivial disagreements resolve toward the reviewer.
- `merge` enforces the approval gate and cleans up the worktree and branch. After merging, check `conflicts` — a claim overlap with a still-active issue means the other agent must rebase before its handoff.
- Every handoff and `run` prints a pick-up line (`cd <worktree> && codex resume <session-id>`) — always show it to Giordano so he can take over any thread himself.
