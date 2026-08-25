
import { buildOrchestrationResult } from "./result-contract.mjs";
import { appendOrchestrationEvent, isTerminalState, listOrchestrations, updateOrchestrationState, writePackageResult } from "./state-store.mjs";

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
function descendants(plan, roots) {
  const blocked = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of plan.packages) {
      if (!blocked.has(pkg.id) && pkg.dependencies.some((dep) => roots.has(dep) || blocked.has(dep))) {
        blocked.add(pkg.id); changed = true;
      }
    }
  }
  return blocked;
}
export async function reconcilePhase1ControllerLoss(workspaceRoot, identity) {
  for (const state of listOrchestrations(workspaceRoot)) {
    if (isTerminalState(state)) continue;
    const previous = state.controller;
    if (!previous?.pid || previous.instanceId === identity.instanceId || alive(previous.pid)) continue;
    const failedRoots = new Set(Object.entries(state.packages).filter(([, pkg]) => ["running", "cancelling"].includes(pkg.status)).map(([id]) => id));
    const blocked = descendants(state.plan, failedRoots);
    const finalized = await updateOrchestrationState(workspaceRoot, state.id, (current) => {
      for (const [id, pkg] of Object.entries(current.packages)) {
        if (failedRoots.has(id)) {
          pkg.status = "failed"; pkg.error = "PHASE1_CONTROLLER_LOST: the owning controller exited."; pkg.completedAt = new Date().toISOString();
        } else if (blocked.has(id)) {
          pkg.status = "blocked"; pkg.error = "Dependency was lost with the previous controller."; pkg.completedAt = new Date().toISOString();
        } else if (["planned", "ready", "queued"].includes(pkg.status)) {
          pkg.status = "cancelled"; pkg.error = "Phase 1 does not automatically resume orphaned packages."; pkg.completedAt = new Date().toISOString();
        }
      }
      const usable = Object.values(current.packages).some((pkg) => ["completed", "partial"].includes(pkg.status));
      current.status = usable ? "degraded" : "failed";
      current.completedAt = new Date().toISOString();
      current.controller = identity;
      return current;
    });
    writePackageResult(workspaceRoot, state.id, "_orchestration", buildOrchestrationResult(finalized));
    appendOrchestrationEvent(workspaceRoot, state.id, {
      type: "controller-loss-finalized",
      phase: finalized.status,
      message: "Previous controller was lost; Phase 1 finalized the orchestration without automatic resume."
    });
  }
}
