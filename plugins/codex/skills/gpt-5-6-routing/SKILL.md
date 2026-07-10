---
name: gpt-5-6-routing
description: Select a GPT-5.6 model and reasoning effort for a fresh Codex rescue task.
user-invocable: false
---

# GPT-5.6 Routing

Apply this policy only to fresh /codex-relay:rescue work. Never automatically route a resumed thread.

Respect user overrides:

- Explicit model and effort: preserve both.
- Explicit model only: preserve the model and select only the effort.
- Explicit effort only: preserve the effort and select only the model.
- Neither explicit: select both.

Evaluate task breadth and affected components, ambiguity and repository exploration,
implementation or diagnosis depth, reversibility and risk, required verification,
and whether the work is tightly bounded or needs a long autonomous run.

Classify only the missing values:

| Task class | Model | Effort |
| --- | --- | --- |
| Small and bounded | gpt-5.6-luna | low |
| Normal and bounded | gpt-5.6-terra | medium |
| Broad, ambiguous, or high-value | gpt-5.6-sol | high |
| Architectural, high-risk, or unusually difficult | gpt-5.6-sol | xhigh |

Use the higher tier when a fresh task falls between two tiers or is ambiguous. When a fresh task is ambiguous, choose the higher tier. Never select max automatically; max is explicit-only. ultra is not an effort value.

If Fable cannot decide a missing value from the available task information, leave that value unset so the upstream runtime default applies. Do not query a model catalog and do not substitute fallback model names.
