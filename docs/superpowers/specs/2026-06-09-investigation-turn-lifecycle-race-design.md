# Design: fix the investigation turn-lifecycle race (Defect A + B + C)

Date: 2026-06-09
Repo: /Users/kentpeng/projects/codex-plugin-cc
Branch: feat/codex-self-collect-multiturn (PR #328 → openai:main)
Source requirement: https://my.feishu.cn/docx/LTqndYBT7oDlyTxMPnkcyFKWnHb
Related memory: `investigation-finalize-race`

## Problem

The multi-turn adversarial review (`runAppServerInvestigation`,
`plugins/codex/scripts/lib/codex.mjs`) runs several read-only recon turns, then a
final turn with an `outputSchema` to produce a structured verdict. On a
connection that is healthy throughout, the model can produce a valid
`needs-attention` verdict that the plugin then **discards**; the turn hangs until
the 180s idle watchdog aborts and the user is told "Codex could not complete the
review."

This is a **turn-lifecycle race**, not a network problem. Verified against live
run thread `019ea5d4-0c53-75f1-9032-5573d18cd878` in `~/.codex/logs_2.sqlite`
(2026-06-08 ~06:21); every model request was `200 OK text/event-stream`, no
reconnect / 429 / disconnect.

### Evidence timeline (from the logs, not inferred)

| Time | Event |
|------|-------|
| 06:19:42 → 06:21:50 | recon turn (submission `019ea5e1`) otel span is alive the whole window |
| 06:21:08–11 | recon emits its first `final_answer` message `msg_754…`: "I'm ready for finalize" — a **readiness cue**, not the real end of the turn |
| 06:21:11 | plugin **infers** recon is done and dispatches finalize `turn/start` (submission `019ea5e4`) |
| 06:21:41–46 | recon turn (still `019ea5e1`) streams the **real verdict JSON** (`{"verdict":"needs-attention",...}`) |
| — | finalize `019ea5e4` has only 3 log rows, all at 06:21:11; **no run_turn span, no stream events, RPC never returns** → it never actually ran |
| 06:21:50+ | thread goes silent; ~180s later the idle watchdog aborts |

(The double-logging of each message — `content:[]` then `content:[OutputText…]`
— is normal SSE streaming, not an empty final answer. The model produced a
complete, valid verdict.)

## Root cause — three defects in the `captureTurn` / idle-watchdog subsystem

### Defect A (primary) — premature finalize dispatch

`scheduleInferredCompletion` (codex.mjs:393) infers turn completion **250ms after
the first `final_answer`-phase message**. That first message can be a "ready to
finalize" cue, so the plugin dispatches the finalize `turn/start` while the
app-server's recon turn is **still active**. The app-server serializes per
thread: it queues finalize behind the open recon turn and **never opens a turn
for it** (`state.turnId` stays null, its notifications are buffered forever). The
real verdict streams ~30s later under the recon turn's id and is discarded, so
the only exit is the watchdog timeout.

**Constraint:** `scheduleInferredCompletion` exists on purpose. Subagent / collab
turns do not always emit a main-thread `turn/completed`; deleting inference
outright reintroduces a hang. It must be demoted, not removed.

### Defect B (secondary) — `armIdle()` runs before `belongsToTurn`

`captureTurn`'s notification handler calls `armIdle()` as its first line
(codex.mjs:631), before the `belongsToTurn` filter. Cross-turn / cross-thread
traffic therefore re-arms the captured turn's watchdog and **masks** a stuck
turn, so it never fails fast.

### Defect C — turn leak when the watchdog fires before the `turn/start` RPC reply

Raised by the Codex bot on PR #328's latest commit (`370ac7c`, P2,
codex.mjs:613); verified real. When `turn/start` has reached the app-server and
`turn/started` was emitted, but that RPC's response is delayed, the watchdog can
fire while `state.turnId` is still `null` (the pre-reply notifications are
buffered, not yet applied). The `if (state.turnId)` guard at codex.mjs:611 is
false, so `turn/interrupt` is **skipped** and the turn rejects — but the live
review turn keeps running on the app-server (a server-side **turn leak**) while
the caller believes it aborted.

