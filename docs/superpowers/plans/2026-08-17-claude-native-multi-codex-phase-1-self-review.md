# Phase 1 Implementation Plan — Self-Review Amendments

- **Status:** Normative amendment
- **Applies to:** `2026-08-17-claude-native-multi-codex-phase-1.md`
- **Date:** 2026-08-17

This document records the implementation-plan self-review required before execution. Implementers must read the base plan first and then apply this amendment. Where the two documents differ, **this amendment takes precedence**.

The review found no unresolved product requirement, but it found several implementation-order and interface inconsistencies that would otherwise create avoidable rework or incomplete enforcement. The corrections below are part of the approved Phase 1 plan.

## 1. Corrected execution order for budgets and plan validation

The base plan temporarily duplicates score-derived budget logic inside `plan-contract.mjs` and later replaces it. Do not implement that temporary duplicate.

Execute the relevant work in this order:

1. Task 1 — workspace keys and generic locks.
2. Task 2 — configuration and setup flags.
3. **Task 3A — create `budget-policy.mjs` and its focused tests.**
4. Task 3B — create plan/result schemas and contracts, importing the real budget policy from the start.
5. Task 4 — state store.
6. Task 5 — scheduler only, plus any necessary additions to existing budget tests.
7. Tasks 6–16 in their existing order.

### Task 3A files

- Create: `plugins/codex/scripts/orchestration/budget-policy.mjs`
- Create: `tests/orchestration-budget.test.mjs`

### Task 3A required interface

```js
export function deriveBudgetEnvelope(complexityScore, config) {}
export function validatePlanAgainstBudget(plan, envelope) {}
```

Use the envelope table and exact expected values already specified in Task 5. Commit Task 3A separately:

```bash
git add plugins/codex/scripts/orchestration/budget-policy.mjs tests/orchestration-budget.test.mjs
git commit -m "feat: define orchestration budgets"
```

### Task 3B correction

In `plan-contract.mjs`, import the real functions immediately:

```js
import { deriveBudgetEnvelope, validatePlanAgainstBudget } from "./budget-policy.mjs";
```

Delete the base-plan instruction that says to define a local private budget equivalent. `normalizeOrchestrationPlan` must return the final derived envelope from its first implementation.

### Task 5 correction

Task 5 no longer creates `budget-policy.mjs`. It creates the scheduler and extends `tests/orchestration-budget.test.mjs` only when scheduler integration requires additional coverage.

## 2. Correct Node test-runner option order

Replace both focused commands in the base plan with Node's option-before-file form:

```bash
node --test --test-name-pattern="caller-owned|native-child topology" tests/runtime.test.mjs
```

```bash
node --test --test-name-pattern="fixture records overlapping turns" tests/orchestration-worker.test.mjs
```

All later focused test commands must follow the same rule.

## 3. Clarify the Phase 1 Reviewer boundary

The base plan says Phase 1 excludes reviewers while also retaining `reviewer` as a package role class. Interpret the boundary as follows:

- Phase 1 excludes **automatic risk-triggered integration review** and all write-integration review gates.
- Claude may still create an explicit **read-only `reviewer` work package** in the initial DAG.
- Such a package is scheduled and treated like any other read-only package and cannot approve or trigger Git integration.

Keep `reviewer` in the allowed role-class enum.

## 4. Add `optional` to the plan contract from the first schema revision

Do not defer `optional` until scheduler implementation.

`orchestration-plan.schema.json` must include:

```json
"optional": { "type": "boolean", "default": false }
```

`plan-contract.mjs` must normalize an omitted value to `false`. Scheduler and final-status logic then consume the already-normalized field.

## 5. Add an effective-configuration read command for automatic entry

The automatic-entry skill cannot assume that it knows whether orchestration is enabled. Add a deterministic configuration read surface.

### CLI extension

Task 12 must add:

```text
config [--cwd <path>] [--json]
```

It returns:

