import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResultStatus,
  resolveErrorProgressPhase,
  shouldStoreTurnError
} from "../plugins/codex/scripts/lib/codex.mjs";

test("resolveErrorProgressPhase uses retrying for willRetry errors", () => {
  assert.equal(
    resolveErrorProgressPhase({
      willRetry: true,
      error: { message: "x" }
    }),
    "retrying"
  );
  assert.equal(resolveErrorProgressPhase({ error: { message: "x" } }), "failed");
  assert.equal(resolveErrorProgressPhase({}), "failed");
});

test("shouldStoreTurnError ignores retriable app-server errors", () => {
  assert.equal(
    shouldStoreTurnError({
      error: { message: "transient" },
      willRetry: true
    }),
    false
  );
  assert.equal(
    shouldStoreTurnError({
      error: { message: "terminal" }
    }),
    true
  );
});

test("buildResultStatus fails when turnState.error is set despite completed finalTurn", () => {
  const status = buildResultStatus({
    error: { message: "boom" },
    finalTurn: { id: "turn_1", status: "completed" }
  });

  assert.equal(status, 1);
});

test("buildResultStatus succeeds for completed turn without error", () => {
  const status = buildResultStatus({
    error: null,
    finalTurn: { id: "turn_1", status: "completed" }
  });

  assert.equal(status, 0);
});

test("buildResultStatus fails for non-completed finalTurn", () => {
  const status = buildResultStatus({
    error: null,
    finalTurn: { id: "turn_1", status: "failed" }
  });

  assert.equal(status, 1);
});

test("buildResultStatus fails when only error is present", () => {
  const status = buildResultStatus({
    error: { message: "x" },
    finalTurn: null
  });

  assert.equal(status, 1);
});
