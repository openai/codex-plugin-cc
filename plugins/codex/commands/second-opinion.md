---
description: Run the Codex (GPT) second-opinion advisor on demand — reviews the latest approved plan or built-in advisor verdict
argument-hint: "[--force] [optional focus note]"
allowed-tools: Bash(node:*)
---

Run the codex-advisor script exactly once and surface its opinion:

- Default: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-advisor.mjs"` (Bash timeout ~420000ms). It reviews the most recent built-in advisor verdict in this session's transcript.
- The script enforces its own limits: up to 60s waiting for the global Codex queue slot, then a 300000ms execution deadline. Keep the outer Bash timeout above that sum so the script's own normalized message is what you see.
- If this session has no built-in advisor verdict but does have a plan (approved or drafted), write that plan text verbatim to a temp file and add `--plan-file <path>` so the script reviews the plan instead.
- If the user passed `--force`, prefix the command with `CODEX_ADVISOR_FORCE=1 ` to bypass the one-opinion-per-subject dedup.
- If the user added a focus note, mention it when weighing the opinion — the script itself takes no free-text input.
- If it prints `[codex-advisor] …skipping` or `…unavailable`, report that line verbatim and stop.
- The final user-visible response must include Codex's opinion verbatim, followed by your own brief assessment of where you agree or disagree.

Note: approved plans normally get this opinion automatically via the ExitPlanMode hook — this command is for re-runs (`--force`), drafted-but-unapproved plans, and advisor verdicts.
