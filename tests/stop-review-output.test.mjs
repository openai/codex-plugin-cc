import test from "node:test";
import assert from "node:assert/strict";

import {
  formatStopReviewProcessFailure,
  parseStopReviewOutput,
  parseStopReviewPayload
} from "../plugins/codex/scripts/lib/stop-review-output.mjs";

test("parseStopReviewOutput preserves the full multiline BLOCK explanation", () => {
  const result = parseStopReviewOutput(
    "BLOCK: Missing empty-state guard\nsrc/app.js:4 indexes the collection before checking its length.\nAdd a regression test."
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing empty-state guard/);
  assert.match(result.reason, /src\/app\.js:4 indexes the collection/);
  assert.match(result.reason, /Add a regression test/);
});

test("parseStopReviewOutput includes unexpected answers with bounded diagnostics", () => {
  const refusal = `I cannot complete this review.\n${"detail ".repeat(1000)}`;
  const result = parseStopReviewOutput(refusal);

  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected answer/i);
  assert.match(result.reason, /I cannot complete this review/);
  assert.match(result.reason, /output truncated: \d+ characters omitted/);
});

test("parseStopReviewPayload treats an empty error as absent", () => {
  const result = parseStopReviewPayload(
    JSON.stringify({ error: "", rawOutput: "BLOCK: The actionable reason" })
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /The actionable reason/);
});

test("parseStopReviewPayload serializes structured errors", () => {
  const result = parseStopReviewPayload(
    JSON.stringify({ error: { code: "rate_limit", message: "Try again later" }, rawOutput: "" })
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /rate_limit/);
  assert.match(result.reason, /Try again later/);
  assert.doesNotMatch(result.reason, /\[object Object\]/);
});

test("parseStopReviewPayload falls back to the complete payload when no detail field is populated", () => {
  const result = parseStopReviewPayload(
    JSON.stringify({ status: 1, threadId: "thr_failed", error: "", rawOutput: "" })
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /no final output/i);
  assert.match(result.reason, /thr_failed/);
  assert.match(result.reason, /"status":1/);
});

test("parseStopReviewPayload includes the offending bytes for invalid JSON", () => {
  const result = parseStopReviewPayload("not-json: connection closed");

  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid JSON/i);
  assert.match(result.reason, /not-json: connection closed/);
});

test("formatStopReviewProcessFailure reports both streams and removes the known DEP0190 noise", () => {
  const result = formatStopReviewProcessFailure({
    status: 1,
    stderr: [
      "(node:31720) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true.",
      "(Use `node --trace-deprecation ...` to show where the warning was created)",
      "broker disconnected"
    ].join("\n"),
    stdout: JSON.stringify({ status: 1, rawOutput: "THE REAL REASON" })
  });

  assert.match(result, /exit 1/);
  assert.match(result, /stderr:\nbroker disconnected/);
  assert.match(result, /stdout:/);
  assert.match(result, /THE REAL REASON/);
  assert.doesNotMatch(result, /DEP0190/);
  assert.doesNotMatch(result, /trace-deprecation/);
});
