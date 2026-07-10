# Model and Effort Policy

This is the authoritative policy for Fable-owned routing of fresh
`/codex-relay:rescue` work. Apply it only in the main Claude/Fable context.
Never apply it to a resume, including `--resume`, `--resume-last`, or
`--resume-id`; preserve the thread's original model and effort defaults and
forward only explicit user overrides.

## Override table

| User input | Routing action |
| --- | --- |
| Explicit model and effort | Preserve both; do not classify. |
| Explicit model only | Preserve the model; classify and fill only effort. |
| Explicit effort only | Preserve the effort; classify and fill only model. |
| Neither explicit | Classify and fill both model and effort. |

## Fresh-task mapping

| Classification | Model | Effort |
| --- | --- | --- |
| Small and bounded | gpt-5.6-luna | low |
| Normal and bounded | gpt-5.6-terra | medium |
| Broad, ambiguous, or high-value | gpt-5.6-sol | high |
| Architectural, high-risk, or unusually difficult | gpt-5.6-sol | xhigh |

`max` is explicit-only and must never be selected automatically. `ultra` is
not a valid effort value.

If Fable cannot decide a missing value from the available task information,
leave that value unset so the upstream runtime default applies. Do not query a
model catalog and do not substitute fallback model names.
