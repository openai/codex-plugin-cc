---
description: Hand a DESIGN to Codex (a second model family) for an independent critique with full read access to the code AND the live database
argument-hint: "[--background|--wait] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--focus \"what to scrutinize\"] <design-doc path, or the design to critique>"
allowed-tools: Bash(node:*), Agent
---

Invoke the `codex:codex-critique` subagent via the `Agent` tool (`subagent_type: "codex:codex-critique"`), forwarding the raw user request as the prompt.
`codex:codex-critique` is a subagent, not a skill — do not call `Skill(codex:codex-critique)` (no such skill) or `Skill(codex:critique)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

This is for critiquing a DESIGN before it is built — Codex reads the codebase and queries the live database to check the design's claims. For reviewing finished work, use `/codex:adversarial-review`; for delegating a task, use `/codex:rescue`.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-critique` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-critique` subagent in the foreground.
- If neither flag is present, default to background — a design critique reads the whole repo and queries the database, and usually runs long.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `critique`, and do not treat them as part of the design text.
- `--model`, `--effort`, and `--focus` are runtime-selection flags. Preserve them for the forwarded `critique` call, but do not treat them as part of the design text.
- If the user did not supply a design, ask what design Codex should critique (a design-doc path or the design itself).
