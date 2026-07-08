import test from "node:test";
import assert from "node:assert/strict";

import { isStreamableProgressLine } from "../plugins/codex/scripts/lib/job-control.mjs";

// Regression for #372: the foreground task observer tails the job log to stderr
// for live progress. It must echo only progress lines, never the persisted
// block bodies (assistant message, Final output, reasoning), or it duplicates
// Codex's answer onto stderr alongside the rendered stdout result.
test("isStreamableProgressLine keeps progress lines and drops block titles/bodies", () => {
  // Timestamped progress lines are streamable.
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:39.925Z] Starting Codex Task."), true);
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:42.000Z] Turn completed."), true);
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Assistant message captured: OK"), true);

  // Block title lines (their bodies follow on stdout) are not streamable.
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Final output"), false);
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Assistant message"), false);
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Reasoning summary"), false);
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Review output"), false);
  assert.equal(isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Subagent design-challenger message"), false);
  assert.equal(
    isStreamableProgressLine("[2026-06-13T06:15:43.000Z] Subagent design-challenger reasoning summary"),
    false
  );

  // Unprefixed block-body / continuation lines and blanks are not streamable.
  assert.equal(isStreamableProgressLine("OK"), false);
  assert.equal(isStreamableProgressLine("the full assistant answer body line"), false);
  assert.equal(isStreamableProgressLine(""), false);
  assert.equal(isStreamableProgressLine(null), false);

  // Block-body lines that merely START with a bracket must NOT be streamed —
  // only a real ISO-8601 timestamp prefix counts as a progress entry (#372).
  assert.equal(isStreamableProgressLine("[1] https://example.com a markdown reference"), false);
  assert.equal(isStreamableProgressLine("[P2] a finding Codex wrote in its answer"), false);
  assert.equal(isStreamableProgressLine('["a", "b", "c"]'), false);
  assert.equal(isStreamableProgressLine("[TODO] fix the empty-state guard"), false);
  // A non-Z / non-timestamp bracketed prefix is still not a progress entry.
  assert.equal(isStreamableProgressLine("[2026-06-13] partial date only"), false);
});
