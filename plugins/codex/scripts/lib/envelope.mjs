export const ENVELOPE_SCHEMA_VERSION = 1;
export const MAX_SUMMARY_LENGTH = 2000;
export const MAX_FINDINGS_PREVIEW = 10;
export const MAX_ENVELOPE_STDOUT_BYTES = 32768;

const SEVERITIES = ["critical", "high", "medium", "low"];
const VALID_STATUSES = new Set(["queued", "running", "completed", "failed", "timed-out", "cancelled"]);
const VALID_VERDICTS = new Set(["approve", "needs-attention", "inconclusive", "not-applicable"]);
const MAX_TITLE_LENGTH = 200;
const MAX_FILE_LENGTH = 200;
// Leave headroom below the stdout budget so the rendered form fits as well.
const MAX_ENVELOPE_JSON_BYTES = 24576;

/** Bounded by characters and by bytes: a character limit alone is not a size limit. */
function boundedText(value, limit = MAX_SUMMARY_LENGTH) {
  const text = String(value ?? "").trim();
  if (text.length <= limit && Buffer.byteLength(text, "utf8") <= limit) {
    return { text, truncated: false };
  }

  let clipped = [...text].slice(0, limit).join("");
  while (clipped && Buffer.byteLength(clipped, "utf8") > limit - 1) {
    clipped = [...clipped].slice(0, Math.max(0, Math.floor([...clipped].length * 0.9) - 1)).join("");
  }
  return { text: `${clipped}…`, truncated: true };
}

/**
 * Structured output is only structured if it carries the fields the contract
 * promises. A bare `{"verdict":"approve"}` is malformed, not an approval.
 */
export function validateStructuredResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }

  for (const [index, finding] of data.findings.entries()) {
    const error = validateFinding(finding);
    if (error) {
      return `Finding ${index + 1} ${error}`;
    }
  }

  return null;
}

/**
 * The full finding shape from schemas/review-output.schema.json. A finding that
 * names a severity and nothing else is not a finding this contract can report.
 */
function validateFinding(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return "is not an object.";
  }
  for (const field of ["severity", "title", "body", "file"]) {
    if (typeof finding[field] !== "string" || !finding[field].trim()) {
      return `is missing a non-empty string \`${field}\`.`;
    }
  }
  if (!SEVERITIES.includes(finding.severity.trim().toLowerCase())) {
    return `has severity "${finding.severity}", which is not one of ${SEVERITIES.join(", ")}.`;
  }
  for (const field of ["line_start", "line_end"]) {
    if (!Number.isInteger(finding[field]) || finding[field] < 1) {
      return `is missing a positive integer \`${field}\`.`;
    }
  }
  if (finding.line_end < finding.line_start) {
    return "has `line_end` before `line_start`.";
  }
  if (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
    return "is missing a `confidence` between 0 and 1.";
  }
  if (typeof finding.recommendation !== "string") {
    return "is missing a string `recommendation`.";
  }
  return null;
}

/**
 * Size is measured on the JSON that is actually printed — pretty-printed, the
 * same form `outputResult` emits — never on a compact form nobody sees.
 */
export function emittedJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

/** Last line of defence: the envelope itself must fit the stdout budget. */
function enforceEnvelopeBudget(envelope) {
  const jsonBytes = () => emittedJsonBytes(envelope);

  while (envelope.findings_preview.length > 0 && jsonBytes() > MAX_ENVELOPE_JSON_BYTES) {
    envelope.findings_preview.pop();
    envelope.truncated = true;
  }
  if (jsonBytes() > MAX_ENVELOPE_JSON_BYTES) {
    envelope.summary = boundedText(envelope.summary, 500).text;
    envelope.truncated = true;
  }
  if (jsonBytes() > MAX_ENVELOPE_JSON_BYTES) {
    envelope.summary = "";
    envelope.parse_error = envelope.parse_error ? boundedText(envelope.parse_error, 200).text : envelope.parse_error;
    envelope.error_message = envelope.error_message ? boundedText(envelope.error_message, 200).text : envelope.error_message;
    envelope.truncated = true;
  }

  return envelope;
}

export function buildSeverityTally(findings) {
  const tally = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of Array.isArray(findings) ? findings : []) {
    const severity = typeof finding?.severity === "string" ? finding.severity.trim().toLowerCase() : "";
    if (SEVERITIES.includes(severity)) {
      tally[severity] += 1;
    } else {
      tally.low += 1;
    }
  }
  return tally;
}

function normalizeSeverity(severity) {
  const normalized = typeof severity === "string" ? severity.trim().toLowerCase() : "";
  return SEVERITIES.includes(normalized) ? normalized : "low";
}

function buildFindingsPreview(findings) {
  return (Array.isArray(findings) ? findings : []).slice(0, MAX_FINDINGS_PREVIEW).map((finding, index) => ({
    severity: normalizeSeverity(finding?.severity),
    title: boundedText(finding?.title || `Finding ${index + 1}`, MAX_TITLE_LENGTH).text,
    file:
      typeof finding?.file === "string" && finding.file.trim()
        ? boundedText(finding.file, MAX_FILE_LENGTH).text
        : null,
    line_start: Number.isInteger(finding?.line_start) ? finding.line_start : null
  }));
}

function normalizeStatus(status) {
  const normalized = String(status ?? "").trim();
  return VALID_STATUSES.has(normalized) ? normalized : "failed";
}

