export const ENVELOPE_SCHEMA_VERSION = 1;
export const MAX_SUMMARY_LENGTH = 2000;
export const MAX_FINDINGS_PREVIEW = 10;
export const MAX_ENVELOPE_STDOUT_BYTES = 32768;

const SEVERITIES = ["critical", "high", "medium", "low"];
const VALID_STATUSES = new Set(["queued", "running", "completed", "failed", "timed-out", "cancelled"]);
const VALID_VERDICTS = new Set(["approve", "needs-attention", "inconclusive", "not-applicable"]);

function boundedText(value, limit = MAX_SUMMARY_LENGTH) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, limit - 1)}…`, truncated: true };
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

function buildFindingsPreview(findings) {
  return (Array.isArray(findings) ? findings : []).slice(0, MAX_FINDINGS_PREVIEW).map((finding, index) => ({
    severity: typeof finding?.severity === "string" && finding.severity.trim() ? finding.severity.trim() : "low",
    title: boundedText(finding?.title || `Finding ${index + 1}`, 200).text,
    file: typeof finding?.file === "string" && finding.file.trim() ? finding.file.trim() : null,
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
  const parseError = input.parseError ?? null;
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const parsedVerdict = normalizeVerdict(parsed?.verdict);
  const structured = Boolean(parsed) && !parseError;
  const cleanRun = status === "completed" && structured;

  const summarySource = parsed?.summary || input.summaryText || input.rawOutput || "";
  const summary = boundedText(summarySource);

  const envelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    job_id: input.jobId ?? null,
    kind: input.kind ?? null,
    status,
    // A clean verdict is only valid when the workload completed and parsed.
    verdict: cleanRun ? parsedVerdict ?? "inconclusive" : "inconclusive",
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
  if (parseError) {
    envelope.parse_error = boundedText(parseError, 500).text;
  }
  if (Number.isFinite(input.exitCode)) {
    envelope.exit_code = input.exitCode;
  }
  if (input.errorMessage) {
    envelope.error_message = boundedText(input.errorMessage, 500).text;
  }

  return envelope;
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
    `Verdict: ${envelope.verdict}`,
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
