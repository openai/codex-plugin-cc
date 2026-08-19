# Fail-Closed Codex Gate Design

## Goal

Make Codex Companion jobs self-heal after worker loss and make the Claude Stop review gate block with an actionable error instead of silently allowing, looping, or launching the same review twice.

## Confirmed failure modes

- A detached worker is spawned before its queued job is persisted. The worker can start first, fail to find the job, and leave the parent to publish a job that will remain queued forever.
- Status and wait paths trust `queued` and `running` JSON without checking whether the worker PID still exists.
- A worker killed outside the normal exception path never reaches `runTrackedJob` finalization, so its job remains active forever.
- A late worker completion can recreate or overwrite a job already cancelled or removed by SessionEnd.
- When the review gate is enabled but Codex is unavailable, the Stop hook only writes a note and allows the session to end.
- Repeating Stop for the same Claude response always starts a fresh Codex review.
- State files are overwritten in place, so an interrupted write can be parsed as an empty default state with the gate disabled.

## Required behavior

### Job lifecycle

- The only transitions are `queued -> running -> completed|failed|cancelled`.
- The queued record and request exist before the detached worker is spawned.
- A queued job without a worker PID receives a five-second startup grace period. After that it becomes `failed` with `Background worker did not start within 5 seconds.`
- A running or queued job with a dead PID becomes `failed` with `Background worker exited before completing the job.`
- Reconciliation runs before status, wait, result, cancel, task resume selection, and Stop-hook decisions.
- Terminal state is claimed by an immutable per-job `jobs/<id>.terminal.json` fence, created with exclusive filesystem creation. The first terminal writer wins; terminal fences contain only status and completion time, never request, prompt, or log content.
- A terminal or removed job cannot be overwritten by a late worker. Corrupt or empty fences fail closed as `failed`; all control-plane reads use the fence over mutable job/index JSON.
- SessionEnd fences active jobs before removing their mutable job and index records. It may leave the small terminal fence so a late worker cannot resurrect the job.
- Failed job status output includes the stored error message.

### Stop gate

- An enabled gate is fail-closed for unavailable Codex, task failure, timeout, missing output, invalid output, and corrupt state.
- Every block explains the failure and how to retry. Active jobs also show the exact status and cancel commands.
- The gate key is a SHA-256 hash of the Claude session ID and the exact last assistant message. No message content is stored in the key.
- A completed Stop review for the same gate key is reused. An active matching review blocks with its existing job ID instead of starting another review.
- A different last assistant message gets a new gate key and a fresh review.
- If no last assistant message is supplied, the hook runs a fresh review and does not cache it.

### Persistence

- `state.json` and per-job JSON files are written to a same-directory temporary file and atomically renamed.
- Invalid persisted JSON is an explicit error. It must not silently reset `stopReviewGate` to `false`.
- No new daemon, dependency, heartbeat file, or long-lived lock is introduced. PID liveness covers the observed worker-loss failure; the existing 15-minute Stop timeout covers a live but non-returning gate review.

## Verification

- A dead running worker becomes `failed` during `status --wait` and returns without timing out.
- A queued job missing a PID past startup grace becomes `failed`.
- Existing live-job timeout behavior remains unchanged when the PID is alive.
- Background task enqueue and completion remain green.
- Cancelling or removing a job prevents late finalization from resurrecting it.
- An unavailable Codex emits `decision: block` when the gate is enabled.
- Running the Stop hook twice with the same session and last response starts one Codex turn and returns the same decision.
- Invalid state blocks the Stop hook with a clear persistence error.
- The complete Node test suite and TypeScript build pass.

## Scope boundary

This change does not add retries, a supervisor daemon, configurable heartbeat intervals, or arbitrary background-job runtime limits. Add those only after evidence of a live worker hanging while its process remains healthy.
