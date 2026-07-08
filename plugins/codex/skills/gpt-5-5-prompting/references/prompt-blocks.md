# Prompt Blocks

Opt-in blocks for Codex / GPT-5 prompts. On GPT-5.5, apply these selectively — pull in a block only when it changes behavior for the run, and never stack them by default. Start from the outcome-first skeleton in SKILL.md; most runs need zero or one block.
Wrap each block in the XML tag shown in its heading.

## Core Wrapper

### `task`

Use when the prompt feeds a downstream parser or you need a stable wrapper. On GPT-5.5 the plain `# Goal` / `# Success criteria` headers from the skeleton usually suffice.

```xml
<task>
Describe the concrete job, the relevant repository or failure context, and the expected end state.
</task>
```

## Output and Format

### `structured_output_contract`

Use when the response shape matters.

```xml
<structured_output_contract>
Return exactly the requested output shape and nothing else.
Keep the answer compact.
Put the highest-value findings or decisions first.
</structured_output_contract>
```

### `compact_output_contract`

Use when you want concise prose instead of a schema. On GPT-5.5, consider `text.verbosity: low` instead.

```xml
<compact_output_contract>
Keep the final answer compact and structured.
Do not include long scene-setting or repeated recap.
</compact_output_contract>
```

## Follow-through and Completion

### `default_follow_through_policy`

Use when Codex should act without asking routine questions.

```xml
<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
Only stop to ask questions when a missing detail changes correctness, safety, or an irreversible action.
</default_follow_through_policy>
```

### `completeness_contract`

Use for debugging, implementation, or any multi-step task with a real risk of stopping early.

```xml
<completeness_contract>
Resolve the task fully before stopping.
Do not stop at the first plausible answer.
Check whether there are follow-on fixes, edge cases, or cleanup needed for a correct result.
</completeness_contract>
```

### `verification_loop`

Use when correctness matters.

```xml
<verification_loop>
Before finalizing, verify the result against the task requirements and the changed files or tool outputs.
If a check fails, revise the answer instead of reporting the first draft.
</verification_loop>
```

## Grounding and Missing Context

### `missing_context_gating`

Use only when a missing fact would change correctness or trigger an irreversible action.

```xml
<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, retrieve it with tools or state exactly what remains unknown.
</missing_context_gating>
```

### `grounding_rules`

Use for review, research, or root-cause analysis.

```xml
<grounding_rules>
Ground every claim in the provided context or your tool outputs.
Do not present inferences as facts.
If a point is a hypothesis, label it clearly.
</grounding_rules>
```

### `citation_rules`

Use when external research or quotes matter.

```xml
<citation_rules>
Back important claims with citations or explicit references to the source material you inspected.
Prefer primary sources.
</citation_rules>
```

## Safety and Scope

### `action_safety`

Use for write-capable or potentially broad tasks.

```xml
<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors, renames, or cleanup unless they are required for correctness.
Call out any risky or irreversible action before taking it.
</action_safety>
```

### `tool_persistence_rules`

Use for long-running tool-heavy tasks. Pair with an explicit retrieval budget or stop rule so persistence does not turn into over-searching.

```xml
<tool_persistence_rules>
Keep using tools until you have enough evidence to finish the task confidently.
Do not abandon the workflow after a partial read when another targeted check would change the answer.
</tool_persistence_rules>
```

## Task-Specific Blocks

### `research_mode`

Use for exploration, comparisons, or recommendations.

```xml
<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Prefer breadth first, then go deeper only where the evidence changes the recommendation.
</research_mode>
```

### `dig_deeper_nudge`

Use for review and adversarial inspection.

```xml
<dig_deeper_nudge>
After you find the first plausible issue, check for second-order failures, empty-state behavior, retries, stale state, and rollback paths before you finalize.
</dig_deeper_nudge>
```

### `progress_updates`

Use when the run may take a while. On GPT-5.5 also consider a tool preamble: a 1–2 sentence user-visible acknowledgement before the first tool call.

```xml
<progress_updates>
If you provide progress updates, keep them brief and outcome-based.
Mention only major phase changes or blockers.
</progress_updates>
```
