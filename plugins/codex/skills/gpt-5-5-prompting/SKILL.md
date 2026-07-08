---
name: gpt-5-5-prompting
description: Internal guidance for composing Codex and GPT-5.5 prompts for coding, review, diagnosis, and research tasks inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-5.5 Prompting

Use this skill when `codex:codex-rescue` needs to ask Codex or another GPT-5.5-based workflow for help. Source of truth is OpenAI's GPT-5.5 prompt guidance and migration guide (developers.openai.com); this skill captures the rules that matter inside the Codex Claude Code plugin.

GPT-5.5 reasons more efficiently than GPT-5.4 and pays a real cost for noisy, process-heavy prompts. Default to short, outcome-first prompts. Add structure only where it changes correctness, safety, or output usability. The XML-tag block library in `references/` is still available but should be applied selectively, not stacked.

## Core rules

- **Outcome over process.** Define the destination and success criteria; let GPT-5.5 choose the path. Do not transcribe every step you would take yourself. Process-heavy stacks written for older models add noise, narrow the search space, and push toward mechanical answers.
- **One clear task per Codex run.** Split unrelated asks into separate runs. Use `task --resume-last` for true follow-ups; send only the delta unless the direction changed materially.
- **Reserve absolutes for invariants.** Use `must`, `never`, `only` for safety rules, required output fields, or actions that genuinely cannot happen. For judgment calls write decision rules ("if X, prefer Y") so the model can balance trade-offs.
- **Anchor claims to evidence.** If something is a hypothesis, label it. Add explicit grounding rules for review, research, or any task where unsupported guesses would hurt quality.
- **Tighten the prompt before raising effort.** Better contracts beat more reasoning tokens.

## Reasoning effort and verbosity

- GPT-5.5 reaches strong results with fewer reasoning tokens than GPT-5.4 at the same effort level (`--effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`). Start lower than you would have on 5.4 and only escalate when the prompt is already tight and the result is still wrong. Higher effort is not automatically better; it can cause overthinking. In rescue flows, leave `--effort` unset unless the user asks.
- GPT-5.5's low-verbosity output is proportionally more concise than GPT-5.4's. Prefer asking for concise output over baking detailed length rules into every prompt.

## Recommended prompt skeleton

Use this shape as the default. Drop sections that don't add value for the run; keep each section short.

```
Role: <one or two sentences: model's function and context>

# Personality
<short tone cue: directness, warmth, formality>

# Collaboration style
<when to ask vs assume, how proactive to be, how to handle uncertainty>

# Goal
<user-visible outcome>

# Success criteria
<what must be true before the final answer>

# Constraints
<policy, safety, scope, evidence, side-effect limits>

# Output
<sections, length, tone>

# Stop rules
<when to retry, fall back, abstain, ask, or stop>
```

Do not also wrap each section in XML unless the prompt feeds a downstream parser — the headers are enough. Keep Personality and Collaboration style brief; they never substitute for clear goals, tool rules, or stopping conditions.

## What to remove when migrating an old prompt

Treat GPT-5.5 as a new model family, not a drop-in upgrade. Start from a fresh minimal baseline instead of carrying the 5.4 stack forward, and delete:

- Step-by-step process guidance, unless the exact path genuinely matters.
- Inline output schema definitions — use structured outputs instead.
- The current date — the model already knows it.
- Any instruction that exists only because an older model needed it. If a line is not changing behavior on 5.5, cut it.

## When to add the XML blocks from `references/prompt-blocks.md`

Treat them as opt-in modules, not a default stack:

- **Coding or debugging.** Add `completeness_contract` and `verification_loop` only if there is a real risk of stopping early. Add `missing_context_gating` only if a missing fact would change correctness or be irreversible.
- **Review or adversarial review.** Prefer the built-in `review` / `adversarial-review` commands — they already carry the contract. Add `grounding_rules` and `dig_deeper_nudge` only when the default contract is not enough.
- **Research or recommendation tasks.** Add `research_mode` and `citation_rules` so claims stay sourced.
- **Write-capable tasks.** Add `action_safety` so Codex stays narrow and avoids unrelated refactors.

If a block is not changing behavior on GPT-5.5, remove it. Stacking blocks pushes the model toward mechanical answers.

## Stopping conditions and retrieval budgets

- Make stopping explicit when the task is multi-step or tool-heavy: state when Codex should stop, retry, fall back, or ask. After each tool result the prompt should let Codex ask "Can I answer the core request now, with evidence?" — and answer if yes.
- For retrieval-heavy work, set a budget: one broad search first; another retrieval call only if the top results miss the core question, a required fact is absent, the user asked for exhaustive coverage, or an important claim would otherwise go unsupported. Do not re-search merely to polish phrasing.

## Validation defaults

- Coding tasks: after changes, run the smallest useful validation — targeted unit tests, type/lint checks, build for affected packages, or a minimal smoke test when full validation is too expensive. If validation is impossible, say why and name the next best check.
- Visual artifacts: render before finalizing; inspect for clipping, spacing, and missing content; revise until the rendered output matches.
- Implementation plans: list requirements with where each is addressed, named resources/files/APIs, state transitions, validation commands, failure behavior, and open questions that materially affect implementation.

## Preamble for tool-heavy runs

If Codex will make multiple tool calls before answering, instruct it to send a short (1–2 sentence) user-visible acknowledgement and first-step statement before the first tool call. This keeps perceived responsiveness up without padding the final answer.

## Choosing the entry point

- Use built-in `review` or `adversarial-review` commands when the job is reviewing local git changes. Those prompts already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Use `task --resume-last` for follow-up instructions on the same Codex thread. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

## Prompt assembly checklist

1. Write `Goal` and `Success criteria` first. If you cannot, the task is not ready to send.
2. Add `Constraints` and `Stop rules` only where defaults would fail.
3. Decide whether Codex should keep going by default or stop for missing high-risk details.
4. Pull in XML blocks from `references/prompt-blocks.md` only where they change behavior.
5. Delete anything that is process narration or duplicates the model's defaults before sending.

Reusable blocks (opt-in) live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md). The biggest GPT-5.5-specific anti-pattern is carrying a GPT-5.4 process-heavy stack forward verbatim.
