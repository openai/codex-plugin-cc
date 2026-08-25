
export const ORCHESTRATION_STATE_VERSION = 1;
export const ORCHESTRATION_PLAN_VERSION = 1;
export const DEFAULT_WORKSPACE_POOL_SIZE = 3;
export const MIN_WORKSPACE_POOL_SIZE = 1;
export const MAX_WORKSPACE_POOL_SIZE = 8;
export const DEFAULT_GLOBAL_TOP_LEVEL_LIMIT = 8;
export const DEFAULT_GLOBAL_ACTIVE_CODEX_LIMIT = 12;
export const DEFAULT_IDLE_TTL_MINUTES = 10;
export const DEFAULT_AUTO_THRESHOLD = 5;
export const DEFAULT_CANCEL_GRACE_MS = 10_000;
export const VALID_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const ROLE_CLASSES = new Set([
  "planner", "architect", "explorer", "implementer", "tester", "reviewer", "verifier",
  "migration-specialist", "security-reviewer"
]);
export const PACKAGE_TERMINAL_STATUSES = new Set(["completed", "partial", "blocked", "failed", "cancelled"]);
export const ORCHESTRATION_TERMINAL_STATUSES = new Set([
  "completed", "completed-with-omissions", "degraded", "blocked", "failed", "cancelled"
]);
