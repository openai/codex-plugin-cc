
---
name: codex-orchestration
description: Use for an explicit Multi-Codex request or, when automatic orchestration is enabled, for repository work with multiple genuinely independent packages that meets the Complexity Score threshold
user-invocable: false
---

# Claude-native Multi-Codex orchestration

Claude Root owns decomposition, the top-level DAG, model/effort routing, and final interpretation. Do not delegate those decisions to a Codex lead. Each top-level Codex Root receives one bounded package; native children remain owned by that Root.

Before automatic entry, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration/cli.mjs" config --cwd "$PWD" --json`. Do not auto-start when `autoEnabled` is false or the score is below `autoThreshold`. Explicit `/codex:orchestrate` bypasses those two entry checks but not Phase 1 restrictions or budgets.

Hard exclusions: a one-file obvious fix; a known root cause and fix; a single command or narrow lookup; no independent packages; orchestration overhead exceeds the work; every writer would touch the same semantic core; user asks for one agent.

Complexity Score, one point each: two independent packages; multiple modules/layers/services; material architecture judgment; unclear root cause; competing approaches; independent review warranted; implementation and verification can be separated; long single-agent run; previous single-agent failure; security/concurrency/migration/data-loss risk.

0–2: direct work or one rescue. 3–4: at most two Roots. 5–7: prefer orchestration when enabled. 8–10: include a Sol architecture, plan-validation, or reviewer package.

Model defaults: Luna for bounded exploration and repetitive verification; Terra for routine implementation-quality analysis; Sol for architecture, integration judgment, ambiguity, or adversarial review. Base capability is `Sol > Terra > Luna`; reasoning effort is a separate inference-budget dimension.

Phase 1 is strictly read-only: `access` is `read-only`, workspace mode is `shared`, sandbox is read-only, changedFiles must be empty, and no package may push, publish, deploy, change credentials, or mutate a remote system. Automatic local write orchestration begins in Phase 2.

Canonical plan fields: version 1, objective, complexityScore, requestedBy `{ explicit, sessionId }`, and packages containing id, title, role `{ class, label }`, objective, dependencies, optional boolean, access, workspace, model `{ name, effort }`, nativeSubagents `{ policy, maxChildren }`, acceptanceCriteria, expectedOutputs.

Show a compressed 3–6 line plan and start immediately. Treat the launch response as acceptance only. Use `/codex:status`, `/codex:result`, and `/codex:cancel` for lifecycle. Integrate conclusions from evidence and verification, never from confidence alone.
