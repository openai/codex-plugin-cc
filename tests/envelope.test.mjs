import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResultEnvelope,
  buildSeverityTally,
  emittedJsonBytes,
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
    line_end: index + 1,
    confidence: 0.5,
    recommendation: "Fix it."
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
  assert.equal(emittedJsonBytes(envelope) < MAX_ENVELOPE_STDOUT_BYTES, true, `emitted ${emittedJsonBytes(envelope)} bytes`);
  assert.equal(Buffer.byteLength(rendered, "utf8") < MAX_ENVELOPE_STDOUT_BYTES, true);
  assert.equal(envelope.summary.length <= 2000, true);
  assert.match(rendered, /Full result: \/tmp\/final\.md/);
  assert.match(rendered, /Log: \/tmp\/run\.log/);
});

test("a parsed object missing required fields is malformed, not an approval", () => {
  for (const parsed of [
    { verdict: "approve" },
    { verdict: "approve", summary: "ok" },
    { verdict: "approve", summary: "ok", findings: [] },
    { verdict: "approve", summary: "", findings: [], next_steps: [] },
    { summary: "ok", findings: [], next_steps: [] },
    { verdict: "approve", summary: "ok", findings: [{ body: "no severity or title" }], next_steps: [] }
  ]) {
    const envelope = buildResultEnvelope({ jobId: "j", kind: "consult", status: "completed", parsed });
    assert.equal(envelope.verdict, "inconclusive", JSON.stringify(parsed));
    assert.equal(typeof envelope.parse_error, "string", JSON.stringify(parsed));
    assert.equal(envelope.structured, false);
    assert.equal(envelope.finding_count, 0);
  }

  const valid = buildResultEnvelope({
    jobId: "j",
    kind: "consult",
    status: "completed",
    parsed: { verdict: "approve", summary: "All good.", findings: [], next_steps: [] }
  });
  assert.equal(valid.verdict, "approve");
  assert.equal(valid.structured, true);
  assert.equal(valid.parse_error, undefined);
});

test("a finding must carry the whole documented shape, not just a severity", () => {
  const complete = {
    severity: "high",
    title: "Missing empty-state guard",
    body: "The change assumes data is always present.",
    file: "src/app.js",
    line_start: 4,
    line_end: 6,
    confidence: 0.87,
    recommendation: "Handle empty collections before indexing."
  };

  const valid = buildResultEnvelope({
    jobId: "j",
    kind: "review",
    status: "completed",
    parsed: { verdict: "needs-attention", summary: "One issue.", findings: [complete], next_steps: [] }
  });
  assert.equal(valid.verdict, "needs-attention");
  assert.equal(valid.structured, true);
  assert.equal(valid.finding_count, 1);

  const brokenFindings = [
    { severity: "high", title: "only these two" },
    { ...complete, body: undefined },
    { ...complete, file: "" },
    { ...complete, line_start: "4" },
    { ...complete, line_end: 2 },
    { ...complete, confidence: 1.5 },
    { ...complete, confidence: undefined },
    { ...complete, recommendation: undefined },
    { ...complete, severity: "blocker" }
  ];

  for (const finding of brokenFindings) {
    const envelope = buildResultEnvelope({
      jobId: "j",
      kind: "review",
      status: "completed",
      parsed: { verdict: "approve", summary: "Looks fine.", findings: [finding], next_steps: [] }
    });
    assert.equal(envelope.verdict, "inconclusive", JSON.stringify(finding));
    assert.equal(envelope.structured, false, JSON.stringify(finding));
    assert.match(envelope.parse_error, /^Finding 1 /);
  }
});

test("the envelope stays inside its byte budget even with hostile field values", () => {
  const envelope = buildResultEnvelope({
    jobId: "review-3",
    kind: "review",
    status: "completed",
    parsed: {
      verdict: "needs-attention",
      summary: "🙂".repeat(5000),
      findings: Array.from({ length: 40 }, (_, index) => ({
        severity: "critical",
        title: "t".repeat(5000),
        body: "b",
        file: `src/${"nested-directory/".repeat(200)}file-${index}.ts`,
        line_start: index + 1,
        line_end: index + 1,
        confidence: 0.5,
        recommendation: "r".repeat(3000)
      })),
      next_steps: []
    },
    finalOutputPath: "/tmp/final.md",
    logPath: "/tmp/run.log"
  });

  assert.equal(emittedJsonBytes(envelope) < MAX_ENVELOPE_STDOUT_BYTES, true, `emitted ${emittedJsonBytes(envelope)} bytes`);
  assert.equal(Buffer.byteLength(renderResultEnvelope(envelope), "utf8") < MAX_ENVELOPE_STDOUT_BYTES, true);
  assert.equal(Buffer.byteLength(envelope.summary, "utf8") <= 2000, true);
  for (const finding of envelope.findings_preview) {
    assert.equal(Buffer.byteLength(finding.file, "utf8") <= 201, true);
    assert.equal(Buffer.byteLength(finding.title, "utf8") <= 201, true);
    assert.equal(["critical", "high", "medium", "low"].includes(finding.severity), true);
  }
  assert.equal(envelope.finding_count, 40);
  assert.equal(envelope.truncated, true);
});

test("a workload that answers in prose reports a missing verdict, not a failed one", () => {
  const completed = buildResultEnvelope({
    jobId: "review-4",
    kind: "review",
    status: "completed",
    parsed: null,
    unstructuredKind: true,
    summaryText: "Reviewed uncommitted changes. No material issues found."
  });
  assert.equal(completed.verdict, "not-applicable");
  assert.equal(completed.structured, false);
  assert.equal(completed.parse_error, undefined);
  assert.match(completed.summary, /No material issues found/);

  const timedOut = buildResultEnvelope({
    jobId: "review-5",
    kind: "review",
    status: "timed-out",
    parsed: null,
    unstructuredKind: false,
    parseError: "The review deadline expired before Codex finished."
  });
  assert.equal(timedOut.verdict, "inconclusive");
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
