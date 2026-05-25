# Triangle Workflow

How `cn-cc` plugs into a multi-engine "triangle" that builds a project end to end.

## The triangle

Three primary engines, each with one job, plus an elastic pool of Chinese backends for
supplementary work.

```
        ┌──────────────────────────────────────────────┐
        │  Claude (Opus) = orchestrator + reviewer       │  integrate / gate / sign off
        └───────┬───────────────────────┬────────┬──────┘
   assign tasks │      ↑ cross-review    │        │ overflow
        ┌───────┴───────┐       ┌────────┴───┐   ┌┴───────────────────┐
        ▼               ▼       ▼            ▼   ▼                     ▼
   ┌─────────┐    ┌──────────┐         ┌──────────────────────────────┐
   │ Codex   │    │  agy     │         │  CN pool  (this repo)          │
   │ backend │    │ frontend │         │  qwen / glm / kimi / doubao /  │
   │GPT-5.x  │    │Gemini    │         │  stepfun / minimax / mimo      │
   └─────────┘    └──────────┘         └──────────────────────────────┘
   codex:rescue   agy -p               /cn:team  ·  /cn:ask  ·  /cn:<model>
   codex:review   --output-format json (Anthropic-compatible cc-* wrappers)
```

| Role | Engine | Why |
|------|--------|-----|
| Orchestrator + reviewer (quality gate) | Claude / Opus | Already the harness orchestrator; the reviewer should be a different engine than either implementer so review stays neutral. |
| Backend | Codex / GPT-5.x | Strongest at systems, algorithms, and refactoring; ships read-only and adversarial review tooling for cross-checks. |
| Frontend | Antigravity CLI (`agy`) | Gemini-family multimodal (design → UI) with async subagents for parallel component work. |
| Supplementary pool | CN backends (this repo) | Elastic fan-out for tests, SQL, docs, i18n, and cross-checks. |

## Where `cn-cc` fits

`cn-cc` is **only** the supplementary CN pool. It does not orchestrate the triangle and
does not drive Codex or `agy`. Claude assigns overflow or cross-check work to the CN
backends and then folds the results back into its unified review.

Two entry points:

- `/cn:ask` / `/cn:<model>` — route one task to one backend (single-model).
- `/cn:team` — fan one task out to several backends in parallel, then review the
  collected outputs together.

## Pool dispatch patterns

- **Broadcast / cross-check** — send the same task to several backends and compare:

  ```bash
  /cn:team review this migration script for correctness and edge cases
  /cn:team --models qwen:token,glm:max,kimi -- audit this SQL for Doris compatibility
  ```

- **Per-task assignment** — when subtasks differ, route each with `/cn:ask` or a direct
  `/cn:<model>` call, matched via the `cn-routing` matrix (e.g. SQL → qwen, long docs →
  kimi, math → stepfun).

The orchestrator keeps every backend's output tagged `[cn:<model>]`, then synthesizes
agreements, disagreements, and a recommended pick — it never blends them into one answer
that hides which backend said what.

## Suggested pool mapping

| Supplementary task | Backend |
|--------------------|---------|
| SQL / migrations / Alibaba ecosystem | qwen |
| Long PRD / spec / document synthesis | kimi |
| Chinese reasoning / semantic work | glm |
| Math / logic / derivations | stepfun |
| Quick, low-latency bulk work | minimax |
| General Chinese coding / vision coding | doubao |
| Ultra-long context / multimodal | mimo |

## Notes

- Fan-out costs one run per member; prefer a single backend when one is clearly correct.
- Each CN backend runs in its own isolated `~/.claude-envs/<provider>` wrapper, so the
  pool never contends with the host Claude session's auth or state.
- Run `/cn:setup` before a session to confirm which backends are live.
