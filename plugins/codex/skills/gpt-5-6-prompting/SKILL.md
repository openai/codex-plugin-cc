---
name: gpt-5-6-prompting
description: Internal guidance for composing lean, outcome-first Codex prompts for the GPT-5.6 Sol, Terra, and Luna models during coding, review, diagnosis, research, and implementation handoffs inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-5.6 Prompting

Use this skill only to shape the prompt that `codex:codex-rescue` forwards to Codex. Do not inspect the repository or solve the task while drafting the prompt.

## Core posture

Write the leanest prompt that preserves the requested outcome, hard constraints, approval boundaries, evidence requirements, and completion bar. GPT-5.6 understands intent well; avoid prescribing routine steps or repeating the same rule.

Always:

- Preserve the user's task, scope, model choice, and requested output.
- State the user-visible outcome and what must be true before Codex finishes.
- Distinguish read-only work from authorized implementation.
- Require relevant validation for changes and evidence for diagnosis or review.
- Let Codex choose the execution path unless tool routing, safety, or ordering changes correctness.
- Keep one coherent task per run; split unrelated outcomes.
- Never request hidden reasoning, chain-of-thought, or generic "think harder" behavior.

## Select the model profile

Read [references/model-profiles.md](references/model-profiles.md) whenever the request names `sol`, `terra`, `luna`, a full GPT-5.6 model ID, or asks which GPT-5.6 variant fits the task. Do not silently substitute one model for another.

- Sol: optimize for difficult, quality-first coding, review, security, research, or long-horizon work.
- Terra: optimize for balanced everyday implementation, debugging, and review.
- Luna: optimize for bounded, latency-sensitive, or high-volume tasks with a crisp contract.

If no model is specified, do not choose one in the prompt. The runtime or Codex configuration owns the default.

## Shape the prompt

For a simple, bounded request, use compact prose with:

1. Goal and relevant context.
2. Success criteria or required output.
3. Only the constraints and validation rules that change behavior.

For a complex, risky, or tool-heavy request, use a small number of descriptive XML blocks from [references/prompt-blocks.md](references/prompt-blocks.md). XML is optional structure, not a default requirement.

Add only what the task needs:

- Implementation or debugging: success criteria, authorization boundary, verification, and missing-context handling.
- Review: target, materiality threshold, evidence requirement, and output order.
- Research: source requirements, fact/inference separation, and stopping condition.
- Write-capable work: narrow scope and confirmation boundaries for destructive or external actions.
- Long-running work: sparse outcome-based progress updates.

## Handoff rules

- Use built-in `review` or `adversarial-review` for local Git or Yandex Arc review.
- Use `task` for diagnosis, planning, research, or implementation.
- For a resumed thread, forward only the delta unless the objective or constraints changed materially.
- Do not encode `--model`, `--effort`, `--resume`, `--fresh`, `--wait`, or `--background` inside the natural-language prompt.
- Do not increase reasoning effort as a substitute for a missing success criterion, evidence rule, or validation step.
- Preserve explicit runtime choices. GPT-5.6 supports `none`, `low`, `medium`, `high`, `xhigh`, and `max`; the forwarding layer decides whether to pass one.

Prompt assembly checklist:
1. Preserve the user's concrete task and selected model.
2. State the outcome and completion bar.
3. Add only material scope, safety, evidence, and validation constraints.
4. Select the matching Sol, Terra, or Luna profile when named.
5. Remove repeated or routine process instructions before forwarding.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