function normalizeVerdict(verdict) {
  const normalized = String(verdict ?? "").trim().toLowerCase();
  return VALID_VERDICTS.has(normalized) ? normalized : null;
}

/**
 * Build the bounded result envelope every review and consult returns on stdout.
 * The complete log and final answer stay on disk; nothing unbounded goes in here.
 */
export function buildResultEnvelope(input = {}) {
  const status = normalizeStatus(input.status);
  const parsed = input.parsed && typeof input.parsed === "object" && !Array.isArray(input.parsed) ? input.parsed : null;
  // Shape is part of validity: a parsed object missing required fields is
  // malformed output, and malformed output can never read as an approval.
  const shapeError = parsed ? validateStructuredResult(parsed) : null;
  const parseError = input.parseError ?? shapeError ?? null;
  const findings = shapeError ? [] : Array.isArray(parsed?.findings) ? parsed.findings : [];
  const parsedVerdict = shapeError ? null : normalizeVerdict(parsed?.verdict);
  const structured = Boolean(parsed) && !parseError;
  const cleanRun = status === "completed" && structured;
  // Some workloads (the built-in reviewer) return prose by design: that is a
  // missing verdict, not a failed one.
  const unstructuredKind = Boolean(input.unstructuredKind) && !input.parseError;
  const unstructuredVerdict = status === "completed" ? "not-applicable" : "inconclusive";

  const summarySource = parsed?.summary || input.summaryText || input.rawOutput || "";
  const summary = boundedText(summarySource);

  const envelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    job_id: input.jobId ?? null,
    kind: input.kind ?? null,
    status,
    // A clean verdict is only valid when the workload completed and parsed.
    verdict: cleanRun ? parsedVerdict ?? "inconclusive" : unstructuredKind ? unstructuredVerdict : "inconclusive",
    structured,
    severity_tally: buildSeverityTally(findings),
    summary: summary.text,
    findings_preview: buildFindingsPreview(findings),
    finding_count: findings.length,
    truncated: summary.truncated || findings.length > MAX_FINDINGS_PREVIEW,
    duration_ms: Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : null,
    queue_wait_ms: Number.isFinite(input.queueWaitMs) ? Math.round(input.queueWaitMs) : null,
    thread_id: input.threadId ?? null,
    final_output_path: input.finalOutputPath ?? null,
    log_path: input.logPath ?? null
  };

  if (!cleanRun && parsedVerdict) {
    envelope.partial_verdict = parsedVerdict;
  }
  if (parseError && !unstructuredKind) {
    envelope.parse_error = boundedText(parseError, 500).text;
  }
  if (Number.isFinite(input.exitCode)) {
    envelope.exit_code = input.exitCode;
  }
  if (input.errorMessage) {
    envelope.error_message = boundedText(input.errorMessage, 500).text;
  }

  return enforceEnvelopeBudget(envelope);
}

export function buildInconclusiveEnvelope(input = {}) {
  return buildResultEnvelope({
    ...input,
    parsed: null,
    parseError: input.parseError ?? input.errorMessage ?? "No usable Codex output was produced."
  });
}

export function renderResultEnvelope(envelope) {
  const tally = envelope.severity_tally ?? {};
  const lines = [
    `# Codex ${envelope.kind ?? "result"}`,
    "",
    `Job: ${envelope.job_id ?? "unknown"}`,
    `Status: ${envelope.status}`,
    `Verdict: ${envelope.verdict}${
      envelope.structured === false && envelope.verdict === "not-applicable"
        ? " (this reviewer answers in prose; read the summary or the full result)"
        : ""
    }`,
    `Findings: ${envelope.finding_count} (critical ${tally.critical ?? 0}, high ${tally.high ?? 0}, medium ${tally.medium ?? 0}, low ${tally.low ?? 0})`
  ];

  if (envelope.partial_verdict) {
    lines.push(`Partial verdict: ${envelope.partial_verdict} (not trusted; the run did not finish cleanly)`);
  }
  if (envelope.duration_ms != null) {
    lines.push(`Duration: ${Math.round(envelope.duration_ms / 1000)}s`);
  }
  if (envelope.queue_wait_ms != null) {
    lines.push(`Queue wait: ${Math.round(envelope.queue_wait_ms / 1000)}s`);
  }

  lines.push("", envelope.summary || "No summary was produced.");

  if (envelope.findings_preview?.length) {
    lines.push("", "Findings preview:");
    for (const finding of envelope.findings_preview) {
      const location = finding.file ? ` (${finding.file}${finding.line_start ? `:${finding.line_start}` : ""})` : "";
      lines.push(`- [${finding.severity}] ${finding.title}${location}`);
    }
    if (envelope.finding_count > envelope.findings_preview.length) {
      lines.push(`- ... ${envelope.finding_count - envelope.findings_preview.length} more in the full result.`);
    }
  }

  if (envelope.parse_error) {
    lines.push("", `Parse error: ${envelope.parse_error}`);
  }
  if (envelope.error_message) {
    lines.push("", `Error: ${envelope.error_message}`);
  }

  lines.push("");
  if (envelope.thread_id) {
    lines.push(`Codex session ID: ${envelope.thread_id}`);
    lines.push(`Resume in Codex: codex resume ${envelope.thread_id}`);
  }
  if (envelope.final_output_path) {
    lines.push(`Full result: ${envelope.final_output_path}`);
  }
  if (envelope.log_path) {
    lines.push(`Log: ${envelope.log_path}`);
  }
  if (envelope.job_id) {
    lines.push(`Full text: /codex:result ${envelope.job_id} --full`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
