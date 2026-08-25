
---
name: codex-orchestration-recovery
description: Internal Phase 1 recovery and durable-result policy
user-invocable: false
---
Durable status and terminal results remain readable without a live controller. A live controller may be reconnected to for status or cancellation. Phase 1 does not automatically resume orphaned packages; report controller loss honestly and preserve available results. Automatic restart/resume and orphan reconciliation are Phase 3.
