# Design: fix recovered-turn status being mis-marked as failed

Date: 2026-06-08
Repo: /Users/kentpeng/projects/codex-plugin-cc
Branch: feat/codex-self-collect-multiturn (PR #328 → openai:main)
Source brainstorm: docs/fix-status-on-soft-error.md

## Problem

Commit `d222542` on this PR changed the shared `buildResultStatus`
(`plugins/codex/scripts/lib/codex.mjs:740`) to return non-zero whenever a turn
recorded *any* `error` — including a transient one the turn recovered from:

```js
function buildResultStatus(turnState) {
  if (turnState.error) return 1;        // added by d222542
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}
```

The app-server multiplexes transient retry notices (e.g. `Reconnecting... 1/5`)
onto the same `error` notification channel as fatal turn failures, and the
capture state records the last one seen **without clearing it**. So a turn can
simultaneously have `turnState.error` set (stale transient notice) AND
`finalTurn.status === "completed"` with a valid `lastAgentMessage`. After
`d222542`, `buildResultStatus` returns 1 for that recovered turn.

### Who compensates, who doesn't (verified against current code)

| Path | State | Location |
|------|-------|----------|
| Adversarial review | COMPENSATED | `executeReviewRun` codex-companion.mjs:575 — exits 0 when a valid parsed verdict exists |
| Investigation runner | COMPENSATED internally | codex.mjs:1218 — aborts only when `error && !turnRecovered` |
| **/codex:task** | **NOT compensated** | `executeTaskRun` codex-companion.mjs:655 returns `exitStatus: result.status` raw |
| **Native /codex:review** | **NOT compensated** | `executeReviewRun` Review branch codex-companion.mjs:414 returns `exitStatus: result.status` raw |

### Blast radius

1. `runTrackedJob` (lib/tracked-jobs.mjs:156): `exitStatus !== 0` ⇒ job recorded
   as **failed**, foreground command exits non-zero.
2. Stop-review-gate hook (scripts/stop-review-gate-hook.mjs:120): keys off
   `result.status !== 0` and returns a "task failed" block — without ever
   parsing the `ALLOW:`/`BLOCK:` answer the model produced. A recovered gate
   review = **false-positive session block**.

### Key nuance found during brainstorm

The three callers do not share one definition of "usable output":

- task → `result.finalMessage`
- native review → `result.reviewText`
- adversarial review → a *parsed structured verdict* (`parsed.parsed`), stricter
  than "any message present", and it reuses `result.status` as its failure
  fallback.

Therefore pushing the fix down into `buildResultStatus`/the runners is **not**
free: a recovered-but-unparseable adversarial run would flip exit 1 → 0 (a new
regression) unless the adversarial fallback were also tightened. We avoid that
by fixing at the caller layer with a shared helper, leaving `result.status`
semantics and the already-correct adversarial path untouched.

## Required behavior

A turn that **completed with a usable result** (`finalTurn.status ===
"completed"` and usable output present) but recorded a transient `error` must be
treated as SUCCESS: exit 0, job recorded "completed", gate proceeds to parse the
answer. A turn that genuinely failed (no usable output, or `finalTurn.status !==
"completed"`) keeps non-zero status.

## Chosen approach: shared caller-level helper (A2)

Add the recovery rule in ONE named place and apply it at the two un-compensated
caller sites. Do not touch `buildResultStatus`, the runners, or the adversarial
path.

### `plugins/codex/scripts/lib/codex.mjs` — new function

```js
function resolveRunExitStatus(result, usableText) {
  const recovered = result.turn?.status === "completed"
    && Boolean(String(usableText ?? "").trim());
  return recovered ? 0 : result.status;
}
```

Both runners already return `turn: turnState.finalTurn` (codex.mjs:1040 and
:1109), so `result.turn?.status` is available on both paths.

### `plugins/codex/scripts/codex-companion.mjs` — three sites

- `executeTaskRun` (:655):
  `exitStatus: resolveRunExitStatus(result, result.finalMessage)`, and set
  `payload.status` to the same resolved value (removes the JSON inconsistency
  where a recovered/success task still reports `status: 1`).
- Native-review branch (:414):
  `exitStatus: resolveRunExitStatus(result, result.reviewText)`, and set
  `payload.codex.status` to the same resolved value.
- Adversarial branch (:575): **unchanged** — already correct.

### Rendering — no change needed (verified)

- `renderTaskResult` (render.mjs:350) prefers `rawOutput` (= `finalMessage`) and
  only falls back to `failureMessage` when it is empty. A recovered task renders
  its real answer, not the stale `Reconnecting...` notice.
- `renderNativeReviewResult` (render.mjs:323) prefers `stdout` (= `reviewText`)
  regardless of `status`.

### Stop-gate hook — no change needed (verify by test)

The hook keys off the child process exit status (`result.status` in
stop-review-gate-hook.mjs:120). Once the task exits 0 on recovery, the hook
proceeds to parse the `ALLOW:`/`BLOCK:` answer. This propagation must be
confirmed by test C, not assumed.

## Test plan (`node --test`, TDD: write failing tests first)

### A. Task path — queue-driven fixture
Mirror `"finalize turn that recovered from a transient reconnect keeps its valid
verdict (e2e)"` in tests/investigation.test.mjs, but drive `task --json`.

1. Recovered = success: queue
   `{ finalAnswer: { text: "ALLOW: looks fine" }, turnError: { message: "Reconnecting... 1/5" } }`,
   run companion `task --json`. Assert `result.status === 0` (process exit),
   `payload.rawOutput` contains the answer, `payload.status === 0` (the
   normalized JSON field).
2. Genuine-failure guard: a turn with `turnError` AND no `finalMessage` (or
   `finalTurn` not completed) must still exit non-zero.

### B. Native review path — same fixture, `review` branch
Recovered turn with `reviewText` present + `turnError` ⇒ `exitStatus 0`; a
failure turn with no `reviewText` ⇒ non-zero. Confirms `resolveRunExitStatus`
uses `reviewText`, not `finalMessage`.

### C. Stop-gate hook — `installFakeCodex` named-scenario harness (runtime.test.mjs)
The existing gate tests use `installFakeCodex(binDir, behavior)` named scenarios,
not the queue-driven fixture. The queue-driven path already emits `entry.turnError`
as an `error` notification (tests/fake-codex-fixture.mjs ~413); extend the
named-scenario path with an equivalent switch (or add a `stop-gate-recovered`
scenario) that emits `error` notice + valid agent message + `turn/completed`.

- Assert: a recovered gate task yields `ok:true` and the ALLOW/BLOCK answer is
  parsed — NOT a "task failed" block.
- Keep the existing `"... blocks on findings"` and `"... allows ... when clean"`
  gate tests green.

### D. Regression guards (must stay green)
- Existing adversarial `"recovered finalize keeps its valid verdict"` (confirms
  A2 did not touch the adversarial path).
- Idle-watchdog tests (a genuine idle timeout must still be a failure).

## Verification before done

- `node --test tests/*.test.mjs` — full suite. Known PRE-EXISTING failures
  unrelated to this work (NOT regressions): `status shows phases, hints, and the
  latest finished job`, `status preserves adversarial review kind labels`,
  `result returns the stored output for the latest finished job by default`,
  `resolveStateDir uses a temp-backed per-workspace directory`. Net new failures
  must be zero.
- Confirm the suite EXITS CLEANLY (no hang). Do not abandon turns in tests —
  always let them settle with the fixture's normal queued responses.

## Deploy to the live local install (after merge-ready)

The running plugin is the CACHE build, not this repo. Copy the changed files to
`~/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/...` (back up first;
mapping in memory `codex-plugin-runtime-source`).

## Out of scope (track separately; do NOT bundle)

`?? ""`-empty-string family; native review missing idle watchdog / empty-diff
short-circuit; `--turn-idle-timeout` upper bound; `runAppServerInvestigation`
`truncated` mislabel at 0 commands; uncommitted dead `runAppServerTurn` import in
tests; stale `DEFAULT_INLINE_DIFF_MAX_FILES` comment.

**Promoted to a separate work item (own brainstorm → spec → plan):** the
investigation-loop turn-lifecycle race. The recon loop advances to the finalize
turn on an *inferred* completion (`scheduleInferredCompletion`, codex.mjs:393)
that fires on the first `final_answer`-phase message — which can be a "ready to
finalize" readiness cue, not the real end of the turn. The finalize `turn/start`
is then dispatched while the app-server's recon turn is still active; the server
queues it and never opens it, the real verdict streams under the recon turn and
is discarded, and the turn hangs until the 180s idle watchdog aborts. This
bundles **Defect A** (premature finalize dispatch; fix = wait for a real
`turn/completed`, demote inference to a guarded fallback) with **Defect B**
(`captureTurn` `armIdle()` runs before the `belongsToTurn` filter, codex.mjs:631,
so orphaned cross-turn traffic re-arms the captured turn's watchdog and masks the
stuck turn). Both live in `captureTurn`/the idle-watchdog subsystem; fix them
together, NOT in this status-fix change. Evidence: live run thread
`019ea5d4-0c53-75f1-9032-5573d18cd878` in `~/.codex/logs_2.sqlite` (2026-06-08
~06:21).
