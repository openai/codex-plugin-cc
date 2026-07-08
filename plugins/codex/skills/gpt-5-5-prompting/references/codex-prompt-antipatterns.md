# Codex Prompt Anti-Patterns

Avoid these when prompting Codex or GPT-5-family models.

## GPT-5.5-specific anti-patterns

### Carrying a GPT-5.4 prompt stack forward verbatim

Bad: pasting an old prompt full of step-by-step process rules, stacked XML blocks, and defensive instructions into a GPT-5.5 run.

Better: start from a fresh outcome-first skeleton (Goal, Success criteria, Constraints, Output, Stop rules). The old instructions still get obeyed — you pay for tokens that no longer help and narrow the model's search space.

### Over-specified process instructions

Bad:

```text
First inspect file A, then run the tests, then check B, then compare with C, then write the answer in this exact order...
```

Better: state the outcome and success criteria; let the model choose the path. Script the exact steps only when the product genuinely requires that path.

### Overusing absolutes

Bad: `ALWAYS`, `NEVER`, `must`, `only` sprinkled across judgment calls.

Better: reserve absolutes for true invariants (safety rules, required output fields, irreversible actions). For judgment calls, write decision rules: "if X, prefer Y."

### Restating what the model already knows

Bad: including the current date, inline output schema definitions, or boilerplate carried from older models.

Better: the model knows the UTC date; use Structured Outputs for schemas; delete any line that is not changing behavior.

## General anti-patterns

### Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

### Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

### No follow-through default

Bad:

```text
Debug this failure.
```

Better:

```xml
<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
</default_follow_through_policy>
```

### Asking for more reasoning instead of a better contract

Bad:

```text
Think harder and be very smart.
```

Better:

```xml
<verification_loop>
Before finalizing, verify that the answer matches the observed evidence and task requirements.
</verification_loop>
```

Raising `reasoning.effort` belongs last, after the contract is tight — and only when evals show it helps.

### Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.

### Unsupported certainty

Bad:

```text
Tell me exactly why production failed.
```

Better:

```xml
<grounding_rules>
Ground every claim in the provided context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```
