
import {
  ORCHESTRATION_PLAN_VERSION,
  ROLE_CLASSES,
  VALID_EFFORTS
} from "./constants.mjs";
import { deriveBudgetEnvelope, validatePlanAgainstBudget } from "./budget-policy.mjs";

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}
function stringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizePackage(input, index) {
  const pkg = object(input, `packages[${index}]`);
  const id = text(pkg.id, `packages[${index}].id`);
  const role = object(pkg.role, `${id}.role`);
  const roleClass = text(role.class, `${id}.role.class`);
  if (!ROLE_CLASSES.has(roleClass)) throw new Error(`${id}.role.class is not supported: ${roleClass}`);
  if (pkg.access !== "read-only") throw new Error("Phase 1 only supports read-only packages.");
  if (object(pkg.workspace, `${id}.workspace`).mode !== "shared") throw new Error(`${id}.workspace.mode must be shared in Phase 1.`);
  const model = object(pkg.model, `${id}.model`);
  const effort = text(model.effort, `${id}.model.effort`).toLowerCase();
  if (!VALID_EFFORTS.has(effort)) throw new Error(`${id}.model.effort is not supported: ${effort}`);
  const nativeSubagents = object(pkg.nativeSubagents, `${id}.nativeSubagents`);
  const policy = text(nativeSubagents.policy, `${id}.nativeSubagents.policy`);
  if (!new Set(["allowed", "forbidden", "required"]).has(policy)) throw new Error(`${id}.nativeSubagents.policy is invalid.`);
  if (!Number.isInteger(nativeSubagents.maxChildren) || nativeSubagents.maxChildren < 0) {
    throw new Error(`${id}.nativeSubagents.maxChildren must be a non-negative integer.`);
  }
  if (pkg.optional !== undefined && typeof pkg.optional !== "boolean") {
    throw new Error(`${id}.optional must be a boolean.`);
  }
  return {
    id,
    title: text(pkg.title, `${id}.title`),
    role: { class: roleClass, label: text(role.label, `${id}.role.label`) },
    objective: text(pkg.objective, `${id}.objective`),
    dependencies: stringArray(pkg.dependencies ?? [], `${id}.dependencies`),
    optional: pkg.optional ?? false,
    access: "read-only",
    workspace: { mode: "shared" },
    model: { name: text(model.name, `${id}.model.name`), effort },
    nativeSubagents: { policy, maxChildren: nativeSubagents.maxChildren },
    acceptanceCriteria: stringArray(pkg.acceptanceCriteria, `${id}.acceptanceCriteria`),
    expectedOutputs: stringArray(pkg.expectedOutputs, `${id}.expectedOutputs`)
  };
}

function validateGraph(packages) {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  if (byId.size !== packages.length) throw new Error("Package IDs must be unique.");
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      if (!byId.has(dependency)) throw new Error(`${pkg.id} depends on unknown package ${dependency}.`);
      if (dependency === pkg.id) throw new Error(`${pkg.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (id) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      throw new Error(`Package dependency cycle: ${[...stack.slice(start), id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id); stack.push(id);
    for (const dep of byId.get(id).dependencies) visit(dep);
    stack.pop(); visiting.delete(id); visited.add(id);
  };
  for (const pkg of packages) visit(pkg.id);
}

export function normalizeOrchestrationPlan(input, context = {}) {
  const plan = object(input, "plan");
  if (plan.version !== ORCHESTRATION_PLAN_VERSION) throw new Error(`plan.version must be ${ORCHESTRATION_PLAN_VERSION}.`);
  if (!Number.isInteger(plan.complexityScore) || plan.complexityScore < 0 || plan.complexityScore > 10) {
    throw new Error("complexityScore must be an integer between 0 and 10.");
  }
  const packages = (Array.isArray(plan.packages) ? plan.packages : (() => { throw new Error("packages must be an array."); })())
    .map(normalizePackage);
  if (packages.length === 0) throw new Error("At least one package is required.");
  validateGraph(packages);
  const normalized = {
    version: ORCHESTRATION_PLAN_VERSION,
    objective: text(plan.objective, "objective"),
    complexityScore: plan.complexityScore,
    requestedBy: {
      explicit: Boolean(object(plan.requestedBy, "requestedBy").explicit),
      sessionId: plan.requestedBy.sessionId == null ? null : text(plan.requestedBy.sessionId, "requestedBy.sessionId")
    },
    packages
  };
  const budget = deriveBudgetEnvelope(normalized.complexityScore, context.config);
  validatePlanAgainstBudget(normalized, budget);
  return deepFreeze({ ...normalized, budget });
}