All three live in `captureTurn` and its idle-watchdog; they are fixed together.

## Out of scope

The status-on-soft-error fix (`resolveRunExitStatus`) already merged in PR #328
solved "recovered turns mis-marked as failed." It is orthogonal to this race and
must **not** be folded into this change.

Also explicitly **not** adopted: "if recon already produced a valid verdict, skip
finalize." Recon runs with `outputSchema: null`, so its in-line verdict is not
schema-enforced and is less reliable than the dedicated finalize turn. Skipping
would widen the change surface and lower reliability. The schema-enforced
finalize turn is kept.

## Design

All changes are inside `captureTurn` and its helpers
(`scheduleInferredCompletion`, the notification handler, the idle-watchdog
callback) in `plugins/codex/scripts/lib/codex.mjs`. No caller-contract changes:
`runAppServerInvestigation`'s recon/finalize loop is structurally unchanged — it
simply stops advancing on a premature inferred completion.

### State model

| Field | Purpose | Defect |
|-------|---------|--------|
| `pendingTurnId` (new) | Turn id captured from a buffered `turn/started` for our thread, before the `turn/start` RPC reply sets `state.turnId`. Watchdog interrupts with `state.turnId ?? state.pendingTurnId`. | C |
| `sawSubagentWork` (new, boolean) | Latches `true` the first time a `collabAgentToolCall` or a subagent `turn/started` is seen. Hard-gates whether fallback inference is *ever* eligible. | A |
| `inferredCompletionQuietMs` (new, number) | The quiet-window duration for this turn; resolved from the `inferredCompletionQuietMs` option, else `CODEX_INFERRED_COMPLETION_QUIET_MS`, else the ~15s default. | A |
| `completionTimer` (existing field, re-purposed) | The inference timer handle. Now armed with the quiet window (`inferredCompletionQuietMs`) instead of a flat 250ms, and re-arms on belonging activity. Same field, new arming policy. | A |

**Two independent timers, never sharing a handle:**

- **Idle watchdog** (`idleTimer`, existing, default `DEFAULT_TURN_IDLE_TIMEOUT_MS
  = 180_000`): fail-fast for a *dead connection*; **rejects** the turn. Re-armed
  only by belonging traffic (Defect B).
- **Quiet / inference timer** (the `completionTimer` field, default ~15s,
  injectable): *success* fallback for the subagent case where the main thread
  never emits `turn/completed`; **resolves** the turn. Armed only when
  `sawSubagentWork` is true.

The watchdog still owns true-idle failure; the quiet timer only ever produces an
inferred *success*, and only in the subagent case. ("quiet timer" is prose for
the re-purposed `completionTimer` field — no separate handle is introduced.)

### Defect A — demote inference to a guarded fallback

1. **Primary completion signal is always the real `turn/completed`** for our
   thread (existing path at codex.mjs:561 → `completeTurn`); unchanged. In the
   evidence case, the 06:21:46 verdict now arrives under the still-open recon
   turn, recon completes on its own `turn/completed`, and finalize lands on an
   idle thread.

2. **Inference is eligible only when ALL hold:**
   - `sawSubagentWork === true` — the turn actually spawned subagent / collab
     work. **Plain recon turns never infer**; they wait for `turn/completed`.
   - `pendingCollaborations.size === 0 && activeSubagentTurns.size === 0` — all
     subagent / collab work drained (existing gates, kept).
   - the quiet window (~15s, re-arming) elapses with no new belonging
     items/messages **and** no `turn/completed`.

3. **`finalAnswerSeen` is no longer a completion *trigger*.** A `final_answer`
   message in a plain recon turn does nothing on its own — we wait for
   `turn/completed`. The quiet timer is driven by drain + inactivity, not by a
   readiness cue.

