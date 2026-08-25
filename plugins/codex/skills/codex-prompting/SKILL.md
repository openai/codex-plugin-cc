---
name: codex-prompting
description: Version-neutral guidance for composing Codex prompts for coding, review, diagnosis, planning, and research tasks
user-invocable: false
---

# Codex Prompting

Use this skill only when `codex:codex-rescue` needs to make a user's request easier for Codex to execute. It shapes the prompt; it does not inspect the repository, solve the task, or choose a model unless the user explicitly requested one.

## Core guidance

- Favor lean, outcome-first prompts. State the goal, relevant context, hard constraints, approval boundaries, success criteria, and required output—once each.
- Prefer one coherent task per Codex run. Split unrelated jobs into separate runs.
- Preserve the user's terminology and intent. Do not broaden scope while "improving" the prompt.
- Tell Codex what completion means and which non-destructive verification it must perform.
- Add grounding requirements when unsupported guesses would damage correctness.
- Use XML blocks only when they make boundaries clearer. Do not wrap every sentence or repeat the same policy in multiple blocks.
- Prefer a better task contract over generic instructions such as "think harder" or gratuitously raising reasoning effort.

## Autonomy and approval

Define autonomy and approval boundaries compactly:

- For explanation, review, diagnosis, planning, or research, inspect the relevant material and report the result without editing unless edits were requested.
- For an explicit build, change, or fix request, make the in-scope local changes and run relevant non-destructive checks without asking routine questions.
- Stop before external writes, destructive actions, purchases, credential changes, publication, or a material expansion of scope unless the user already authorized them.
- Ask only when a missing fact materially changes correctness, safety, or an irreversible action.

## GPT-5.6 tiers and effort

- Treat `Sol > Terra > Luna` as the base capability ordering: Sol is the frontier tier, Terra balances capability and cost, and Luna targets efficient high-volume work.
- Reasoning effort is a separate inference-budget dimension. Do not treat a higher effort on a lower tier as reversing the underlying capability ordering.
- Do not silently route models in this skill. The rescue agent leaves the model unset unless the user explicitly selects one, so Codex configuration remains authoritative.
- When explaining an explicit selection, use Sol for the hardest quality-first work, Terra for balanced everyday implementation and review, and Luna for bounded or high-volume work.
- Leave effort unset unless the user requested it. The companion runtime and current Codex model catalog are the source of truth for supported model/effort combinations.
- Improve scope and verification before escalating effort. Reserve the highest settings for tasks whose measured quality benefit justifies additional latency and usage.

## Prompt shape

Start with the smallest useful shape:

- `<task>`: the concrete job and expected end state.
- `<done_when>`: observable completion criteria.
- `<action_policy>`: what may proceed locally and what requires approval.
- `<verification>`: checks required before finalizing.
- `<grounding>`: evidence rules for review, diagnosis, or research.
- `<output_contract>`: only when the final structure matters.

For a follow-up on the same persistent Codex thread, send only the delta instruction unless the goal or constraints changed materially.

## Assembly checklist

1. Preserve the user's task and scope.
2. Remove duplicated or purely motivational instructions.
3. Add explicit completion and verification criteria where needed.
4. Add one compact approval boundary for write-capable work.
5. Keep claims grounded in repository or tool evidence.
6. Leave model and effort untouched unless explicitly requested.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
