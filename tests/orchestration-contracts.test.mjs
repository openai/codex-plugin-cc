
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ORCHESTRATION_CONFIG } from "../plugins/codex/scripts/orchestration/config.mjs";
import { normalizeOrchestrationPlan } from "../plugins/codex/scripts/orchestration/plan-contract.mjs";
import { validatePackageResult } from "../plugins/codex/scripts/orchestration/result-contract.mjs";

function plan() { return { version: 1, objective: "Compare independent hypotheses", complexityScore: 5, requestedBy: { explicit: true, sessionId: null }, packages: [
  { id: "pkg-a", title: "A", role: { class: "explorer", label: "a" }, objective: "Inspect A", dependencies: [], optional: false, access: "read-only", workspace: { mode: "shared" }, model: { name: "gpt-5.6-luna", effort: "high" }, nativeSubagents: { policy: "allowed", maxChildren: 1 }, acceptanceCriteria: ["Evidence"], expectedOutputs: ["claims"] },
  { id: "pkg-b", title: "B", role: { class: "verifier", label: "b" }, objective: "Verify A", dependencies: ["pkg-a"], access: "read-only", workspace: { mode: "shared" }, model: { name: "gpt-5.6-terra", effort: "high" }, nativeSubagents: { policy: "forbidden", maxChildren: 0 }, acceptanceCriteria: ["Compare"], expectedOutputs: ["evidence"] }
] }; }
test("normalizes a valid read-only plan", () => { const value = normalizeOrchestrationPlan(plan(), { config: DEFAULT_ORCHESTRATION_CONFIG }); assert.equal(value.packages[1].optional, false); assert.equal(value.budget.workerParallelism, 3); });
test("rejects non-boolean optional", () => { const value = plan(); value.packages[0].optional = "false"; assert.throws(() => normalizeOrchestrationPlan(value, { config: DEFAULT_ORCHESTRATION_CONFIG }), /optional must be a boolean/); });
test("rejects write packages and cycles", () => { const value = plan(); value.packages[0].access = "write"; assert.throws(() => normalizeOrchestrationPlan(value, { config: DEFAULT_ORCHESTRATION_CONFIG }), /read-only/); const cycle = plan(); cycle.packages[0].dependencies = ["pkg-b"]; assert.throws(() => normalizeOrchestrationPlan(cycle, { config: DEFAULT_ORCHESTRATION_CONFIG }), /cycle/); });
test("validates canonical package results", () => { const result = validatePackageResult({ packageId: "pkg-a", status: "completed", summary: "done", claims: [], evidence: [], changedFiles: [], verification: { passed: true, commands: [] }, residualRisks: [], confidence: 0.8, followUpRequests: [] }, "pkg-a"); assert.equal(result.status, "completed"); });
