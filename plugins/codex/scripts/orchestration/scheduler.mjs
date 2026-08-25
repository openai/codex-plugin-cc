
import { PACKAGE_TERMINAL_STATUSES } from "./constants.mjs";

function copy(state) {
  return { packages: Object.fromEntries(Object.entries(state.packages).map(([id, value]) => [id, { ...value, dependencies: [...value.dependencies] }])) };
}
function transition(state, id, allowed, patch) {
  const current = state.packages[id];
  if (!current) throw new Error(`Unknown package ${id}.`);
  if (!allowed.includes(current.status)) throw new Error(`Cannot transition ${id} from ${current.status}.`);
  const next = copy(state); next.packages[id] = { ...next.packages[id], ...patch }; return next;
}

export function createSchedulerState(plan) {
  return {
    packages: Object.fromEntries(plan.packages.map((pkg) => [pkg.id, {
      id: pkg.id, status: "planned", dependencies: [...pkg.dependencies], optional: pkg.optional, attempt: 0, error: null
    }]))
  };
}
export function getReadyPackageIds(state) {
  return Object.values(state.packages).filter((pkg) => pkg.status === "planned" && pkg.dependencies.every((id) => {
    const status = state.packages[id].status; return status === "completed" || status === "partial";
  })).map((pkg) => pkg.id);
}
export function markPackageReady(state, id) { return transition(state, id, ["planned"], { status: "ready" }); }
export function markPackageRunning(state, id, attempt) { return transition(state, id, ["ready"], { status: "running", attempt }); }
export function markPackageCompleted(state, id, resultStatus = "completed") {
  if (!new Set(["completed", "partial", "blocked", "failed"]).has(resultStatus)) throw new Error(`Invalid result status ${resultStatus}.`);
  return transition(state, id, ["running"], { status: resultStatus });
}
export function markPackageFailed(state, id, error) { return transition(state, id, ["running", "ready", "planned"], { status: "failed", error: String(error ?? "failed") }); }
export function markPackageCancelled(state, id) {
  const current = state.packages[id];
  if (PACKAGE_TERMINAL_STATUSES.has(current.status)) return state;
  return transition(state, id, ["planned", "ready", "running", "cancelling"], { status: "cancelled" });
}
export function propagateBlockedPackages(state) {
  let next = state; let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of Object.values(next.packages)) {
      if (!["planned", "ready"].includes(pkg.status)) continue;
      if (pkg.dependencies.some((id) => ["failed", "blocked", "cancelled"].includes(next.packages[id].status))) {
        next = transition(next, pkg.id, [pkg.status], { status: "blocked", error: "Required dependency did not complete." });
        changed = true;
      }
    }
  }
  return next;
}
export function deriveOrchestrationStatus(state) {
  const values = Object.values(state.packages);
  if (values.some((pkg) => !PACKAGE_TERMINAL_STATUSES.has(pkg.status))) return "running";
  const required = values.filter((pkg) => !pkg.optional);
  const usable = values.filter((pkg) => ["completed", "partial"].includes(pkg.status));
  if (required.every((pkg) => ["completed", "partial"].includes(pkg.status))) {
    return values.some((pkg) => pkg.optional && !["completed", "partial"].includes(pkg.status)) ? "completed-with-omissions" : "completed";
  }
  if (usable.length > 0) return "degraded";
  if (required.some((pkg) => pkg.status === "blocked") && required.every((pkg) => ["blocked", "cancelled"].includes(pkg.status))) return "blocked";
  return values.every((pkg) => pkg.status === "cancelled") ? "cancelled" : "failed";
}
