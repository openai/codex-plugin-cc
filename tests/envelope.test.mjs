import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResultEnvelope,
  buildSeverityTally,
  MAX_ENVELOPE_STDOUT_BYTES,
  MAX_FINDINGS_PREVIEW,
  renderResultEnvelope
} from "../plugins/codex/scripts/lib/envelope.mjs";

function makeFindings(count, severity = "medium") {
  return Array.from({ length: count }, (_, index) => ({
    severity,
    title: `Finding ${index + 1}`,
    body: "Body",
    file: "src/app.js",
    line_start: index + 1,
    line_end: index + 1
  }));
}

test("severity counts cover zero, one, and many findings", () => {
  assert.deepEqual(buildSeverityTally([]), { critical: 0, high: 0, medium: 0, low: 0 });
  assert.deepEqual(buildSeverityTally([{ severity: "high" }]), { critical: 0, high: 1, medium: 0, low: 0 });
  assert.deepEqual(
    buildSeverityTally([
      { severity: "critical" },
      { severity: "critical" },
      { severity: "high" },
      { severity: "medium" },
      { severity: "low" },
      { severity: "bogus" }
    ]),
    { critical: 2, high: 1, medium: 1, low: 2 }
  );
});

test("findings are counted independently of preview truncation", () => {
  const envelope = buildResultEnvelope({
    jobId: "review-1",
    kind: "review",
    status: "completed",
    parsed: { verdict: "needs-attention", summary: "Lots to fix.", findings: makeFindings(25), next_steps: [] }
  });

  assert.equal(envelope.finding_count, 25);
  assert.equal(envelope.findings_preview.length, MAX_FINDINGS_PREVIEW);
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.severity_tally.medium, 25);
});

test("a huge transcript still renders a bounded envelope on stdout", () => {
  const huge = "x".repeat(715 * 1024 + 1);
  const envelope = buildResultEnvelope({
    jobId: "review-2",
    kind: "review",
    status: "completed",
    rawOutput: huge,
    summaryText: huge,
    parsed: { verdict: "approve", summary: huge, findings: makeFindings(200, "low"), next_steps: [] },
    finalOutputPath: "/tmp/final.md",
    logPath: "/tmp/run.log"
  });

  const rendered = renderResultEnvelope(envelope);
  assert.equal(Buffer.byteLength(JSON.stringify(envelope), "utf8") < MAX_ENVELOPE_STDOUT_BYTES, true);
  assert.equal(Buffer.byteLength(rendered, "utf8") < MAX_ENVELOPE_STDOUT_BYTES, true);
  assert.equal(envelope.summary.length <= 2000, true);
  assert.match(rendered, /Full result: \/tmp\/final\.md/);
  assert.match(rendered, /Log: \/tmp\/run\.log/);
});

test("malformed structured output is inconclusive, never approved", () => {
  const envelope = buildResultEnvelope({
    jobId: "consult-1",
    kind: "consult",
    status: "completed",
    parsed: null,
    parseError: "Unexpected token o in JSON at position 1",
    rawOutput: "not valid json"
  });

  assert.equal(envelope.verdict, "inconclusive");
  assert.match(envelope.parse_error, /Unexpected token/);
  assert.equal(envelope.finding_count, 0);
});

test("a timeout keeps its non-success status even when the partial answer looks clean", () => {
  const envelope = buildResultEnvelope({
    jobId: "consult-2",
    kind: "consult",
    status: "timed-out",
    exitCode: 124,
    parsed: { verdict: "approve", summary: "Everything looks fine.", findings: [], next_steps: [] }
  });

  assert.equal(envelope.status, "timed-out");
  assert.equal(envelope.verdict, "inconclusive");
  assert.equal(envelope.partial_verdict, "approve");
  assert.equal(envelope.exit_code, 124);
});

test("severity keys are always present and integer valued", () => {
  const envelope = buildResultEnvelope({ jobId: "x", kind: "review", status: "failed" });
  for (const key of ["critical", "high", "medium", "low"]) {
    assert.equal(Number.isInteger(envelope.severity_tally[key]), true);
  }
  assert.equal(envelope.verdict, "inconclusive");
});
