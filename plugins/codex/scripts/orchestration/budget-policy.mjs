
const ENVELOPES = [
  { min: 0, max: 2, maxTopLevelRoots: 1, workerParallelism: 1, maxNativeChildrenPerRoot: 0, timeoutMinutes: 15 },
  { min: 3, max: 4, maxTopLevelRoots: 2, workerParallelism: 2, maxNativeChildrenPerRoot: 1, timeoutMinutes: 15 },
  { min: 5, max: 7, maxTopLevelRoots: 4, workerParallelism: 3, maxNativeChildrenPerRoot: 2, timeoutMinutes: 30 },
  { min: 8, max: 10, maxTopLevelRoots: 6, workerParallelism: 3, maxNativeChildrenPerRoot: 3, timeoutMinutes: 60 }
];

export function deriveBudgetEnvelope(complexityScore, config) {
  if (!Number.isInteger(complexityScore) || complexityScore < 0 || complexityScore > 10) {
    throw new Error("complexityScore must be an integer between 0 and 10.");
  }
  const base = ENVELOPES.find((entry) => complexityScore >= entry.min && complexityScore <= entry.max);
  return {
    maxTopLevelRoots: Math.min(base.maxTopLevelRoots, config.workers.globalTopLevelLimit),
    workerParallelism: Math.min(base.workerParallelism, config.workers.workspacePoolSize),
    maxNativeChildrenPerRoot: base.maxNativeChildrenPerRoot,
    timeoutMinutes: base.timeoutMinutes,
    maxRetries: 1,
    maxReplans: 0,
    maxAdditionalPackages: 0,
    maxConcurrentSolUltra: 2
  };
}

export function validatePlanAgainstBudget(plan, envelope) {
  if (plan.packages.length > envelope.maxTopLevelRoots) {
    throw new Error(`Plan contains ${plan.packages.length} packages but the budget permits ${envelope.maxTopLevelRoots}.`);
  }
  for (const pkg of plan.packages) {
    if (pkg.nativeSubagents.maxChildren > envelope.maxNativeChildrenPerRoot) {
      throw new Error(`${pkg.id}.nativeSubagents.maxChildren exceeds the budget limit ${envelope.maxNativeChildrenPerRoot}.`);
    }
  }
}
