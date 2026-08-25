import {
  createSchedulerState,
  deriveOrchestrationStatus,
  getReadyPackageIds,
  markPackageCancelled,
  markPackageCompleted,
  markPackageFailed,
  markPackageReady,
  markPackageRunning,
  propagateBlockedPackages
} from "./scheduler.mjs";
import { normalizeOrchestrationPlan } from "./plan-contract.mjs";
import { buildOrchestrationResult } from "./result-contract.mjs";
import {
  appendOrchestrationEvent,
  createOrchestrationState,
  isTerminalState,
  listOrchestrations,
  loadOrchestrationState,
  resolveOrchestrationReference,
  updateOrchestrationState,
  writePackageResult
} from "./state-store.mjs";
import { isTransientWorkerError } from "./worker-pool.mjs";

function now() {
  return new Date().toISOString();
}

function schedulerFromState(state) {
  const scheduler = createSchedulerState(state.plan);
  for (const [id, pkg] of Object.entries(state.packages)) {
    scheduler.packages[id] = {
      ...scheduler.packages[id],
      status: pkg.status,
      attempt: pkg.attempt,
      error: pkg.error
    };
  }
  return scheduler;
}

function applyScheduler(state, scheduler) {
  for (const [id, pkg] of Object.entries(scheduler.packages)) {
    state.packages[id] = {
      ...state.packages[id],
      status: pkg.status,
      attempt: pkg.attempt,
      error: pkg.error
    };
  }
  return state;
}

