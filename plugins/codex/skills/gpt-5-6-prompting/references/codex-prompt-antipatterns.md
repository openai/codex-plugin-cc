# Codex Prompt Anti-Patterns

Avoid these when prompting Codex or GPT-5.6.

## Vague task framing

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

## Missing output contract

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

## No follow-through default

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

## Asking for more reasoning instead of a better contract

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

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.

## Repeating the same rule across blocks

Bad:

```text
<completeness_contract>Verify before finishing.</completeness_contract>
<verification_loop>Verify before finalizing.</verification_loop>
<task>... and verify everything at the end.</task>
```

Better:
- State the rule once, in the one block that owns it. GPT-5.6 tries to reconcile repeated or conflicting instructions and spends reasoning tokens doing it.

## Blanket brevity orders

Bad:

```text
Be concise. Keep it short. No fluff.
```

Better:
- GPT-5.6 is more concise by default than earlier 5.x models; blanket brevity orders under-deliver detail. Specify the output shape you want, or leave length alone.

## Unsupported certainty

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
