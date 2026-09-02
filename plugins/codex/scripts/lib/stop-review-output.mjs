const STOP_REVIEW_FALLBACK = "Run /codex:review --wait manually or bypass the gate.";
const MAX_DIAGNOSTIC_CHARS = 4000;

function diagnosticText(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }

  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized) {
      return serialized.trim();
    }
  } catch {
    // Fall back to String for values that cannot be serialized.
  }

  return String(value).trim();
}

function truncateDiagnostic(value) {
  const text = diagnosticText(value);
  if (text.length <= MAX_DIAGNOSTIC_CHARS) {
    return text;
  }

  const omitted = text.length - MAX_DIAGNOSTIC_CHARS;
  return `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[output truncated: ${omitted} characters omitted]`;
}

function firstNonEmptyDiagnostic(...values) {
  for (const value of values) {
    const text = diagnosticText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function stripKnownNodeWarnings(value) {
  return diagnosticText(value)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !/^\(node:\d+\) \[DEP0190\] DeprecationWarning:/.test(trimmed) &&
        !/^\(Use `node --trace-deprecation .*` to show where the warning was created\)$/.test(trimmed)
      );
    })
    .join("\n")
    .trim();
}

export function parseStopReviewOutput(rawOutput) {
  const text = diagnosticText(rawOutput);
  if (!text) {
    return {
      ok: false,
      reason: `The stop-time Codex review task returned no final output. ${STOP_REVIEW_FALLBACK}`
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = text.slice(text.indexOf("BLOCK:") + "BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session:\n${truncateDiagnostic(reason)}`
    };
  }

  return {
    ok: false,
    reason: `The stop-time Codex review task returned an unexpected answer:\n${truncateDiagnostic(text)}\n${STOP_REVIEW_FALLBACK}`
  };
}

export function parseStopReviewPayload(rawStdout) {
  const stdout = diagnosticText(rawStdout);
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    const detail = stdout ? `\nOutput:\n${truncateDiagnostic(stdout)}` : "";
    return {
      ok: false,
      reason: `The stop-time Codex review task returned invalid JSON.${detail}\n${STOP_REVIEW_FALLBACK}`
    };
  }

  const output = firstNonEmptyDiagnostic(payload?.error, payload?.rawOutput);
  if (output) {
    return parseStopReviewOutput(output);
  }

  const detail = firstNonEmptyDiagnostic(stdout, payload);
  return {
    ok: false,
    reason: detail
      ? `The stop-time Codex review task returned no final output.\nPayload:\n${truncateDiagnostic(detail)}\n${STOP_REVIEW_FALLBACK}`
      : `The stop-time Codex review task returned no final output. ${STOP_REVIEW_FALLBACK}`
  };
}

export function formatStopReviewProcessFailure(result = {}) {
  const status = Number.isInteger(result.status)
    ? ` (exit ${result.status})`
    : result.signal
      ? ` (signal ${result.signal})`
      : "";
  const sections = [];
  const spawnError = diagnosticText(result.error?.message ?? result.error);
  const stderr = stripKnownNodeWarnings(result.stderr);
  const stdout = diagnosticText(result.stdout);

  if (spawnError) {
    sections.push(`spawn error:\n${truncateDiagnostic(spawnError)}`);
  }
  if (stderr) {
    sections.push(`stderr:\n${truncateDiagnostic(stderr)}`);
  }
  if (stdout) {
    sections.push(`stdout:\n${truncateDiagnostic(stdout)}`);
  }

  const detail = sections.length > 0 ? `\n${sections.join("\n\n")}\n` : " ";
  return `The stop-time Codex review task failed${status}.${detail}${STOP_REVIEW_FALLBACK}`;
}
