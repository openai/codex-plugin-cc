---
description: Generate an image by handing a craft-grade prompt to Codex through the shared runtime so Codex can call its native image generation tool
argument-hint: "[--background|--wait] [--model <model|spark>] [--out <path>] [what you want the image to show]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-image` subagent via the `Agent` tool (`subagent_type: "codex:codex-image"`), forwarding the raw user request as the prompt.
`codex:codex-image` is a subagent, not a skill — do not call `Skill(codex:codex-image)` (no such skill) or `Skill(codex:image)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-image` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-image` subagent in the foreground.
- If neither flag is present, default to foreground. Most single-image generations finish in well under a minute.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language image intent.
- `--model` is a runtime-selection flag for the Codex side (the model that drives the image generation tool). Preserve it for the forwarded `task` call, but do not treat it as part of the image intent.
- `--out` is an optional absolute path for the saved PNG. If omitted, Codex uses its native generated_images directory and prints the absolute path. Preserve `--out` for the subagent.

Operating rules:

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write ...` and returns that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect the repository, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, or do follow-up work of its own.
- Leave model unset on the Codex side unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- This command is write-capable on the Codex side because Codex needs to save the resulting PNG to disk and optionally copy it to the user's `--out` path. Always pass `--write`.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply an image intent, ask what the image should show.