4. **Quiet timer re-arms** on every belonging item/message, so it fires only
   after genuine silence. The window is a module constant (default ~15s) but
   **injectable via options** (mirroring `turnIdleTimeoutMs`) so tests are
   instant and deterministic. The override is also readable from the
   `CODEX_INFERRED_COMPLETION_QUIET_MS` env var. Unlike the idle watchdog (which
   has a user-facing `--turn-idle-timeout` flag), this knob is **deliberately
   kept internal** — it is a test/escape-hatch override, not plumbed through the
   companion CLI, since the ~15s default is correct for production and users
   should not need to tune it.

This preserves the subagent / collab hang that inference was added to prevent: a
subagent turn that never emits a main-thread `turn/completed` still resolves,
just after a real quiet window instead of a 250ms readiness-cue race.

**Why keep inference at all, given the evidence run had no subagents?** (Design
challenge, recorded for the record.) The reported failure was a *plain* recon
turn, and the fix for it is entirely "wait for the real `turn/completed`" — the
`sawSubagentWork`-gated quiet window never becomes eligible on that path. So the
fallback machinery (the quiet timer, the `CODEX_INFERRED_COMPLETION_QUIET_MS`
env var) exists only for the `/codex:task` collab flow, which is orthogonal to
the reported defect. We deliberately keep it rather than removing inference
because the original `scheduleInferredCompletion` was added to stop a real hang:
subagent / collab turns do not always emit a main-thread `turn/completed`, and
`runAppServerTurn` (task path) shares `captureTurn`. A narrower alternative —
inference only in `runAppServerTurn` and an unconditional wait-for-`turn/completed`
in the investigation recon loop — was considered and rejected: it would fork
`captureTurn`'s completion logic by caller, duplicating the subtlest part of the
state machine. Keeping one gated fallback in `captureTurn`, exercised by both
callers, is the smaller long-term surface. The cost is that ~half the new test
surface covers the task/collab path, not the investigation path.

**Naming:** the inference timer is referred to as the *quiet timer* in prose, but
the implementation keeps the existing state field name `completionTimer` (it is
the same handle, now armed with the quiet window instead of 250ms). No new field
is introduced for it.

**`finalAnswerSeen` after the fix:** it is still *written* in `recordItem` but no
longer *read* by the completion gate (the old `scheduleInferredCompletion` was
its only reader). It is retained, not deleted, because it is part of the
documented `TurnCaptureState` shape and may be read by future telemetry; the plan
notes this explicitly so it is not mistaken for a live trigger.

### Defect B — re-arm only for belonging traffic

Reorder the notification handler so re-arm respects ownership:

```
on notification:
  if state.turnId is null (buffering window):
      armIdle()                       // re-arm: these are almost always our own early notifications;
                                       // not re-arming risks a spurious timeout before the RPC returns
      if turn/started for OUR thread: state.pendingTurnId = turn.id    // Defect C
      bufferedNotifications.push(message); return
  // turnId known:
  if method is thread/started or thread/name/updated:
      armIdle(); applyTurnNotification(...); return   // turn-agnostic bookkeeping — safe to re-arm
  if not belongsToTurn(message):
      previousHandler?.(message); return              // foreign traffic — do NOT re-arm
  armIdle()                                            // belongs to us — re-arm
  applyTurnNotification(...)
```

The buffered-notification replay after the RPC returns (codex.mjs:662) already
routes by `belongsToTurn`; it simply stops re-arming improperly. Net: cross-turn
chatter no longer keeps a dead turn alive; true idle still fails.

### Defect C — interrupt even when `state.turnId` is null

While buffering, capture the turn id into `state.pendingTurnId` from any
`turn/started` matching our thread (see Defect B handler). The watchdog callback
then interrupts with whichever id is available:

```js
const interruptTurnId = state.turnId ?? state.pendingTurnId;
if (interruptTurnId) {
  client.request("turn/interrupt", { threadId, turnId: interruptTurnId }).catch(() => {});
}
idleReject?.(new Error(`Turn idle for ${seconds}s; aborting (upstream connection appears stalled).`));
```

