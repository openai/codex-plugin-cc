---
name: gpt-5-6-routing
description: Select a GPT-5.6 model and reasoning effort for a fresh Codex rescue task.
user-invocable: false
---

# GPT-5.6 Routing

Apply this procedure only in the main Claude/Fable context for fresh
`/codex-relay:rescue` work. Never route resumed work.

1. Read `references/complexity-rubric.md` and
   `references/model-effort-policy.md` before routing.
2. If a classification boundary is unclear, also read
   `references/routing-examples.md`.
3. Classify only values the user did not provide, then return the corresponding
   model and/or effort flags without changing the prompt text.
4. If the references do not support a decision for a missing value, leave that
   value unset.
