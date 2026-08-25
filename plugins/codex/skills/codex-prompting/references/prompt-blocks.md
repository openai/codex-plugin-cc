# Prompt Blocks

Use only the blocks that materially clarify the task. A lean prompt with three precise blocks is usually better than a long template containing every block.

## `task`

```xml
<task>
Describe the concrete job, the relevant repository or failure context, and the expected end state.
</task>
```

## `done_when`

```xml
<done_when>
List the observable conditions that must be true before the task is complete.
</done_when>
```

## `action_policy`

```xml
<action_policy>
For requested local changes, edit only in-scope files and run relevant non-destructive checks without asking first.
Require confirmation before external writes, destructive actions, credential changes, publication, or material scope expansion.
</action_policy>
```

## `verification`

```xml
<verification>
Verify the result against the task requirements and the changed files or tool outputs before finalizing.
If a check fails, fix the issue and rerun the relevant check.
</verification>
```

## `grounding`

```xml
<grounding>
Ground factual claims in repository content or tool evidence.
Label hypotheses and unresolved uncertainty explicitly.
</grounding>
```

## `output_contract`

```xml
<output_contract>
Return the requested structure with the highest-value findings or decisions first.
Include all required evidence and verification results without repeated recap.
</output_contract>
```

## `missing_context`

```xml
<missing_context>
Retrieve missing local context with available tools.
Ask only when a missing fact materially changes correctness, safety, or an irreversible action.
</missing_context>
```

## `scope_safety`

```xml
<scope_safety>
Keep changes tightly scoped to the request.
Avoid unrelated refactors, renames, or cleanup unless required for correctness.
</scope_safety>
```
