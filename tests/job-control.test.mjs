import test from "node:test";
import assert from "node:assert/strict";

import { wasCancellationConfirmed } from "../plugins/codex/scripts/lib/job-control.mjs";

// Regression tests for a P1 finding on PR #656: handleCancel unconditionally
// reported a job as cancelled even when neither the turn interrupt nor
// process-tree termination could confirm the worker actually stopped.

test("wasCancellationConfirmed is true when the turn interrupt succeeded, regardless of termination outcome", () => {
  assert.equal(wasCancellationConfirmed({ interrupted: true }, false), true);
  assert.equal(wasCancellationConfirmed({ interrupted: true }, true), true);
});

test("wasCancellationConfirmed is true when termination completed without throwing, even if the interrupt did not succeed", () => {
  assert.equal(wasCancellationConfirmed({ interrupted: false }, true), true);
});

test("wasCancellationConfirmed is false when neither the interrupt succeeded nor termination's outcome is known", () => {
  assert.equal(wasCancellationConfirmed({ interrupted: false }, false), false);
});

test("wasCancellationConfirmed treats a missing interrupt result as not interrupted", () => {
  assert.equal(wasCancellationConfirmed(null, false), false);
  assert.equal(wasCancellationConfirmed(undefined, true), true);
});
