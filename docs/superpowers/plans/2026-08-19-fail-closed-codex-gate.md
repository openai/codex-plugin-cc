# Fail-Closed Codex Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make detached Codex jobs self-heal after worker loss and make the Claude Stop review gate deterministically fail closed without duplicate reviews of the same turn.

**Architecture:** Persist queued work before spawning, reconcile active jobs against their worker PID on every control-plane read, and refuse late writes after a terminal transition. Reuse Stop-review results by a hash of session ID plus last assistant message, while retaining the existing foreground timeout.

**Tech Stack:** Node.js ESM, built-in `node:test`, filesystem JSON state, Claude Code hooks.

## Global Constraints

- No new runtime dependencies or daemon.
- The only job transitions are `queued -> running -> completed|failed|cancelled`.
- Enabled review gates fail closed for infrastructure and persistence errors.
- The last assistant message is never stored in a gate cache key.
- All production changes follow RED-GREEN TDD.

---

### Task 1: Self-healing tracked jobs

**Files:**
- Modify: `tests/process.test.mjs`
- Modify: `tests/runtime.test.mjs`
- Modify: `plugins/codex/scripts/lib/process.mjs`
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs`
- Modify: `plugins/codex/scripts/lib/job-control.mjs`
- Modify: `plugins/codex/scripts/lib/render.mjs`

**Interfaces:**
- Produces: `isProcessAlive(pid, options?) -> boolean`
- Produces: `reconcileTrackedJobs(workspaceRoot, options?) -> Job[]`
- Consumes: existing `listJobs`, `writeJobFile`, and `upsertJob` persistence functions.

- [ ] **Step 1: Write failing process-liveness tests**

Add tests proving a successful signal probe and `EPERM` mean alive while `ESRCH` means dead:

```js
assert.equal(isProcessAlive(123, { killImpl() {} }), true);
assert.equal(isProcessAlive(123, { killImpl() { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), false);
assert.equal(isProcessAlive(123, { killImpl() { throw Object.assign(new Error("denied"), { code: "EPERM" }); } }), true);
```

- [ ] **Step 2: Verify the process test is RED**

Run: `node --test --test-name-pattern="isProcessAlive" tests/process.test.mjs`

Expected: FAIL because `isProcessAlive` is not exported.

- [ ] **Step 3: Implement the process probe**

Add `isProcessAlive` to `process.mjs` using `process.kill(pid, 0)`, returning false only for non-finite PIDs and `ESRCH`, and treating `EPERM` as alive.

- [ ] **Step 4: Write failing reconciliation tests**

Add runtime tests with persisted jobs proving:

```js
assert.equal(payload.job.status, "failed");
assert.equal(payload.waitTimedOut, false);
assert.match(payload.job.errorMessage, /worker exited/i);
```

and an old queued job without a PID fails with `/did not start within 5 seconds/i`. Update the existing active-timeout fixture to use `pid: process.pid` so it continues to represent a live worker.

- [ ] **Step 5: Verify the reconciliation tests are RED**

Run: `node --test --test-name-pattern="dead worker|startup grace|still active" tests/runtime.test.mjs`

Expected: dead and unstarted jobs remain active, so the new assertions fail.

- [ ] **Step 6: Implement reconciliation and rendering**

In `tracked-jobs.mjs`, reconcile each active job:

```js
if (job.status === "queued" && !Number.isFinite(job.pid) && ageMs >= 5000) {
  return failTrackedJob(workspaceRoot, job, "Background worker did not start within 5 seconds.");
}
if (Number.isFinite(job.pid) && !isProcessAlive(job.pid)) {
  return failTrackedJob(workspaceRoot, job, "Background worker exited before completing the job.");
}
```

Use reconciled jobs in all job-control read paths. Render `Error: ${job.errorMessage}` in failed-job details.

- [ ] **Step 7: Verify Task 1 GREEN**

Run: `node --test tests/process.test.mjs tests/runtime.test.mjs`

Expected: PASS.

### Task 2: Race-free launch and terminal-state protection

**Files:**
- Modify: `tests/runtime.test.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs`

**Interfaces:**
- Consumes: `reconcileTrackedJobs` from Task 1.
- Produces: queued job publication before detached worker spawn.
- Produces: an immutable per-job terminal fence, created with exclusive filesystem creation, whose first writer wins.

- [ ] **Step 1: Write failing terminal-state tests**

Persist a terminal fence and assert a late worker cannot run or overwrite its first terminal outcome. Remove a running job during a deferred runner after SessionEnd/cancellation fences it and assert progress/finalization does not recreate a visible job. Add a deterministic reconciliation-versus-worker interleaving test.

- [ ] **Step 2: Verify the terminal-state tests are RED**

Run: `node --test --test-name-pattern="terminal job|removed job" tests/runtime.test.mjs`

Expected: FAIL because current finalization overwrites or recreates the job.

- [ ] **Step 3: Publish before spawn**

Change enqueue ordering to:

```js
writeJobFile(job.workspaceRoot, job.id, queuedRecord);
upsertJob(job.workspaceRoot, queuedRecord);
spawnDetachedTaskWorker(cwd, job.id);
```

The worker sets its own PID when it enters `runTrackedJob`; queued jobs receive the five-second startup grace from Task 1.

- [ ] **Step 4: Protect terminal transitions**

Every terminal writer (reconciliation, completion/failure, cancel, and SessionEnd) claims `jobs/<id>.terminal.json` with `openSync(..., "wx")`; the first claimed status overrides stale mutable JSON. Empty/corrupt fences are failed, never overwritten. Progress/upsert and effective control-plane reads honor the fence, and SessionEnd removes mutable records only after fencing active jobs.

- [ ] **Step 5: Verify Task 2 GREEN**

Run: `node --test --test-name-pattern="background|terminal job|removed job|cancel|SessionEnd" tests/runtime.test.mjs`

Expected: PASS.

### Task 3: Fail-closed, idempotent Stop review

**Files:**
- Modify: `tests/runtime.test.mjs`
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs`

**Interfaces:**
- Produces: `CODEX_COMPANION_GATE_KEY` metadata on Stop-review jobs.
- Produces: deterministic gate-key hashing of session ID and last assistant message.
- Consumes: stored `result.rawOutput` for exact-turn reuse.

- [ ] **Step 1: Write failing gate tests**

Change the unavailable-Codex test to require:

```js
assert.equal(JSON.parse(result.stdout).decision, "block");
assert.match(JSON.parse(result.stdout).reason, /not set up/i);
```

Run the Stop hook twice with the same session and non-empty `last_assistant_message`; assert both decisions match and the fake Codex `nextTurnId` does not increase on the second call.

- [ ] **Step 2: Verify the gate tests are RED**

Run: `node --test --test-name-pattern="unavailable|same Claude response" tests/runtime.test.mjs`

Expected: unavailable Codex produces no decision and the second Stop starts another turn.

- [ ] **Step 3: Propagate and reuse the gate key**

Hash without retaining message content:

```js
createHash("sha256").update(`${sessionId}\0${lastAssistantMessage}`).digest("hex")
```

Pass it through `CODEX_COMPANION_GATE_KEY`, record it on the tracked job, and before launching find the matching current-session Stop job. Reparse completed output; block with the existing job ID for active, failed, or cancelled matches.

- [ ] **Step 4: Make setup failures fail closed**

When `buildSetupNote` returns a message for an enabled gate, emit:

```js
emitDecision({ decision: "block", reason: setupNote });
```

- [ ] **Step 5: Verify Task 3 GREEN**

Run: `node --test --test-name-pattern="stop hook" tests/runtime.test.mjs`

Expected: PASS.

### Task 4: Atomic, strict JSON persistence

**Files:**
- Modify: `tests/state.test.mjs`
- Modify: `plugins/codex/scripts/lib/state.mjs`
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs`

**Interfaces:**
- Produces: same-directory temporary write plus `renameSync` for state and job JSON.
- Produces: explicit parse errors from invalid state JSON.

- [ ] **Step 1: Write failing persistence tests**

Write invalid `state.json` and assert `loadState` throws an error containing the state path. Run the enabled Stop hook against invalid state and assert it emits `decision: block` with a persistence error.

- [ ] **Step 2: Verify persistence tests are RED**

Run: `node --test --test-name-pattern="invalid state|corrupt state" tests/state.test.mjs tests/runtime.test.mjs`

Expected: `loadState` silently returns defaults and the hook emits no block decision.

- [ ] **Step 3: Implement atomic strict persistence**

Write JSON through a unique sibling temporary file and `fs.renameSync`. On parse failure throw `Failed to read Codex Companion state at <path>: <message>` instead of returning defaults. Catch top-level Stop-hook errors and emit a block decision.

- [ ] **Step 4: Verify Task 4 GREEN**

Run: `node --test tests/state.test.mjs tests/runtime.test.mjs`

Expected: PASS.

### Task 5: Full verification and delivery

**Files:**
- Modify: `plugins/codex/CHANGELOG.md`

**Interfaces:**
- Consumes: all behavior from Tasks 1-4.
- Produces: release note and verified branch.

- [ ] **Step 1: Add a concise changelog entry**

Document dead-worker reconciliation, race-free background launch, exact-turn Stop reuse, and fail-closed setup/persistence failures under the current unreleased section.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run build
npm run check-version
```

Expected: all tests pass, TypeScript exits 0, and version metadata is consistent.

- [ ] **Step 3: Review the final diff**

Run: `git diff --check && git diff --stat origin/main...HEAD && git status --short --branch`

Expected: no whitespace errors and only planned files changed.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers plugins/codex tests
git commit -m "fix: harden Codex stop gate supervision"
```

- [ ] **Step 5: Request independent review, fix blocking findings, and re-run verification**

Dispatch a read-only verifier against `origin/main...HEAD`. Critical and Important findings must be fixed before publishing.

- [ ] **Step 6: Publish and integrate through repository policy**

Fetch `origin`, reconcile with its current default branch, push `codex/gate-supervision`, and use the required PR/review path. Record the final main-branch SHA or the external blocker if upstream permissions prevent merge.
