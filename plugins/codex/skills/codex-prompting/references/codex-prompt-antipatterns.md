# Codex Prompt Anti-Patterns

## Repeating the same rule

Bad: repeat approval, scope, or verification rules in several sections.

Better: state each policy once in the most relevant block.

## Prescribing every step

Bad: enumerate a long procedure when the desired outcome and constraints are sufficient.

Better: specify the goal, hard constraints, success criteria, and required evidence; let Codex choose routine implementation steps.

## Vague completion

Bad: `Look into this and report back.`

Better:

```xml
<done_when>
Identify the root cause, cite evidence, and state the smallest safe next step.
</done_when>
```

## Generic reasoning nudges

Bad: `Think harder. Be extremely smart.`

Better:

```xml
<verification>
Check the result against observed evidence and the task requirements before finalizing.
</verification>
```

## Silent scope expansion

Bad: turn a diagnosis request into an implementation or broad refactor.

Better: preserve the requested action boundary and require explicit authorization for a material expansion of scope.

## Mixing unrelated work

Bad: combine review, implementation, documentation, and roadmap creation in one rescue run.

Better: keep one coherent objective per run and use a follow-up turn or separate task for independent work.

## Hardcoding model behavior

Bad: assume a specific model or effort is available because it was supported by one Codex release.

Better: leave model and effort unset unless requested and let the companion validate explicit combinations against the current model catalog.