```js
{
  workspaceRoot,
  userConfigPath,
  projectConfigPath,
  effectiveConfig,
  autoEnabled: effectiveConfig.auto.enabled,
  autoThreshold: effectiveConfig.auto.threshold
}
```

This operation reads files only and does not start a controller.

### Skill behavior

Before **automatic** orchestration, `codex-orchestration` must call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration/cli.mjs" config --cwd "$PWD" --json
```

Rules:

- if `autoEnabled` is false, do not auto-start Multi-Codex work;
- if the score is below `autoThreshold`, do not auto-start;
- explicit `/codex:orchestrate` bypasses `autoEnabled` and `autoThreshold` but still obeys Phase 1 read-only and budget limits.

Add these cases to `tests/orchestration-skill.test.mjs` and `tests/orchestration-runtime.test.mjs`.

## 6. Make the worker-pool/controller API internally consistent

The base plan lists `WorkerPool.acquire` but later describes a fake pool with a direct `run` method. Use one concrete contract.

### WorkerPool public interface

```js
class WorkerPool {
  async acquire(packageId) {}
  async release(packageId) {}
  async discard(packageId, reason = null) {}
  async cancel(packageId, options = {}) {}
  getSnapshot() {}
  async close() {}
}
```

`acquire(packageId)` returns the leased `OrchestrationWorker` and records the package-to-worker mapping.

### Controller execution sequence

```js
const worker = await pool.acquire(packageId);
try {
  const execution = await worker.run(packageSpec, options);
  await pool.release(packageId);
  return execution;
} catch (error) {
  if (isTransientWorkerError(error)) {
    await pool.discard(packageId, error.message);
  } else {
    await pool.release(packageId);
  }
  throw error;
}
```

A transient worker/process failure must discard the dead worker before retry. The retry acquires a new or healthy idle worker.

### Cancellation sequence

`pool.cancel(packageId, { graceMs })` must:

1. call `worker.interrupt()`;
2. wait up to `graceMs` for the active run to settle;
3. call `discard(packageId, "cancel grace period exceeded")` if it does not settle;
4. release the global lease exactly once.

Update Task 9 and Task 10 tests to use this contract.

## 7. Enforce the active-Codex limit globally, including native children

The base plan enforces native-child counts only inside one workspace pool, which does not satisfy the approved plugin-wide limit. Extend the global registry.

### Global lease shape

```js
{
  id,
  pid,
  workspaceKey,
  workerId,
  packageId,
  acquiredAt,
  heartbeatAt,
  activeNativeChildren: 0
}
```

### Required registry API

```js
export async function acquireGlobalWorkerLease(options) {}
export async function updateGlobalWorkerLease(leaseId, patch, options = {}) {}
export async function releaseGlobalWorkerLease(leaseId, options = {}) {}
export async function readGlobalWorkerRegistry(options = {}) {}
export async function getGlobalActiveCodexCount(options = {}) {}
```

The count is:

```text
sum(1 top-level Root + activeNativeChildren for every live lease)
```

On every `native-child-started` and `native-child-completed` event, the owning pool updates its global lease under the global file lock.

Before accepting a new top-level lease, enforce both:

- `globalTopLevelLimit` against live lease count;
- `globalActiveCodexLimit` against the full count.

When a child-start event would push the plugin-wide total over `globalActiveCodexLimit`:

1. update no count for the rejected child event;
2. interrupt the offending Root;
3. mark that package failed with `ACTIVE_CODEX_LIMIT_EXCEEDED`;
4. release/discard the worker through the normal controller path.

Tests must use two workspace pools sharing one temporary plugin-data root and prove that child counts from one workspace constrain the other.

## 8. Define native-subagent `required` degradation precisely

Keep `nativeSubagents.policy` values:

```text
allowed | forbidden | required
```

Phase 1 behavior:

- `forbidden`: prompt the Root not to spawn children; any observed child is a package boundary violation and interrupts the Root.
- `allowed`: zero to `maxChildren` children are valid.
- `required`: request at least one child when the selected model/runtime supports it, but do not fail merely because no child appears.

If a `required` package completes with zero observed native children:

```js
{
  nativeSubagentDegraded: true,
  nativeSubagentDegradationReason: "No native child was observed; accepted Root-only execution."
}
```

Persist this metadata in package state and expose it in status/result. This implements the approved Root-only fallback without pretending that model support was conclusively detected.

## 9. Define package-result status mapping

The controller must map the canonical package result as follows:

| Model result | Scheduler state | Usable by dependents | Automatic retry |
|---|---|---:|---:|
| `completed` | `completed` | yes | no |
| `partial` | `partial` | yes | no |
| `blocked` | `blocked` | no | no |
| `failed` | `failed` | no | no |

Only transport/process errors classified as transient receive the one automatic retry. A model-reported `failed` or `blocked` result is not a transient worker failure.

`propagateBlockedPackages` must block descendants of both `blocked` and `failed` required dependencies.

## 10. Remove the duplicate per-orchestration controller file

Task 4's per-orchestration layout must not contain `<orch-id>/controller.json`.

Use only:

```text
<workspace-dir>/_controller/controller.json
<workspace-dir>/_controller/controller.lock
```

Each orchestration state instead records controller ownership metadata:

```js
controller: {
  instanceId,
  pid,
  attachedAt,
  lastHeartbeatAt
}
```

This metadata supports honest Phase 1 stale-state reconciliation without creating multiple controller identity files.

## 11. Use a short runtime directory for Unix socket safety

Durable orchestration data remains under plugin data. Controller IPC runtime files use an OS-temporary path to avoid Unix-domain socket path limits.

```js
const runtimeRoot = path.join(os.tmpdir(), "codex-orchestration-runtime");
const runtimeDir = path.join(runtimeRoot, workspaceKey);
```

Runtime files:

```text
<runtime-dir>/controller.sock       # macOS/Linux
<runtime-dir>/controller.json
<runtime-dir>/controller.lock
```

Windows named pipe:

```text
pipe:\\.\pipe\<workspace-key>-codex-orchestrator
```

The durable workspace `_controller` directory may retain an informational controller snapshot, but the authoritative live endpoint and lock are in the short runtime directory.

Add a test using an intentionally long `CLAUDE_PLUGIN_DATA` path and verify that the Unix socket endpoint remains below 100 characters.

## 12. Add Phase 1 stale-state reconciliation

Phase 1 does not resume orphaned work, but it must never leave a durable orchestration appearing live after its controller died.

On controller-server startup, before accepting orchestration requests:

1. list non-terminal orchestration states for the workspace;
2. inspect `state.controller.pid` and `state.controller.instanceId`;
3. when the prior PID is dead or the instance no longer owns the live endpoint:
   - mark `running`, `starting`, or `cancelling` packages `failed` with code `PHASE1_CONTROLLER_LOST`;
   - mark dependent planned/ready packages `blocked`;
   - mark unrelated planned/ready packages `cancelled` because Phase 1 does not resume them;
   - derive and persist the terminal orchestration status;
   - write a final aggregate result;
   - append a `controller-loss-finalized` event explaining the Phase 1 limitation.

Do not restart those packages automatically. Full resume/reconciliation remains Phase 3.

Add controller lifecycle and runtime tests for this behavior.

## 13. Durable reads must not require a live controller

`status` and `result` are state-store operations first.

### CLI behavior

- `config`: local config read, no controller.
- `status`: read durable state directly. Probe the controller only to enrich the snapshot with live pool/process data.
- `result`: read durable state/results directly; never start a controller.
- `start`: ensure/start controller.
- `cancel`: use the live controller for active work. If the orchestration has already been finalized by stale-state reconciliation, return its terminal status without starting a controller.

### Companion adapter behavior

The legacy companion's orchestration-aware `status` and `result` paths must call the state-store adapter directly. They must remain usable after controller exit.

Add tests that shut down the controller after completion and still retrieve status/result successfully.

## 14. Controller identity and heartbeats

At controller startup generate:

```js
const instanceId = `controller-${process.pid}-${crypto.randomUUID()}`;
```

Whenever a controller accepts or runs an orchestration, persist its identity in `state.controller`. Refresh `lastHeartbeatAt`:

- when a package starts;
- on each normalized package milestone;
- when a package completes;
- during a long-running package at least once every 30 seconds.

`controller/status` returns `instanceId`, PID, endpoint, active orchestration IDs, active package IDs, and worker-pool snapshot.

## 15. Clarify command/server concurrency

The JSONL server may handle multiple sockets concurrently, but every mutation of one orchestration must pass through the orchestration state lock. Controller methods must be idempotent for duplicate client requests:

- duplicate `start` is prevented by a generated orchestration ID created only inside the state store;
- duplicate package completion checks the package terminal state and performs no second transition;
- duplicate cancel returns the existing cancelling/terminal snapshot;
- duplicate release/discard cannot release a global lease twice.

Add focused duplicate-completion and duplicate-cancel tests to Task 10 or Task 11.

## 16. Correct the Phase 1 plan's completion claim boundary

The explicit command may report only that the orchestration was **accepted/started**. It must not wait for or synthesize the final result in the same invocation.

Automatic orchestration follows the same rule:

1. emit compressed plan notification;
2. start orchestration;
3. return orchestration ID and status/result/cancel commands;
4. do not claim package completion until durable state reports it.

Claude may later call `/codex:status` or `/codex:result` in response to the user, but the command itself remains non-blocking.

## 17. Corrected self-review verification additions

Add these checks before Phase 1 is considered implementation-ready:

```bash
node --test --test-name-pattern="caller-owned|native-child topology" tests/runtime.test.mjs
node --test --test-name-pattern="fixture records overlapping turns" tests/orchestration-worker.test.mjs
```

The full suite must additionally prove:

- automatic entry reads the effective config and remains disabled by default;
- explicit orchestration works while automatic entry is disabled;
- score threshold is enforced from config;
- worker failure discards the old worker before retry;
- plugin-wide active-Codex count includes native children across workspaces;
- required native children degrade honestly to Root-only execution;
- `blocked` and `failed` model results are not retried;
- stale running state becomes terminal after controller loss;
- durable status/result work without a live controller;
- long plugin-data paths do not create overlong Unix socket paths;
- duplicate completion/cancel/release operations are idempotent.

## 18. Updated spec-coverage mapping

| Corrected requirement | Task location |
|---|---|
| Real budget policy available during first plan validation | Task 3A, Task 3B |
| Automatic-entry feature flag actually consulted | Task 12, Task 14 |
| Pool/controller execution contract | Task 9, Task 10 |
| Global native-child accounting | Task 9, Task 15 |
| Required-child Root-only fallback | Task 8, Task 13, Task 15 |
| Canonical result-to-scheduler mapping | Task 5, Task 10 |
| Single controller identity location | Task 4, Task 11 |
| Short cross-platform IPC runtime path | Task 11 |
| Honest Phase 1 controller-loss finalization | Task 10, Task 11, Task 14 |
| Durable status/result without controller | Task 4, Task 12, Task 13 |
| Idempotent concurrent mutations | Task 4, Task 10, Task 11 |

## 19. Self-review conclusion

After applying this amendment:

- no placeholder or deferred substitute implementation remains in the Phase 1 plan;
- task dependencies are ordered so each contract is implemented against its final source of truth;
- worker, pool, controller, and state-store interfaces are mutually consistent;
- plugin-wide limits match the approved architecture rather than being enforced only per process;
- Phase 1 recovery behavior is honest and testable without claiming Phase 3 resume support;
- explicit and automatic command paths have a deterministic configuration gate;
- the plan remains strictly read-only and preserves all Phase 2/3 boundaries.
