/**
 * Specialist fan-out: runs 5 parallel Codex review passes, each through a domain lens.
 * Kept in a separate file to minimize merge surface with upstream.
 */

import path from "node:path";
import { runAppServerTurn, parseStructuredOutput, readOutputSchema } from "./codex.mjs";

const REVIEW_SCHEMA_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../schemas/review-output.schema.json"
);

/**
 * @typedef {{
 *   name: string,
 *   label: string,
 *   suffix: string
 * }} Specialist
 */

/** @type {Specialist[]} */
const SPECIALISTS = [
  {
    name: "security",
    label: "Security",
    suffix:
      "Focus exclusively on security vulnerabilities. Ignore style, performance, and operational concerns. Go deep on auth flows, input validation, secret handling, and data exposure paths."
  },
  {
    name: "reliability",
    label: "Reliability",
    suffix:
      "Focus exclusively on reliability risks. Ignore security and style. Go deep on error paths, timeout behavior, retry logic, circuit breakers, and what happens when dependencies fail."
  },
  {
    name: "cost",
    label: "Cost",
    suffix:
      "Focus exclusively on cost implications. Ignore security and correctness. Go deep on resource sizing, auto-scaling behavior, billing surprises, and whether cheaper alternatives exist."
  },
  {
    name: "blast-radius",
    label: "Blast Radius",
    suffix:
      "Focus exclusively on blast radius. Ignore style and minor bugs. Go deep on what else breaks if this fails, which environments are affected, and whether this can be safely rolled back."
  },
  {
    name: "operability",
    label: "Operability",
    suffix:
      "Focus exclusively on operability. Ignore correctness logic. Go deep on whether this change is observable (logs, metrics, traces), debuggable, and whether it increases on-call burden. Flag monitoring gaps for new resources."
  }
];

/**
 * Run a single specialist pass.
 * @param {string} repoRoot
 * @param {string} basePrompt
 * @param {Specialist} specialist
 * @param {object} options
 * @returns {Promise<{specialist: Specialist, parsed: object|null, parseError: string|null, rawOutput: string, status: number, error: unknown}>}
 */
async function runSpecialistPass(repoRoot, basePrompt, specialist, options = {}) {
  const prompt = `${basePrompt}\n\n<specialist_focus>\n${specialist.suffix}\n</specialist_focus>`;
  const schema = readOutputSchema(REVIEW_SCHEMA_PATH);

  try {
    const result = await runAppServerTurn(repoRoot, {
      prompt,
      model: options.model ?? null,
      sandbox: "read-only",
      outputSchema: schema,
      onProgress: options.onProgress ?? null
    });

    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.error?.message ?? result.stderr
    });

    return {
      specialist,
      parsed: parsed.parsed,
      parseError: parsed.parseError,
      rawOutput: parsed.rawOutput ?? "",
      status: result.status,
      error: null
    };
  } catch (error) {
    return {
      specialist,
      parsed: null,
      parseError: error instanceof Error ? error.message : String(error),
      rawOutput: "",
      status: 1,
      error
    };
  }
}

/**
 * Reduce individual verdicts into a single merged verdict.
 * any needs-attention -> needs-attention, else approve.
 * @param {Array<{verdict: string|null}>} results
 * @returns {string}
 */
function reduceVerdicts(results) {
  for (const r of results) {
    if (r.verdict === "needs-attention") return "needs-attention";
  }
  return "approve";
}

/**
 * Tag each finding with its specialist source.
 * @param {object} parsed
 * @param {string} source
 * @returns {object[]}
 */
function tagFindings(parsed, source) {
  if (!parsed?.findings || !Array.isArray(parsed.findings)) return [];
  return parsed.findings.map((f) => ({ ...f, source }));
}

/**
 * Run all 5 specialist passes in parallel and merge results.
 * @param {string} repoRoot
 * @param {string} basePrompt
 * @param {object} options
 * @returns {Promise<{verdict: string, results: object[], allFindings: object[], rendered: string, failedCount: number}>}
 */
export async function runFanOut(repoRoot, basePrompt, options = {}) {
  const passes = await Promise.all(
    SPECIALISTS.map((specialist) =>
      runSpecialistPass(repoRoot, basePrompt, specialist, options)
    )
  );

  const succeeded = passes.filter((p) => p.parsed && !p.error);
  const failed = passes.filter((p) => !p.parsed || p.error);

  // If 3+ passes fail, report overall failure
  if (failed.length >= 3) {
    return {
      verdict: "needs-attention",
      results: passes,
      allFindings: [],
      rendered: renderFanOutFailure(passes),
      failedCount: failed.length
    };
  }

  // Merge findings with source tags
  const allFindings = [];
  for (const pass of succeeded) {
    allFindings.push(...tagFindings(pass.parsed, pass.specialist.name));
  }

  // Reduce verdicts
  const verdictInputs = succeeded.map((p) => ({
    verdict: p.parsed?.verdict ?? "approve"
  }));
  const verdict = reduceVerdicts(verdictInputs);

  // Merge next_steps
  const allNextSteps = [];
  const seenSteps = new Set();
  for (const pass of succeeded) {
    for (const step of pass.parsed?.next_steps ?? []) {
      const normalized = step.trim().toLowerCase();
      if (!seenSteps.has(normalized)) {
        seenSteps.add(normalized);
        allNextSteps.push(step);
      }
    }
  }

  const rendered = renderFanOutResult(verdict, passes, allFindings, allNextSteps);

  return {
    verdict,
    results: passes,
    allFindings,
    rendered,
    failedCount: failed.length
  };
}

function severityRank(severity) {
  switch (severity) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    default: return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function renderSpecialistSection(pass) {
  const lines = [`### ${pass.specialist.label}`, ""];

  if (pass.error || !pass.parsed) {
    lines.push(`**Failed**: ${pass.parseError ?? "Unknown error"}`);
    return lines.join("\n");
  }

  const findings = (pass.parsed.findings ?? [])
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    for (const f of findings) {
      const lineSuffix = formatLineRange(f);
      lines.push(`- [${f.severity}] ${f.title} (${f.file}${lineSuffix})`);
      lines.push(`  ${f.body}`);
      if (f.recommendation) {
        lines.push(`  Recommendation: ${f.recommendation}`);
      }
    }
  }

  return lines.join("\n");
}

function renderFanOutResult(verdict, passes, allFindings, nextSteps) {
  const succeeded = passes.filter((p) => p.parsed && !p.error);
  const failed = passes.filter((p) => !p.parsed || p.error);

  const lines = [
    "# Codex Specialist Review",
    "",
    `Passes: ${succeeded.length}/5 succeeded`,
    `Verdict: ${verdict}`,
    ""
  ];

  if (failed.length > 0) {
    lines.push(`Failed passes: ${failed.map((p) => p.specialist.label).join(", ")}`, "");
  }

  lines.push("---", "");

  for (const pass of passes) {
    lines.push(renderSpecialistSection(pass));
    lines.push("");
  }

  lines.push("---", "");

  if (nextSteps.length > 0) {
    lines.push("### Recommendations", "");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderFanOutFailure(passes) {
  const failed = passes.filter((p) => !p.parsed || p.error);
  const lines = [
    "# Codex Specialist Review",
    "",
    `**Overall failure**: ${failed.length}/5 specialist passes failed.`,
    "Consider running without `--specialist` for a single-pass review.",
    "",
    "Failed passes:"
  ];

  for (const pass of failed) {
    lines.push(`- ${pass.specialist.label}: ${pass.parseError ?? "Unknown error"}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export { SPECIALISTS };