Best-effort and non-awaited, exactly as today — just no longer blind to a turn
whose id exists only in the buffer. If no `turn/started` was ever seen (the RPC
truly never reached the server), there is nothing to interrupt and we reject as
before.

## Affected code

| Location | Change | Defect |
|----------|--------|--------|
| `codex.mjs` · `createTurnCaptureState` (~323) | add `pendingTurnId`, `sawSubagentWork`; rename/repurpose timer field for the quiet window | A, C |
| `codex.mjs` · `scheduleInferredCompletion` (~393) | gate on `sawSubagentWork` + drained + re-arming quiet window; stop triggering on `finalAnswerSeen` alone | A |
| `codex.mjs` · `recordItem` / `applyTurnNotification` (~426, ~510) | latch `sawSubagentWork` on `collabAgentToolCall` / subagent `turn/started` | A |
| `codex.mjs` · `captureTurn` notification handler (~630) | re-arm ordering; capture `pendingTurnId` from buffered `turn/started` | B, C |
| `codex.mjs` · idle-watchdog callback (~611) | interrupt with `state.turnId ?? state.pendingTurnId` | C |
| `runAppServerInvestigation` recon loop (~1174) | thread the injectable quiet-window option through `captureTurn` calls | A |

## Testing

Tests live in `tests/investigation.test.mjs` (and `tests/runtime.test.mjs`),
driven by `tests/fake-codex-fixture.mjs`. The fixture already provides
`with-subagent`, `with-late-subagent-message`,
`with-subagent-no-main-turn-completed`, queue-driven scripting, and
`delayMs`/`emitTurnCompletedLater` timing. The quiet/inference window is injected
(set to a few ms) so tests are instant and deterministic.

One case per acceptance criterion:

1. **Defect A repro (headline bug):** plain recon emits a `final_answer`
   readiness cue, then after a delay streams the real verdict and a real
   `turn/completed`. Assert: no early completion on the cue; the late verdict is
   captured under the same turn; finalize runs on an idle thread; verdict
   survives. (Fails today.)
2. **Plain recon never infers:** no subagent work + `final_answer` + no
   `turn/completed` ⇒ no inferred completion; the turn waits. Locks in "plain
   turns wait for `turn/completed`."
3. **Subagent fallback still works (no regression):**
   `with-subagent-no-main-turn-completed` ⇒ after subagent drains and the quiet
   window elapses, inference resolves the turn successfully.
4. **Defect B:** with our turn open, inject foreign-thread / foreign-turn
   notifications; assert they do **not** re-arm our watchdog (a stuck turn still
   idle-times-out on schedule) while belonging traffic does.
5. **Defect C:** delay the `turn/start` RPC reply but emit `turn/started` first;
   trip the watchdog while `state.turnId` is null; assert a `turn/interrupt` is
   sent (fixture records `lastInterrupt`) with the buffered turn id and the turn
   rejects.
6. **True idle still fails:** dead-link scenario (no notifications) still rejects
   at the idle timeout — watchdog behavior not regressed.

### Verification

```
node --test tests/*.test.mjs
```

Must exit cleanly, no hangs, **no net-new failures** against the known 7-failure
baseline. Capture the baseline on the current branch before changes, then
compare after.

## Acceptance criteria (from the requirement)

- Recon turns end only on a real `turn/completed` (or the guarded fallback);
  finalize lands on an idle thread and produces the schema-enforced verdict.
- The evidence scenario is reproduced and fixed: a verdict streamed after a
  readiness cue is not discarded.
- The idle watchdog is re-armed only by traffic belonging to the current turn;
  cross-turn/thread chatter no longer masks a stuck turn.
- No regression to the subagent / collab multi-turn path (the hang inference was
  built to prevent).
- No regression to idle-watchdog behavior (a true idle timeout still fails).
- `node --test tests/*.test.mjs` exits cleanly, no hangs, no net-new failures
  against the 7-failure baseline.
