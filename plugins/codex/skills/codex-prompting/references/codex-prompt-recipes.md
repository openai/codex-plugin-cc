# Codex Prompt Recipes

Use these as starting points. Keep only the blocks that the task actually needs.

## Diagnosis

```xml
<task>
Diagnose why the specified test, command, or behavior is failing in this repository.
Identify the root cause from repository and tool evidence.
</task>

<done_when>
The root cause, supporting evidence, and smallest safe next step are explicit.
</done_when>

<grounding>
Do not guess missing repository facts. Label hypotheses until evidence confirms them.
</grounding>

<verification>
Check that the proposed root cause explains the observed failure and relevant surrounding behavior.
</verification>
```

## Narrow fix

```xml
<task>
Implement the smallest safe fix for the identified issue while preserving behavior outside the failing path.
</task>

<done_when>
The fix is applied, relevant tests or checks pass, and residual risks are reported.
</done_when>

<action_policy>
Make the requested in-scope local edits and run non-destructive validation without asking first.
Stop before external or destructive actions.
</action_policy>

<scope_safety>
Avoid unrelated refactors or cleanup.
</scope_safety>
```

## Adversarial analysis

```xml
<task>
Challenge this implementation or design for material correctness, regression, reliability, security, and rollback risks.
</task>

<grounding>
Tie every finding to repository or tool evidence. Separate facts from inference.
</grounding>

<output_contract>
Return actionable findings in severity order, with evidence and a specific mitigation for each.
</output_contract>

<verification>
Check second-order failures, empty states, concurrency, retries, stale state, and rollback paths before finalizing.
</verification>
```

## Research or recommendation

```xml
<task>
Research the available options and recommend the best path for the stated decision.
</task>

<grounding>
Separate observed facts, reasoned inference, and unresolved questions. Prefer primary sources.
</grounding>

<output_contract>
Return the recommendation first, then decisive evidence, tradeoffs, and conditions that would change it.
</output_contract>
```

## Prompt repair

```xml
<task>
Diagnose why the supplied prompt underperforms and produce the smallest revision that addresses the demonstrated failure modes.
</task>

<done_when>
The failure modes are traced to specific prompt clauses and the revised prompt removes contradiction, duplication, or missing boundaries.
</done_when>

<verification>
Check that the revision preserves the original intent and does not add unnecessary instructions.
</verification>
```