export class OrchestrationController {
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.pool = options.pool;
    this.controllerIdentity = options.controllerIdentity ?? null;
    this.activeRuns = new Map();
    this.runningPackages = new Map();
    this.onMilestone = options.onMilestone ?? (() => {});
  }

  async start(planInput, context = {}) {
    const plan = normalizeOrchestrationPlan(planInput, {
      workspaceRoot: this.workspaceRoot,
      config: this.config
    });
    const state = await createOrchestrationState(this.workspaceRoot, plan, {
      ...context,
      controller: this.controllerIdentity
    });
    const promise = this.runOrchestration(state.id)
      .catch((error) => this.failControllerRun(state.id, error))
      .finally(() => this.activeRuns.delete(state.id));
    this.activeRuns.set(state.id, promise);
    return {
      orchestrationId: state.id,
      status: "queued",
      objective: plan.objective,
      packageCount: plan.packages.length
    };
  }

  async mutate(id, callback) {
    return updateOrchestrationState(this.workspaceRoot, id, callback);
  }

  async runOrchestration(id) {
    await this.mutate(id, (state) => {
      state.status = "running";
      state.startedAt = state.startedAt ?? now();
      return state;
    });

    const budgetState = loadOrchestrationState(this.workspaceRoot, id);
    const deadline = Date.now() + budgetState.plan.budget.timeoutMinutes * 60_000;

    while (true) {
      let state = loadOrchestrationState(this.workspaceRoot, id);
      if (Date.now() >= deadline) {
        await this.cancel(id, { reason: "Orchestration time budget exceeded." });
        return;
      }
      if (isTerminalState(state) || state.status === "cancelling") break;

      let scheduler = propagateBlockedPackages(schedulerFromState(state));
      for (const packageId of getReadyPackageIds(scheduler)) {
        scheduler = markPackageReady(scheduler, packageId);
      }
      state = await this.mutate(id, (current) => applyScheduler(current, scheduler));

      const activeKeys = [...this.runningPackages.keys()].filter((key) => key.startsWith(`${id}:`));
      const capacity = Math.max(0, state.plan.budget.workerParallelism - activeKeys.length);
      const ready = Object.entries(state.packages)
        .filter(
          ([packageId, pkg]) =>
            pkg.status === "ready" && !this.runningPackages.has(`${id}:${packageId}`)
        )
        .slice(0, capacity)
        .map(([packageId]) => packageId);

      for (const packageId of ready) this.launchPackage(id, packageId);

      state = loadOrchestrationState(this.workspaceRoot, id);
      if (
        Object.values(state.packages).every((pkg) =>
          ["completed", "partial", "blocked", "failed", "cancelled"].includes(pkg.status)
        )
      ) {
        await this.finalize(id);
        break;
      }

      const running = [...this.runningPackages.entries()]
        .filter(([key]) => key.startsWith(`${id}:`))
        .map(([, promise]) => promise);
      if (running.length === 0) {
        await this.finalize(id);
        break;
      }

      await Promise.race([
        Promise.race(running),
        new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, Math.max(10, deadline - Date.now())))
        )
      ]);
    }
  }

  launchPackage(id, packageId) {
    const key = `${id}:${packageId}`;
    if (this.runningPackages.has(key)) return;
    const promise = this.executePackage(id, packageId)
      .finally(() => this.runningPackages.delete(key));
    this.runningPackages.set(key, promise);
  }

  async executePackage(id, packageId) {
    const state = loadOrchestrationState(this.workspaceRoot, id);
    const spec = state.plan.packages.find((pkg) => pkg.id === packageId);
    const attempt = (state.packages[packageId].attempt ?? 0) + 1;

    await this.mutate(id, (current) => {
      current.packages[packageId].attempt = attempt;
      return current;
    });

    const dependencyResults = spec.dependencies
      .map((dependencyId) => ({
        packageId: dependencyId,
        result: loadOrchestrationState(this.workspaceRoot, id).packages[dependencyId].result
      }))
      .filter((entry) => entry.result);

    try {
      const execution = await this.pool.execute(id, spec, dependencyResults, {
        timeoutMinutes: state.plan.budget.timeoutMinutes,
        onStarted: async ({ workerId, pid }) => {
          await this.mutate(id, (current) => {
            if (
              current.status === "cancelling"
              || current.packages[packageId].status === "cancelled"
              || current.packages[packageId].status === "cancelling"
            ) {
              throw Object.assign(
                new Error(`Package ${packageId} was cancelled before worker activation.`),
                { code: "PACKAGE_CANCELLED" }
              );
            }

            let scheduler = schedulerFromState(current);
            scheduler = markPackageRunning(scheduler, packageId, attempt);
            applyScheduler(current, scheduler);
            Object.assign(current.packages[packageId], {
              workerId,
              pid,
              startedAt: current.packages[packageId].startedAt ?? now()
            });
            return current;
          });

          appendOrchestrationEvent(this.workspaceRoot, id, {
            packageId,
            type: "package-started",
            phase: "running",
            message: spec.title,
            data: { attempt }
          });
        }
      });

      const result = execution.packageResult;
      writePackageResult(this.workspaceRoot, id, packageId, result);
      await this.mutate(id, (current) => {
        let scheduler = schedulerFromState(current);
        scheduler = markPackageCompleted(scheduler, packageId, result.status);
        applyScheduler(current, scheduler);
        Object.assign(current.packages[packageId], {
          result,
          workerId: execution.workerId,
          pid: null,
          threadId: execution.threadId ?? null,
          turnId: execution.turnId ?? null,
          nativeChildThreadIds: execution.nativeChildThreadIds ?? [],
          completedAt: now(),
          nativeSubagentDegraded:
            spec.nativeSubagents.policy === "required" && (execution.nativeChildPeak ?? 0) === 0,
          nativeSubagentDegradationReason:
            spec.nativeSubagents.policy === "required" && (execution.nativeChildPeak ?? 0) === 0
              ? "No native child was observed; accepted Root-only execution."
              : null
        });
        return current;
      });
      appendOrchestrationEvent(this.workspaceRoot, id, {
        packageId,
        type: "package-completed",
        phase: result.status,
        message: result.summary
      });
    } catch (error) {
      const latest = loadOrchestrationState(this.workspaceRoot, id);
      if (
        latest.status === "cancelling"
        || latest.packages[packageId].status === "cancelled"
        || latest.packages[packageId].status === "cancelling"
        || error?.code === "PACKAGE_CANCELLED"
      ) {
        return;
      }

      if (isTransientWorkerError(error) && attempt <= state.plan.budget.maxRetries) {
        await this.mutate(id, (current) => {
          current.packages[packageId].status = "ready";
          current.packages[packageId].error = error.message;
          current.packages[packageId].pid = null;
          return current;
        });
        appendOrchestrationEvent(this.workspaceRoot, id, {
          packageId,
          type: "package-retry",
          phase: "queued",
          message: error.message,
          data: { nextAttempt: attempt + 1 }
        });
        return;
      }

      await this.mutate(id, (current) => {
        let scheduler = schedulerFromState(current);
        scheduler = markPackageFailed(scheduler, packageId, error.message);
        scheduler = propagateBlockedPackages(scheduler);
        applyScheduler(current, scheduler);
        current.packages[packageId].pid = null;
        current.packages[packageId].completedAt = now();
        return current;
      });
      appendOrchestrationEvent(this.workspaceRoot, id, {
        packageId,
        type: "package-failed",
        phase: "failed",
        message: error.message,
        data: { code: error.code ?? null }
      });
    }
  }

  async finalize(id) {
    const state = await this.mutate(id, (current) => {
      const scheduler = propagateBlockedPackages(schedulerFromState(current));
      applyScheduler(current, scheduler);
      current.status = current.status === "cancelling"
        ? "cancelled"
        : deriveOrchestrationStatus(scheduler);
      current.completedAt = now();
      return current;
    });
    writePackageResult(this.workspaceRoot, id, "_orchestration", buildOrchestrationResult(state));
    appendOrchestrationEvent(this.workspaceRoot, id, {
      type: "orchestration-completed",
      phase: state.status,
      message: state.status
    });
    this.onMilestone({
      orchestrationId: id,
      type: "orchestration-completed",
      status: state.status
    });
  }

  async failControllerRun(id, error) {
    await this.mutate(id, (state) => {
      state.status = "failed";
      state.completedAt = now();
      state.error = error.message;
      return state;
    });
    appendOrchestrationEvent(this.workspaceRoot, id, {
      type: "controller-failed",
      phase: "failed",
      message: error.message
    });
  }

  status(reference = "") {
    if (!reference) {
      return {
        workspaceRoot: this.workspaceRoot,
        orchestrations: listOrchestrations(this.workspaceRoot),
        pool: this.pool.getSnapshot()
      };
    }
    const resolved = resolveOrchestrationReference(this.workspaceRoot, reference);
    const state = loadOrchestrationState(this.workspaceRoot, resolved.orchestrationId);
    return resolved.kind === "package"
      ? {
          orchestrationId: state.id,
          package: state.packages[resolved.packageId],
          packageSpec: state.plan.packages.find((pkg) => pkg.id === resolved.packageId)
        }
      : { ...state, pool: this.pool.getSnapshot() };
  }

  result(reference = "") {
    const resolved = resolveOrchestrationReference(this.workspaceRoot, reference);
    const state = loadOrchestrationState(this.workspaceRoot, resolved.orchestrationId);
    if (resolved.kind === "package") return state.packages[resolved.packageId].result;
    if (!isTerminalState(state)) {
      throw new Error(`Orchestration ${state.id} is still running. Use /codex:status ${state.id}.`);
    }
    return buildOrchestrationResult(state);
  }

  async cancel(reference, options = {}) {
    const resolved = resolveOrchestrationReference(this.workspaceRoot, reference);
    const state = loadOrchestrationState(this.workspaceRoot, resolved.orchestrationId);
    if (isTerminalState(state)) return state;

    if (resolved.kind === "package") {
      await this.mutate(state.id, (current) => {
        const pkg = current.packages[resolved.packageId];
        if (!["completed", "partial", "blocked", "failed", "cancelled"].includes(pkg.status)) {
          pkg.status = "cancelling";
        }
        return current;
      });
      await this.pool.cancel(resolved.packageId, { graceMs: options.graceMs });
      return this.mutate(state.id, (current) => {
        let scheduler = schedulerFromState(current);
        scheduler = markPackageCancelled(scheduler, resolved.packageId);
        scheduler = propagateBlockedPackages(scheduler);
        applyScheduler(current, scheduler);
        return current;
      });
    }

    await this.mutate(state.id, (current) => {
      current.status = "cancelling";
      for (const pkg of Object.values(current.packages)) {
        if (pkg.status === "running") pkg.status = "cancelling";
      }
      return current;
    });

    const activePackageIds = this.pool.getSnapshot().active.map((entry) => entry.packageId);
    for (const packageId of activePackageIds) {
      await this.pool.cancel(packageId, { graceMs: options.graceMs });
    }

    await this.mutate(state.id, (current) => {
      let scheduler = schedulerFromState(current);
      for (const packageId of Object.keys(current.packages)) {
        scheduler = markPackageCancelled(scheduler, packageId);
      }
      applyScheduler(current, scheduler);
      return current;
    });

    await this.finalize(state.id);
    return loadOrchestrationState(this.workspaceRoot, state.id);
  }

  async shutdown() {
    await this.pool.close();
  }
}
