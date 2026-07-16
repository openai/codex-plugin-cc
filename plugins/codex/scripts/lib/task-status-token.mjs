const DISPATCHED_JOB_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DISPATCHED_TOKEN_PATTERN = /^\[\[codex-task status=dispatched id=([A-Za-z0-9._:-]+)\]\]$/;

export const TASK_COMPLETE_STATUS_TOKEN = "[[codex-task status=complete]]";

// The companion and PostToolUse hook share this standalone-line sentinel scheme.
// A line is machine-readable only when it exactly matches one of these forms:
// [[codex-task status=complete]]
// [[codex-task status=dispatched id=<jobId>]]
// The fixed prefix, status key, and closing brackets make the marker greppable
// and keep normal Codex prose from being treated as authoritative state.
export function buildTaskCompleteStatusToken() {
  return TASK_COMPLETE_STATUS_TOKEN;
}

export function buildTaskDispatchedStatusToken(jobId) {
  const normalizedJobId = String(jobId ?? "").trim();
  if (!DISPATCHED_JOB_ID_PATTERN.test(normalizedJobId)) {
    throw new Error(`Invalid Codex task job id for status token: ${normalizedJobId || "(empty)"}`);
  }
  return `[[codex-task status=dispatched id=${normalizedJobId}]]`;
}

export function appendTaskStatusToken(output, token) {
  const text = String(output ?? "");
  const normalizedOutput = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${normalizedOutput}${token}\n`;
}

export function parseTaskStatusToken(output) {
  let parsed = null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine === TASK_COMPLETE_STATUS_TOKEN) {
      parsed = { status: "complete", id: null };
      continue;
    }

    const dispatchedMatch = trimmedLine.match(DISPATCHED_TOKEN_PATTERN);
    if (dispatchedMatch) {
      parsed = { status: "dispatched", id: dispatchedMatch[1] };
    }
  }
  return parsed;
}
