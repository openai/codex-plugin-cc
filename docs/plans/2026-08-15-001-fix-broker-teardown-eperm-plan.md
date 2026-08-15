---
title: Guard broker teardown unlinks against EPERM - Plan
type: fix
date: 2026-08-15
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Guard broker teardown unlinks against EPERM - Plan

## Goal Capsule

- **Objective:** Make `teardownBrokerSession` immune to `unlinkSync` failures on the pid and log files, so an EPERM on Windows cannot fail the caller's job.
- **Authority:** Fixes openai/codex-plugin-cc issue #633 (duplicate #626). Scope is that issue plus the adjacent unguarded unlink on the same propagation path; PR must not include the Compound Engineering badge.
- **Execution profile:** Single implementation unit, one commit, mirrored from the three existing guards in the same function.
- **Stop conditions:** Unit tests cover the EPERM paths; full `npm test` and `npm run build` pass; job records no longer flip to `failed` when broker teardown hits a locked file.
- **Tail ownership:** `ce-work` owns implementation; commit/PR per repo conventions.

## Product Contract

### Summary

`teardownBrokerSession` in `plugins/codex/scripts/lib/broker-lifecycle.mjs` performs five cleanup steps. Three are wrapped in bare `try { ... } catch { ... }` guards that tolerate failure. The pid-file and log-file `unlinkSync` calls are guarded only by `fs.existsSync`, so a failed unlink throws. On Windows, deleting a file another process holds open fails with `EPERM`, which propagates out of `ensureBrokerSession` (stale-broker replacement path) through `CodexAppServerClient.connect` into `withAppServer`, and the caller's job is marked `failed` before any Codex work begins. The fix wraps the two unlinks in the same guard the other three steps already use, and applies the same guard to the broker state-file unlink in `clearBrokerSession`, which runs immediately after on the same propagation path.

### Problem Frame

Windows file deletion is advisory on locked files: `unlinkSync` throws `EPERM` when another process holds the file open. Broker pid and log files are exactly the files another process may hold. Today a cleanup that is meant to be best-effort becomes the root cause of a job failure with an error unrelated to the user's request.

### Requirements

- R1. `teardownBrokerSession` must not throw when unlinking the pid file fails, including on `EPERM`.
- R2. `teardownBrokerSession` must not throw when unlinking the log file fails, including on `EPERM`.
- R3. A failed pid or log unlink must not prevent the remaining cleanup steps from running.
- R4. Success-path behavior is unchanged: existing pid and log files are still removed when removal succeeds.
- R5. `clearBrokerSession` must not throw when unlinking the broker state file fails, including on `EPERM`.

### Scope Boundaries

- In scope: the two unguarded unlinks inside `teardownBrokerSession`, the unguarded state-file unlink in `clearBrokerSession` (same unguarded pattern, one call later on the same propagation path), and a unit test proving the guards.
- The PR will close both #633 and its duplicate #626.
- Deferred to follow-up work: sibling unguarded unlinks of the same EPERM class outside the broker lifecycle — `removeFileIfExists`/`removeJobFile` in `plugins/codex/scripts/lib/state.mjs` and the `shutdown()` unlinks in `plugins/codex/scripts/app-server-broker.mjs`.

## Planning Contract

### Key Technical Decisions

- KTD1. Mirror the existing guard pattern: each unlink becomes `try { fs.unlinkSync(...) } catch { // Ignore ... }` with a comment naming what is tolerated, matching the three guarded steps in the same function and the same shape used by `terminateProcessTree` for platform-tolerant cleanup. Chosen over introducing a shared `safeUnlink` helper or a `removeFileIfExists` wrapper: the repo already owns this exact pattern in the same function, and a new helper would be a wider change with no additional benefit.
- KTD2. The fix lives inside `teardownBrokerSession` and `clearBrokerSession`, not at call sites. Chosen over guarding the call sites (`ensureBrokerSession` stale-broker path, `ensureBrokerSession` spawn-failure path, `session-lifecycle-hook.mjs` `handleSessionEnd`): teardown is best-effort by contract, and one guard in each function covers every caller, including the hook path the issue does not enumerate.
- KTD3. Test by patching `fs.unlinkSync` directly in a new unit test file. Chosen over adding a mock framework or a dependency-injection seam: the repo has no mock framework (`node:test` + `assert/strict` only), tests within a file run serially, and `node --test` isolates test files in separate processes, so a temporary global patch of `fs.unlinkSync` is safe.

### Assumptions

