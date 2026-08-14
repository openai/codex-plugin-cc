---
description: Show the stored result for a finished Codex job in this repository
argument-hint: '[job-id] [--full]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Reviews and consults answer with the bounded result envelope: status, verdict, severity tally, summary, findings preview, and the paths where the complete log and final answer are stored. Tasks answer with their stored output as before.

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, severity tally, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

If the user needs the complete text rather than the envelope, rerun with `--full`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <job-id> --full
```

`--json` returns the same envelope as JSON. A `verdict` of `inconclusive` means the run timed out, failed to launch, or returned output that could not be parsed. Never report it as an approval.
