
import fs from "node:fs";

const SCHEMA_URL = new URL("./schemas/package-result.schema.json", import.meta.url);
let cachedSchema = null;

function arrayOfStrings(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${label} must be an array of strings.`);
  return value.map((entry) => entry.trim()).filter(Boolean);
}

export function readPackageResultSchema() {
  cachedSchema ??= JSON.parse(fs.readFileSync(SCHEMA_URL, "utf8"));
  return cachedSchema;
}

export function validatePackageResult(input, packageId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Package result must be an object.");
  if (input.packageId !== packageId) throw new Error(`Package result ID ${input.packageId ?? "<missing>"} does not match ${packageId}.`);
  if (!new Set(["completed", "partial", "blocked", "failed"]).has(input.status)) throw new Error(`${packageId}.status is invalid.`);
  if (typeof input.summary !== "string" || !input.summary.trim()) throw new Error(`${packageId}.summary is required.`);
  if (!Array.isArray(input.changedFiles) || input.changedFiles.length !== 0) throw new Error("Phase 1 package results must contain an empty changedFiles array.");
  if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1) throw new Error(`${packageId}.confidence must be between 0 and 1.`);
  if (!input.verification || typeof input.verification.passed !== "boolean") throw new Error(`${packageId}.verification.passed must be a boolean.`);
  const evidence = Array.isArray(input.evidence) ? input.evidence.map((entry, index) => {
    if (!entry || typeof entry !== "object" || !new Set(["file", "command", "observation"]).has(entry.type)) {
      throw new Error(`${packageId}.evidence[${index}] is invalid.`);
    }
    return {
      type: entry.type,
      description: String(entry.description ?? "").trim(),
      path: entry.path ?? null,
      lineStart: entry.lineStart ?? null,
      lineEnd: entry.lineEnd ?? null,
      command: entry.command ?? null,
      exitCode: entry.exitCode ?? null
    };
  }) : (() => { throw new Error(`${packageId}.evidence must be an array.`); })();
  return {
    packageId,
    status: input.status,
    summary: input.summary.trim(),
    claims: arrayOfStrings(input.claims, `${packageId}.claims`),
    evidence,
    changedFiles: [],
    verification: { passed: input.verification.passed, commands: arrayOfStrings(input.verification.commands, `${packageId}.verification.commands`) },
    residualRisks: arrayOfStrings(input.residualRisks, `${packageId}.residualRisks`),
    confidence: input.confidence,
    followUpRequests: arrayOfStrings(input.followUpRequests, `${packageId}.followUpRequests`)
  };
}

export function buildOrchestrationResult(state) {
  return {
    orchestrationId: state.id,
    status: state.status,
    objective: state.plan.objective,
    planRevision: state.planRevision,
    packages: state.plan.packages.map((pkg) => {
      const current = state.packages[pkg.id];
      return {
        id: pkg.id,
        title: pkg.title,
        role: pkg.role,
        model: pkg.model,
        status: current.status,
        result: current.result ?? null,
        threadId: current.threadId ?? null,
        nativeChildThreadIds: current.nativeChildThreadIds ?? [],
        nativeSubagentDegraded: Boolean(current.nativeSubagentDegraded),
        nativeSubagentDegradationReason: current.nativeSubagentDegradationReason ?? null
      };
    }),
    omissions: state.omissions ?? [],
    remainingWork: state.remainingWork ?? []
  };
}