- A failed unlink for any reason (not only `EPERM`) is safe to tolerate: the unlink is best-effort cleanup, and the existing guards already ignore all error codes.
- Keeping the bare `catch {}` (no error binding) matches repo style; no logging is added, consistent with the three existing guards.
- The unit test runs on all platforms including CI (Linux): the EPERM is simulated by the fs patch, so the test is platform-independent.

## Implementation Units

### U1. Guard the broker teardown unlinks against EPERM

- **Goal:** Wrap the pid-file and log-file `unlinkSync` calls in `teardownBrokerSession`, plus the state-file unlink in `clearBrokerSession`, in the same bare `try { ... } catch { // Ignore ... }` guard the other cleanup steps already use, and prove the EPERM path with a unit test.
- **Requirements:** R1, R2, R3, R4, R5
- **Dependencies:** none
- **Files:**
  - Modify `plugins/codex/scripts/lib/broker-lifecycle.mjs` (pid/log unlink blocks in `teardownBrokerSession` and the state-file unlink in `clearBrokerSession`, currently guarded only by `fs.existsSync`)
  - Create `tests/broker-lifecycle.test.mjs` (new unit test file)
- **Approach:**
  1. In `teardownBrokerSession`, wrap the pid-file unlink in `try { ... } catch { // Ignore locked or already-removed broker pid files during teardown. }`.
  2. Wrap the log-file unlink the same way, with a matching comment.
  3. In `clearBrokerSession`, wrap the state-file unlink in the same guard, with a matching comment.
  4. Keep the `fs.existsSync` pre-checks unchanged.
  5. Add the unit test: patch `fs.unlinkSync` per test case (path-targeted when a scenario needs only one file to fail), restore it in `t.after`.
- **Patterns to follow:** the three existing guarded steps in `teardownBrokerSession` (`killProcess`, endpoint socket unlink, `rmdirSync`); test style of `tests/process.test.mjs` (`node:test`, `assert/strict`), with the `t.after` cleanup pattern from `tests/runtime.test.mjs`.
- **Test scenarios:**
  1. Happy path: temp pid and log files exist; teardown removes both and does not throw.
  2. Error path: `fs.unlinkSync` throws `EPERM` for the pid file only (path-targeted patch); teardown completes without throwing and the log file is still removed.
  3. Error path: `fs.unlinkSync` throws `EPERM` for the log file only; teardown completes without throwing; the session dir may survive (its removal tolerates `ENOTEMPTY`).
  4. Edge case: pid and log paths do not exist; teardown attempts no unlink and does not throw.
  5. Integration: with the pid-file unlink failing, the endpoint-socket unlink and session-dir removal steps still run (remaining cleanup is not skipped).
  6. Error path: `clearBrokerSession` hits `EPERM` on the state file; it completes without throwing and the broker record is still cleared.
- **Verification:** the new test file passes with `npm test`; `npm run build` (loose checkJs typecheck) is clean.

## Verification Contract

| Check | Command | Applies to | Done signal |
|---|---|---|---|
| Unit suite | `npm test` (`node --test tests/*.test.mjs`) | U1 | All tests pass, including the new `tests/broker-lifecycle.test.mjs` cases; the EPERM scenarios fail before the guard change and pass after |
| Typecheck | `npm run build` | U1 | Clean exit; this is a loose checkJs pass (`strict: false`) that adds no meaningful type-error surface for this change, so the unit test is the authoritative gate; note the `prebuild` step requires the `codex` CLI on PATH |
| CI parity | `.github/workflows/pull-request-ci.yml` runs `npm test` + `npm run build` on ubuntu-latest | whole change | Same commands pass locally |

## Definition of Done

- The pid and log unlinks in `teardownBrokerSession` and the state-file unlink in `clearBrokerSession` are wrapped in bare catch guards with `// Ignore ...` comments.
- `tests/broker-lifecycle.test.mjs` covers happy path, both EPERM paths, the state-file EPERM path, missing-file edge case, and remaining-cleanup integration; red before the change, green after.
- `npm test` and `npm run build` pass.
- The EPERM failure mode is confirmed by simulation (platform-independent test); a manual Windows re-run of the issue's repro is recommended to confirm the reported symptom is gone, but is not blocking.
- No dead-end or experimental code remains in the diff; the change is one focused unit.
- PR body follows repo PR guidelines (no template exists; commit style is `imperative summary (#NNN)`), references #633 (and #626), contains no Compound Engineering badge, and includes security/agent disclosure as required by the target repo's expectations.
