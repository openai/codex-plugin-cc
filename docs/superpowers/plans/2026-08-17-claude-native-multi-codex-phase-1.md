# Claude-Native Multi-Codex Orchestration Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Phase 1 read-only Claude-native Multi-Codex orchestration layer: explicit and opt-in automatic entry, validated DAG plans, a bounded direct App Server worker pool, durable orchestration state, structured package results, and orchestration-aware status/result/cancel commands.

**Architecture:** Claude remains the semantic planner and emits a canonical orchestration plan. A workspace-scoped detached Node.js controller validates the plan, schedules read-only packages over independent long-lived direct Codex App Server workers, persists every state transition, and exposes a small JSONL IPC surface. Existing single-job rescue/review paths remain unchanged; orchestration integrates through narrow adapters in `codex-companion.mjs` and dedicated Claude Code command/skill files.

**Tech Stack:** Node.js 18.18+ ESM, built-in `node:test`, Codex App Server JSONL protocol, Claude Code plugin Markdown commands/skills, JSON Schema documents with dependency-free runtime validators, filesystem-backed JSON/JSONL state, Unix sockets on macOS/Linux, named pipes on Windows.

## Global Constraints

- Phase 1 is strictly read-only. Every package must declare `access: "read-only"`; reject writer packages before any worker starts.
- Phase 1 excludes writer worktrees, snapshot refs, integration branches, package commits, reviewers, and automatic Git integration.
- Claude Root owns decomposition, package semantics, model selection, effort selection, replanning decisions, and final interpretation. The controller executes only a validated structured plan.
- Preserve existing `/codex:rescue`, `/codex:review`, `/codex:adversarial-review`, `/codex:transfer`, review-gate, broker, job, and session behavior.
- Top-level Codex Roots use independent direct App Server processes; do not route orchestration work through the existing serialized shared broker.
- One worker owns at most one top-level Codex Root at a time. Native children remain owned by that Root and the same App Server process.
- Default workspace pool size is 3; valid configured range is 1–8.
- Default global top-level worker limit is 8; default global active-Codex limit, including observed native children, is 12.
- Complexity Score 3–4 allows at most 2 Roots and 15 minutes; 5–7 allows 4 Roots, parallelism 3, and 30 minutes; 8–10 allows 6 Roots, parallelism 3, and 60 minutes.
- Automatic package retry is limited to one transient execution retry. Phase 1 does not perform semantic DAG replanning.
- Treat `Sol > Terra > Luna` as the base capability order. Reasoning effort is a separate dimension.
- Supported plugin-facing efforts remain `none`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; actual model/effort compatibility comes from the current App Server model catalog.
- Package runs use `sandbox: "read-only"` and `approvalPolicy: "never"`.
- External writes, deployment, publication, remote mutation, and credential changes are outside Phase 1 and must never be authorized by orchestration prompts.
- Do not add runtime npm dependencies. Use Node built-ins and the existing generated App Server types.
- Persist state under `${CLAUDE_PLUGIN_DATA}/orchestrations/<workspace-key>/` when `CLAUDE_PLUGIN_DATA` is present, otherwise under an OS temporary fallback.
- State writes must be atomic. Event logs are append-only JSONL.
- Detailed events stay local; chat-facing output is milestone-oriented.
- Support macOS, Linux, and Windows paths, process termination, Unix sockets, and named pipes.
- Every task follows TDD and ends with a focused commit.

---

## File and Responsibility Map

### Existing files to modify

| File | Responsibility after Phase 1 |
|---|---|
| `plugins/codex/scripts/lib/state.mjs` | Reuse a shared workspace storage-key helper; retain legacy job/config behavior unchanged. |
| `plugins/codex/scripts/lib/broker-lock.mjs` | Delegate lock mechanics to a generic file-lock primitive without changing broker semantics. |
| `plugins/codex/scripts/lib/codex.mjs` | Expose turn execution on a caller-owned long-lived App Server client; report Root/native-child topology. |
| `plugins/codex/scripts/codex-companion.mjs` | Add orchestration-aware setup/status/result/cancel routing while preserving legacy jobs. |
| `plugins/codex/scripts/lib/render.mjs` | Render combined job/orchestration status plus orchestration and package results. |
| `plugins/codex/commands/setup.md` | Expose automatic orchestration enable/disable flags. |
| `plugins/codex/commands/status.md` | Accept orchestration/package references and combined status. |
| `plugins/codex/commands/result.md` | Accept orchestration/package references. |
| `plugins/codex/commands/cancel.md` | Accept orchestration/package references. |
| `tests/fake-codex-fixture.mjs` | Simulate concurrent App Servers, delayed turns, canonical package results, native children, and interrupts. |
| `tests/commands.test.mjs` | Verify command and skill surfaces. |
| `tests/runtime.test.mjs` | Protect existing single-job behavior and reusable App Server turn execution. |
| `tests/state.test.mjs` | Verify storage-key refactor does not move legacy state. |
| `tests/render.test.mjs` | Verify orchestration rendering. |
| `tsconfig.app-server.json` | Type-check orchestration App Server modules. |
| `README.md` | Document Phase 1 command, limits, read-only boundary, and configuration. |

### New runtime modules

| File | Single responsibility |
|---|---|
| `plugins/codex/scripts/lib/workspace-key.mjs` | Canonical workspace key and storage-root calculation. |
| `plugins/codex/scripts/lib/file-lock.mjs` | Cross-process exclusive lock with stale-owner recovery. |
| `plugins/codex/scripts/orchestration/constants.mjs` | Status enums, defaults, limits, and Phase 1 feature constants. |
| `plugins/codex/scripts/orchestration/config.mjs` | Load, merge, validate, and patch user/project orchestration configuration. |
| `plugins/codex/scripts/orchestration/plan-contract.mjs` | Normalize and validate canonical plans, package IDs, dependencies, cycles, and Phase 1 read-only constraints. |
| `plugins/codex/scripts/orchestration/result-contract.mjs` | Validate and normalize package and orchestration results. |
| `plugins/codex/scripts/orchestration/state-store.mjs` | Atomic orchestration/package state, result files, events, and reference resolution. |
| `plugins/codex/scripts/orchestration/budget-policy.mjs` | Derive and validate the adaptive budget envelope. |
| `plugins/codex/scripts/orchestration/scheduler.mjs` | Pure DAG state transitions and ready/blocked/final status calculation. |
| `plugins/codex/scripts/orchestration/package-prompt.mjs` | Build bounded read-only Codex prompts and structured-output contracts. |
| `plugins/codex/scripts/orchestration/event-router.mjs` | Normalize worker progress into package/orchestration milestones and native-child counts. |
| `plugins/codex/scripts/orchestration/worker-runtime.mjs` | Own one direct App Server client and one active Root execution. |
| `plugins/codex/scripts/orchestration/global-worker-registry.mjs` | Enforce cross-workspace top-level worker leases. |
| `plugins/codex/scripts/orchestration/worker-pool.mjs` | Lazy workspace worker creation, lease/release, idle TTL, cancellation, and shutdown. |
| `plugins/codex/scripts/orchestration/controller.mjs` | Execute validated plans, schedule packages, persist state, retry transient failures, finalize, and cancel. |
| `plugins/codex/scripts/orchestration/ipc.mjs` | Controller endpoint creation/parsing and JSONL request helpers. |
| `plugins/codex/scripts/orchestration/controller-lifecycle.mjs` | Probe, start, reuse, and stop the workspace controller process. |
| `plugins/codex/scripts/orchestration/controller-client.mjs` | Typed request methods for start/status/result/cancel. |
| `plugins/codex/scripts/orchestration/controller-server.mjs` | Detached workspace controller JSONL server. |
| `plugins/codex/scripts/orchestration/companion-adapter.mjs` | Bridge legacy companion handlers to orchestration storage/controller. |
| `plugins/codex/scripts/orchestration/cli.mjs` | Deterministic command-line surface used by `/codex:orchestrate` and tests. |

### New schemas, commands, and skills

| File | Responsibility |
|---|---|
| `plugins/codex/scripts/orchestration/schemas/config.schema.json` | Phase 1 configuration schema. |
| `plugins/codex/scripts/orchestration/schemas/orchestration-plan.schema.json` | Canonical plan documentation/schema. |
| `plugins/codex/scripts/orchestration/schemas/package-result.schema.json` | Canonical package result schema passed to `turn/start`. |
| `plugins/codex/scripts/orchestration/schemas/orchestration-result.schema.json` | Canonical aggregate result documentation/schema. |
| `plugins/codex/commands/orchestrate.md` | Explicit Claude-root orchestration command. |
| `plugins/codex/skills/codex-orchestration/SKILL.md` | Auto-entry, plan construction, execution, decision-point, and final-response policy. |
| `plugins/codex/skills/codex-work-package-contract/SKILL.md` | Internal package contract. |
| `plugins/codex/skills/codex-integration-policy/SKILL.md` | Phase 1 result interpretation; explicitly defers Git integration to Phase 2. |
| `plugins/codex/skills/codex-orchestration-recovery/SKILL.md` | Phase 1 restart behavior; explicitly defers automatic resume to Phase 3. |

### New tests

| File | Coverage |
|---|---|
| `tests/file-lock.test.mjs` | Lock serialization and stale-owner recovery. |
| `tests/orchestration-config.test.mjs` | Configuration precedence, validation, and patching. |
| `tests/orchestration-contracts.test.mjs` | Plan/result schemas, cycle detection, and read-only enforcement. |
| `tests/orchestration-state.test.mjs` | Atomic state, event logs, results, references, and listing. |
| `tests/orchestration-scheduler.test.mjs` | DAG readiness, failure propagation, cancellation, and final statuses. |
| `tests/orchestration-worker.test.mjs` | Long-lived direct workers, structured results, child topology, and interrupt. |
| `tests/orchestration-pool.test.mjs` | Pool bounds, reuse, global leases, child limits, and idle close. |
| `tests/orchestration-controller.test.mjs` | End-to-end controller scheduling with fake workers. |
| `tests/orchestration-ipc.test.mjs` | Detached server lifecycle and request routing. |
| `tests/orchestration-runtime.test.mjs` | Full fake-Codex command flow for start/status/result/cancel and real parallel overlap. |
| `tests/orchestration-skill.test.mjs` | Command/skill policy, Phase 1 exclusions, and auto-entry flag. |

---

### Task 1: Extract Reusable Workspace Storage Keys and Generic File Locks

**Files:**
- Create: `plugins/codex/scripts/lib/workspace-key.mjs`
- Create: `plugins/codex/scripts/lib/file-lock.mjs`
- Modify: `plugins/codex/scripts/lib/state.mjs`
- Modify: `plugins/codex/scripts/lib/broker-lock.mjs`
- Create: `tests/file-lock.test.mjs`
- Modify: `tests/state.test.mjs`
- Test: `tests/broker-lifecycle.test.mjs`

**Interfaces:**
- Produces: `buildWorkspaceStorageKey(cwd): { workspaceRoot, canonicalWorkspaceRoot, slug, hash, key }`
- Produces: `resolvePluginDataRoot(env?): string`
- Produces: `withFileLock(lockFile, options, action): Promise<T>`
- Preserves: `resolveStateDir(cwd)` output format and `withBrokerLock(cwd, options, action)` behavior.

- [ ] **Step 1: Add failing storage-key tests**

Add to `tests/state.test.mjs`:

```js
import { buildWorkspaceStorageKey } from "../plugins/codex/scripts/lib/workspace-key.mjs";

test("workspace storage keys are stable for the same canonical workspace", () => {
  const workspace = makeTempDir();
  const first = buildWorkspaceStorageKey(workspace);
  const second = buildWorkspaceStorageKey(path.join(workspace, "."));

  assert.equal(first.workspaceRoot, second.workspaceRoot);
  assert.equal(first.key, second.key);
  assert.match(first.key, /.+-[a-f0-9]{16}$/);
});
```

- [ ] **Step 2: Add failing lock serialization and stale-owner tests**

Create `tests/file-lock.test.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { withFileLock } from "../plugins/codex/scripts/lib/file-lock.mjs";

test("withFileLock serializes concurrent actions", async () => {
  const lockFile = path.join(makeTempDir(), "test.lock");
  const order = [];

  const first = withFileLock(lockFile, {}, async () => {
    order.push("first-enter");
    await new Promise((resolve) => setTimeout(resolve, 75));
    order.push("first-exit");
  });
  const second = withFileLock(lockFile, {}, async () => {
    order.push("second-enter");
    order.push("second-exit");
  });

  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter", "second-exit"]);
});

test("withFileLock removes an abandoned lock owned by a dead process", async () => {
  const lockFile = path.join(makeTempDir(), "test.lock");
  fs.writeFileSync(lockFile, `999999:${Date.now() - 60000}:abandoned`, "utf8");

  const value = await withFileLock(lockFile, { staleMs: 1 }, async () => "recovered");

  assert.equal(value, "recovered");
  assert.equal(fs.existsSync(lockFile), false);
});
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```bash
node --test tests/state.test.mjs tests/file-lock.test.mjs
```

Expected: FAIL because `workspace-key.mjs` and `file-lock.mjs` do not exist.

- [ ] **Step 4: Implement `workspace-key.mjs`**

Create:

```js
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

export function resolvePluginDataRoot(env = process.env) {
  return env?.[PLUGIN_DATA_ENV] ? path.resolve(env[PLUGIN_DATA_ENV]) : path.join(os.tmpdir(), "codex-companion");
}

export function buildWorkspaceStorageKey(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = path.resolve(workspaceRoot);
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return {
    workspaceRoot,
    canonicalWorkspaceRoot,
    slug,
    hash,
    key: `${slug}-${hash}`
  };
}
```

- [ ] **Step 5: Implement generic `withFileLock`**

Create `plugins/codex/scripts/lib/file-lock.mjs` with these exported semantics:

```js
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function removeAbandonedLock(lockFile, staleMs) {
  try {
    const stat = fs.statSync(lockFile);
    const token = fs.readFileSync(lockFile, "utf8");
    const ownerPid = Number.parseInt(token.split(":", 1)[0], 10);
    if (Number.isFinite(ownerPid) && isProcessAlive(ownerPid)) {
      return false;
    }
    if (!Number.isFinite(ownerPid) && Date.now() - stat.mtimeMs <= staleMs) {
      return false;
    }
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

export async function withFileLock(lockFile, options = {}, action) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30000;
  const retryMs = options.retryMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, token, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (removeAbandonedLock(lockFile, staleMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock at ${lockFile}.`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await action();
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      try {
        if (fs.readFileSync(lockFile, "utf8") === token) {
          fs.unlinkSync(lockFile);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}
```

- [ ] **Step 6: Refactor legacy state and broker lock to use the new primitives**

In `state.mjs`, replace duplicated canonicalization/hash code with:

```js
import { buildWorkspaceStorageKey, resolvePluginDataRoot } from "./workspace-key.mjs";

export function resolveStateDir(cwd) {
  const { key } = buildWorkspaceStorageKey(cwd);
  return path.join(resolvePluginDataRoot(), "state", key);
}
```

In `broker-lock.mjs`, keep `brokerLockPath()` but replace its internal lock implementation with:

```js
import { withFileLock } from "./file-lock.mjs";

export async function withBrokerLock(cwd, options, action) {
  return withFileLock(
    brokerLockPath(cwd),
    {
      timeoutMs: options?.lockTimeoutMs,
      staleMs: options?.lockStaleMs
    },
    action
  );
}
```

- [ ] **Step 7: Run regression tests**

Run:

```bash
node --test tests/file-lock.test.mjs tests/state.test.mjs tests/broker-lifecycle.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/lib/workspace-key.mjs plugins/codex/scripts/lib/file-lock.mjs plugins/codex/scripts/lib/state.mjs plugins/codex/scripts/lib/broker-lock.mjs tests/file-lock.test.mjs tests/state.test.mjs
git commit -m "refactor: share workspace keys and file locks"
```

---

### Task 2: Add Phase 1 Orchestration Configuration and Setup Flags

**Files:**
- Create: `plugins/codex/scripts/orchestration/constants.mjs`
- Create: `plugins/codex/scripts/orchestration/config.mjs`
- Create: `plugins/codex/scripts/orchestration/schemas/config.schema.json`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/lib/render.mjs`
- Modify: `plugins/codex/commands/setup.md`
- Create: `tests/orchestration-config.test.mjs`
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/commands.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_ORCHESTRATION_CONFIG`
- Produces: `loadOrchestrationConfig(workspaceRoot, options?): OrchestrationConfig`
- Produces: `patchUserOrchestrationConfig(patch, options?): OrchestrationConfig`
- Produces: `getUserConfigPath(options?): string`
- Extends setup JSON with `orchestration: { autoEnabled, userConfigPath, projectConfigPath, effectiveConfig }`.

- [ ] **Step 1: Write failing precedence and validation tests**

Create `tests/orchestration-config.test.mjs` with tests that:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  getUserConfigPath,
  loadOrchestrationConfig,
  patchUserOrchestrationConfig
} from "../plugins/codex/scripts/orchestration/config.mjs";

test("project config overrides user config without dropping sibling defaults", () => {
  const homeDir = makeTempDir();
  const workspace = makeTempDir();
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
  fs.writeFileSync(
    getUserConfigPath({ homeDir }),
    JSON.stringify({ auto: { enabled: true }, workers: { workspacePoolSize: 2 } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspace, ".claude", "codex-orchestration.json"),
    JSON.stringify({ workers: { workspacePoolSize: 4 } }),
    "utf8"
  );

  const config = loadOrchestrationConfig(workspace, { homeDir });
  assert.equal(config.auto.enabled, true);
  assert.equal(config.workers.workspacePoolSize, 4);
  assert.equal(config.workers.globalTopLevelLimit, DEFAULT_ORCHESTRATION_CONFIG.workers.globalTopLevelLimit);
});

test("invalid worker limits are rejected with a path-specific error", () => {
  const homeDir = makeTempDir();
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(getUserConfigPath({ homeDir }), JSON.stringify({ workers: { workspacePoolSize: 9 } }), "utf8");

  assert.throws(
    () => loadOrchestrationConfig(makeTempDir(), { homeDir }),
    /workers\.workspacePoolSize must be between 1 and 8/
  );
});

test("patchUserOrchestrationConfig preserves unrelated keys", () => {
  const homeDir = makeTempDir();
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(getUserConfigPath({ homeDir }), JSON.stringify({ workers: { workspacePoolSize: 2 } }), "utf8");

  const result = patchUserOrchestrationConfig({ auto: { enabled: true } }, { homeDir });
  assert.equal(result.auto.enabled, true);
  assert.equal(result.workers.workspacePoolSize, 2);
});
```

- [ ] **Step 2: Run the new tests and confirm failure**

```bash
node --test tests/orchestration-config.test.mjs
```

Expected: FAIL because the orchestration config modules do not exist.

- [ ] **Step 3: Define Phase 1 constants**

Create `constants.mjs`:

```js
export const ORCHESTRATION_STATE_VERSION = 1;
export const ORCHESTRATION_PLAN_VERSION = 1;
export const DEFAULT_WORKSPACE_POOL_SIZE = 3;
export const MIN_WORKSPACE_POOL_SIZE = 1;
export const MAX_WORKSPACE_POOL_SIZE = 8;
export const DEFAULT_GLOBAL_TOP_LEVEL_LIMIT = 8;
export const DEFAULT_GLOBAL_ACTIVE_CODEX_LIMIT = 12;
export const DEFAULT_IDLE_TTL_MINUTES = 10;
export const DEFAULT_AUTO_THRESHOLD = 5;
export const DEFAULT_CANCEL_GRACE_MS = 10000;
export const DEFAULT_CONTROLLER_IDLE_TTL_MS = 10 * 60 * 1000;
export const VALID_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const PHASE1_PACKAGE_ACCESS = "read-only";
export const PACKAGE_TERMINAL_STATUSES = new Set(["completed", "partial", "blocked", "failed", "cancelled"]);
export const ORCHESTRATION_TERMINAL_STATUSES = new Set([
  "completed",
  "completed-with-omissions",
  "degraded",
  "blocked",
  "failed",
  "cancelled"
]);
```

- [ ] **Step 4: Add the configuration schema**

Create `schemas/config.schema.json` documenting exactly:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "auto": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "enabled": { "type": "boolean" },
        "threshold": { "type": "integer", "minimum": 0, "maximum": 10 }
      }
    },
    "workers": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "workspacePoolSize": { "type": "integer", "minimum": 1, "maximum": 8 },
        "globalTopLevelLimit": { "type": "integer", "minimum": 1, "maximum": 8 },
        "globalActiveCodexLimit": { "type": "integer", "minimum": 1, "maximum": 12 },
        "idleTtlMinutes": { "type": "integer", "minimum": 0, "maximum": 60 }
      }
    }
  }
}
```

- [ ] **Step 5: Implement configuration loading and patching**

`config.mjs` must export:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AUTO_THRESHOLD,
  DEFAULT_GLOBAL_ACTIVE_CODEX_LIMIT,
  DEFAULT_GLOBAL_TOP_LEVEL_LIMIT,
  DEFAULT_IDLE_TTL_MINUTES,
  DEFAULT_WORKSPACE_POOL_SIZE
} from "./constants.mjs";

export const DEFAULT_ORCHESTRATION_CONFIG = Object.freeze({
  auto: { enabled: false, threshold: DEFAULT_AUTO_THRESHOLD },
  workers: {
    workspacePoolSize: DEFAULT_WORKSPACE_POOL_SIZE,
    globalTopLevelLimit: DEFAULT_GLOBAL_TOP_LEVEL_LIMIT,
    globalActiveCodexLimit: DEFAULT_GLOBAL_ACTIVE_CODEX_LIMIT,
    idleTtlMinutes: DEFAULT_IDLE_TTL_MINUTES
  }
});

export function getUserConfigPath(options = {}) {
  return path.join(options.homeDir ?? os.homedir(), ".claude", "codex-orchestration.json");
}

export function getProjectConfigPath(workspaceRoot) {
  return path.join(workspaceRoot, ".claude", "codex-orchestration.json");
}
```

Implement a recursive object-only merge, reject arrays/unknown top-level keys, validate all numeric bounds, and write user patches through a temporary file followed by `fs.renameSync`.

- [ ] **Step 6: Extend setup handling**

In `codex-companion.mjs`:

- add `--enable-orchestration` and `--disable-orchestration` boolean options;
- reject enabling and disabling together;
- call `patchUserOrchestrationConfig({ auto: { enabled: true|false } })`;
- include the effective configuration in `buildSetupReport`;
- add next-step text only when auto orchestration is disabled.

The report shape must include:

```js
orchestration: {
  autoEnabled: orchestrationConfig.auto.enabled,
  userConfigPath: getUserConfigPath(),
  projectConfigPath: getProjectConfigPath(workspaceRoot),
  effectiveConfig: orchestrationConfig
}
```

- [ ] **Step 7: Extend setup rendering and command documentation**

Add to `renderSetupReport`:

```js
`- orchestration auto-entry: ${report.orchestration.autoEnabled ? "enabled" : "disabled"}`,
`- orchestration user config: ${report.orchestration.userConfigPath}`,
`- orchestration project config: ${report.orchestration.projectConfigPath}`,
```

Update `setup.md` argument hint to:

```yaml
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-orchestration|--disable-orchestration]'
```

- [ ] **Step 8: Run focused tests**

```bash
node --test tests/orchestration-config.test.mjs tests/runtime.test.mjs tests/commands.test.mjs tests/render.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/codex/scripts/orchestration/constants.mjs plugins/codex/scripts/orchestration/config.mjs plugins/codex/scripts/orchestration/schemas/config.schema.json plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/render.mjs plugins/codex/commands/setup.md tests/orchestration-config.test.mjs tests/runtime.test.mjs tests/commands.test.mjs tests/render.test.mjs
git commit -m "feat: add orchestration configuration"
```

---

### Task 3: Define Canonical Plan and Result Contracts

**Files:**
- Create: `plugins/codex/scripts/orchestration/schemas/orchestration-plan.schema.json`
- Create: `plugins/codex/scripts/orchestration/schemas/package-result.schema.json`
- Create: `plugins/codex/scripts/orchestration/schemas/orchestration-result.schema.json`
- Create: `plugins/codex/scripts/orchestration/plan-contract.mjs`
- Create: `plugins/codex/scripts/orchestration/result-contract.mjs`
- Create: `tests/orchestration-contracts.test.mjs`

**Interfaces:**
- Produces: `normalizeOrchestrationPlan(input, context): NormalizedPlan`
- Produces: `validatePackageResult(input, packageId): NormalizedPackageResult`
- Produces: `buildOrchestrationResult(orchestrationState): OrchestrationResult`
- Produces: `readPackageResultSchema(): object`

- [ ] **Step 1: Add a canonical valid plan fixture and failing contract tests**

Create `tests/orchestration-contracts.test.mjs` with this fixture:

```js
const VALID_PLAN = {
  version: 1,
  objective: "Compare two independent failure hypotheses and verify the stronger explanation.",
  complexityScore: 6,
  requestedBy: { explicit: true, sessionId: "claude-session-1" },
  packages: [
    {
      id: "pkg-cache",
      title: "Inspect cache invalidation",
      role: { class: "explorer", label: "cache-investigator" },
      objective: "Determine whether stale cache state explains the regression.",
      dependencies: [],
      access: "read-only",
      workspace: { mode: "shared" },
      model: { name: "gpt-5.6-luna", effort: "high" },
      nativeSubagents: { policy: "allowed", maxChildren: 1 },
      acceptanceCriteria: ["Cite relevant files and commands", "Return a falsifiable conclusion"],
      expectedOutputs: ["claims", "evidence", "residual risks"]
    },
    {
      id: "pkg-race",
      title: "Inspect race conditions",
      role: { class: "explorer", label: "race-investigator" },
      objective: "Determine whether a concurrency race explains the regression.",
      dependencies: [],
      access: "read-only",
      workspace: { mode: "shared" },
      model: { name: "gpt-5.6-terra", effort: "high" },
      nativeSubagents: { policy: "forbidden", maxChildren: 0 },
      acceptanceCriteria: ["Cite relevant files and commands", "Return a falsifiable conclusion"],
      expectedOutputs: ["claims", "evidence", "residual risks"]
    },
    {
      id: "pkg-synthesis-check",
      title: "Verify both hypotheses",
      role: { class: "verifier", label: "hypothesis-verifier" },
      objective: "Compare evidence from both investigations and identify unresolved contradictions.",
      dependencies: ["pkg-cache", "pkg-race"],
      access: "read-only",
      workspace: { mode: "shared" },
      model: { name: "gpt-5.6-sol", effort: "high" },
      nativeSubagents: { policy: "forbidden", maxChildren: 0 },
      acceptanceCriteria: ["Explicitly compare both package results"],
      expectedOutputs: ["claims", "evidence", "residual risks"]
    }
  ]
};
```

Test:

- valid normalization preserves package order;
- duplicate package IDs fail;
- unknown dependencies fail;
- a cycle fails with the cycle path;
- `access: "write"` fails with `Phase 1 only supports read-only packages`;
- invalid effort fails;
- package count above the score-derived cap fails;
- result `changedFiles` must be empty in Phase 1;
- confidence must be between 0 and 1.

- [ ] **Step 2: Run contract tests and confirm failure**

```bash
node --test tests/orchestration-contracts.test.mjs
```

Expected: FAIL because contract modules and schemas are missing.

- [ ] **Step 3: Write `orchestration-plan.schema.json`**

The schema must require:

```json
{
  "required": ["version", "objective", "complexityScore", "requestedBy", "packages"],
  "properties": {
    "version": { "const": 1 },
    "objective": { "type": "string", "minLength": 1 },
    "complexityScore": { "type": "integer", "minimum": 0, "maximum": 10 },
    "requestedBy": {
      "type": "object",
      "required": ["explicit"],
      "properties": {
        "explicit": { "type": "boolean" },
        "sessionId": { "type": ["string", "null"] }
      }
    },
    "packages": { "type": "array", "minItems": 1, "maxItems": 8 }
  }
}
```

Each package must require the exact fields in `VALID_PLAN`, constrain role class to:

```text
planner, architect, explorer, implementer, tester, reviewer, verifier, migration-specialist, security-reviewer
```

and constrain Phase 1 access/workspace to:

```json
"access": { "const": "read-only" },
"workspace": {
  "type": "object",
  "required": ["mode"],
  "properties": { "mode": { "const": "shared" } }
}
```

- [ ] **Step 4: Write `package-result.schema.json`**

Require this shape:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "packageId",
    "status",
    "summary",
    "claims",
    "evidence",
    "changedFiles",
    "verification",
    "residualRisks",
    "confidence",
    "followUpRequests"
  ],
  "properties": {
    "packageId": { "type": "string" },
    "status": { "enum": ["completed", "partial", "blocked", "failed"] },
    "summary": { "type": "string" },
    "claims": { "type": "array", "items": { "type": "string" } },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type", "description"],
        "properties": {
          "type": { "enum": ["file", "command", "observation"] },
          "description": { "type": "string" },
          "path": { "type": ["string", "null"] },
          "lineStart": { "type": ["integer", "null"], "minimum": 1 },
          "lineEnd": { "type": ["integer", "null"], "minimum": 1 },
          "command": { "type": ["string", "null"] },
          "exitCode": { "type": ["integer", "null"] }
        }
      }
    },
    "changedFiles": { "type": "array", "maxItems": 0 },
    "verification": {
      "type": "object",
      "required": ["passed", "commands"],
      "properties": {
        "passed": { "type": "boolean" },
        "commands": { "type": "array", "items": { "type": "string" } }
      }
    },
    "residualRisks": { "type": "array", "items": { "type": "string" } },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "followUpRequests": { "type": "array", "items": { "type": "string" } }
  }
}
```

- [ ] **Step 5: Implement plan normalization and graph validation**

`plan-contract.mjs` must:

1. verify object/array/string primitives without a schema library;
2. trim all IDs, labels, objectives, criteria, and model strings;
3. reject unknown package IDs and duplicate IDs;
4. reject package dependencies on themselves;
5. run DFS cycle detection and include `pkg-a -> pkg-b -> pkg-a` in the error;
6. reject `write` access and non-`shared` workspace modes;
7. validate score-derived package/parallelism limits through Task 5's `deriveBudgetEnvelope` once available; until Task 5, define a local private equivalent and replace it during Task 5;
8. return a deeply frozen normalized plan.

Export:

```js
export function normalizeOrchestrationPlan(input, context = {}) {
  // context.workspaceRoot and context.config are required by the controller.
}
```

- [ ] **Step 6: Implement result normalization**

`result-contract.mjs` must export:

```js
export function validatePackageResult(input, packageId) {
  // Return a normalized object or throw a path-specific validation error.
}

export function buildOrchestrationResult(state) {
  return {
    orchestrationId: state.id,
    status: state.status,
    objective: state.plan.objective,
    planRevision: state.planRevision,
    packages: state.plan.packages.map((pkg) => ({
      id: pkg.id,
      title: pkg.title,
      role: pkg.role,
      status: state.packages[pkg.id].status,
      result: state.packages[pkg.id].result ?? null,
      threadId: state.packages[pkg.id].threadId ?? null,
      nativeChildThreadIds: state.packages[pkg.id].nativeChildThreadIds ?? []
    })),
    omissions: state.omissions ?? [],
    remainingWork: state.remainingWork ?? []
  };
}
```

Load `package-result.schema.json` once through `fs.readFileSync(new URL(...))` and export `readPackageResultSchema()`.

- [ ] **Step 7: Run contract tests**

```bash
node --test tests/orchestration-contracts.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/schemas plugins/codex/scripts/orchestration/plan-contract.mjs plugins/codex/scripts/orchestration/result-contract.mjs tests/orchestration-contracts.test.mjs
git commit -m "feat: define orchestration contracts"
```

---

### Task 4: Build the Durable Orchestration State Store

**Files:**
- Create: `plugins/codex/scripts/orchestration/state-store.mjs`
- Create: `tests/orchestration-state.test.mjs`

**Interfaces:**
- Produces: `resolveOrchestrationWorkspaceDir(workspaceRoot)`
- Produces: `createOrchestrationState(workspaceRoot, plan, context): State`
- Produces: `loadOrchestrationState(workspaceRoot, id): State`
- Produces: `updateOrchestrationState(workspaceRoot, id, mutate): State`
- Produces: `listOrchestrations(workspaceRoot): StateSummary[]`
- Produces: `resolveOrchestrationReference(workspaceRoot, reference): { kind, orchestrationId, packageId? }`
- Produces: `writePackageResult`, `readPackageResult`, `appendOrchestrationEvent`.

- [ ] **Step 1: Add failing persistence and reference tests**

Create tests covering:

```js
test("createOrchestrationState writes canonical state and package files", () => {});
test("updateOrchestrationState is atomic under concurrent writers", async () => {});
test("appendOrchestrationEvent writes one JSON object per line", () => {});
test("resolveOrchestrationReference accepts exact and unique prefixes", () => {});
test("package references resolve as pkg-id within their orchestration", () => {});
test("ambiguous orchestration prefixes are rejected", () => {});
```

The first state must contain:

```js
{
  version: 1,
  id: /^orch-/,
  workspaceRoot,
  claudeSessionId: "session-1",
  status: "queued",
  planRevision: 1,
  plan,
  packages: {
    "pkg-cache": {
      id: "pkg-cache",
      status: "planned",
      attempt: 0,
      workerId: null,
      threadId: null,
      turnId: null,
      nativeChildThreadIds: [],
      result: null,
      error: null
    }
  }
}
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
node --test tests/orchestration-state.test.mjs
```

- [ ] **Step 3: Implement storage paths**

Use:

```js
const FALLBACK_ORCHESTRATION_ROOT = path.join(os.tmpdir(), "codex-companion", "orchestrations");

export function resolveOrchestrationWorkspaceDir(workspaceRoot) {
  const { key } = buildWorkspaceStorageKey(workspaceRoot);
  const root = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(path.resolve(process.env.CLAUDE_PLUGIN_DATA), "orchestrations")
    : FALLBACK_ORCHESTRATION_ROOT;
  return path.join(root, key);
}
```

Per orchestration:

```text
<workspace-dir>/<orch-id>/orchestration.json
<workspace-dir>/<orch-id>/events.jsonl
<workspace-dir>/<orch-id>/packages/<pkg-id>.json
<workspace-dir>/<orch-id>/results/<pkg-id>.json
<workspace-dir>/<orch-id>/controller.json
```

- [ ] **Step 4: Implement atomic JSON writes**

Use a unique same-directory temp path and `renameSync`:

```js
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}
```

Wrap read-modify-write updates with `withFileLock(path.join(orchestrationDir, "state.lock"), {}, action)`.

- [ ] **Step 5: Implement creation, updates, package results, and events**

IDs use:

```js
export function generateOrchestrationId(now = Date.now()) {
  return `orch-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}
```

`appendOrchestrationEvent` writes:

```js
{
  timestamp: new Date().toISOString(),
  orchestrationId,
  packageId: event.packageId ?? null,
  type: event.type,
  phase: event.phase ?? null,
  message: event.message,
  data: event.data ?? null
}
```

- [ ] **Step 6: Implement reference resolution**

Rules:

- exact orchestration ID wins;
- a unique orchestration prefix is allowed;
- exact package ID searches all known orchestrations in the workspace and must match one;
- a package prefix must be unique across the workspace;
- errors must direct the user to `/codex:status`.

- [ ] **Step 7: Run state tests**

```bash
node --test tests/orchestration-state.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/state-store.mjs tests/orchestration-state.test.mjs
git commit -m "feat: persist orchestration state"
```

---

### Task 5: Implement Adaptive Budgets and the Pure DAG Scheduler

**Files:**
- Create: `plugins/codex/scripts/orchestration/budget-policy.mjs`
- Create: `plugins/codex/scripts/orchestration/scheduler.mjs`
- Modify: `plugins/codex/scripts/orchestration/plan-contract.mjs`
- Create: `tests/orchestration-scheduler.test.mjs`
- Modify: `tests/orchestration-contracts.test.mjs`

**Interfaces:**
- Produces: `deriveBudgetEnvelope(complexityScore, config): BudgetEnvelope`
- Produces: `validatePlanAgainstBudget(plan, envelope): void`
- Produces: `createSchedulerState(plan): SchedulerState`
- Produces: `getReadyPackageIds(state): string[]`
- Produces state transition functions with immutable return values.

- [ ] **Step 1: Write failing budget tests**

Test exact envelopes:

```js
assert.deepEqual(deriveBudgetEnvelope(3, config), {
  maxTopLevelRoots: 2,
  workerParallelism: 2,
  maxNativeChildrenPerRoot: 1,
  timeoutMinutes: 15,
  maxRetries: 1,
  maxReplans: 0,
  maxAdditionalPackages: 0,
  maxConcurrentSolUltra: 2
});
```

Score 6 returns Roots 4, parallelism 3, children 2, 30 minutes. Score 9 returns Roots 6, parallelism 3, children 3, 60 minutes. Clamp parallelism by `config.workers.workspacePoolSize` and roots by `globalTopLevelLimit`.

- [ ] **Step 2: Write failing scheduler tests**

Cover:

```js
- packages with no dependencies become ready;
- dependent packages remain planned until every dependency is completed or partial;
- failed required dependencies mark downstream packages blocked;
- cancelling one package does not cancel independent branches;
- all completed packages finalize as completed;
- completed plus optional blocked packages finalize as completed-with-omissions;
- any failed required package finalizes as degraded when another package completed;
- all failed/blocked with no usable result finalizes as failed;
- no transition may move a terminal package back to running.
```

Add `optional: false` to normalized packages, defaulting to false when omitted. The plan schema may document `optional` as a boolean.

- [ ] **Step 3: Run tests and confirm failure**

```bash
node --test tests/orchestration-scheduler.test.mjs tests/orchestration-contracts.test.mjs
```

- [ ] **Step 4: Implement `budget-policy.mjs`**

Use a table, not nested ad hoc conditionals:

```js
const ENVELOPES = [
  { min: 0, max: 2, maxTopLevelRoots: 1, workerParallelism: 1, maxNativeChildrenPerRoot: 0, timeoutMinutes: 15 },
  { min: 3, max: 4, maxTopLevelRoots: 2, workerParallelism: 2, maxNativeChildrenPerRoot: 1, timeoutMinutes: 15 },
  { min: 5, max: 7, maxTopLevelRoots: 4, workerParallelism: 3, maxNativeChildrenPerRoot: 2, timeoutMinutes: 30 },
  { min: 8, max: 10, maxTopLevelRoots: 6, workerParallelism: 3, maxNativeChildrenPerRoot: 3, timeoutMinutes: 60 }
];
```

Return the fixed caps shown in Step 1 and clamp by configuration.

- [ ] **Step 5: Implement immutable scheduler state**

State shape:

```js
{
  packages: {
    [packageId]: {
      id: packageId,
      status: "planned",
      dependencies: [...],
      optional: false,
      attempt: 0
    }
  }
}
```

Export:

```js
export function markPackageReady(state, id) {}
export function markPackageRunning(state, id, attempt) {}
export function markPackageCompleted(state, id, resultStatus = "completed") {}
export function markPackageFailed(state, id, error) {}
export function markPackageCancelled(state, id) {}
export function propagateBlockedPackages(state) {}
export function deriveOrchestrationStatus(state) {}
```

Every transition validates the source status and returns a new state object.

- [ ] **Step 6: Replace temporary budget validation in `plan-contract.mjs`**

Import `deriveBudgetEnvelope` and `validatePlanAgainstBudget`. Store the resulting envelope in the normalized plan:

```js
return deepFreeze({
  ...normalized,
  budget: deriveBudgetEnvelope(normalized.complexityScore, context.config)
});
```

- [ ] **Step 7: Run focused tests**

```bash
node --test tests/orchestration-scheduler.test.mjs tests/orchestration-contracts.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/budget-policy.mjs plugins/codex/scripts/orchestration/scheduler.mjs plugins/codex/scripts/orchestration/plan-contract.mjs plugins/codex/scripts/orchestration/schemas/orchestration-plan.schema.json tests/orchestration-scheduler.test.mjs tests/orchestration-contracts.test.mjs
git commit -m "feat: add orchestration DAG scheduler"
```

---

### Task 6: Make Codex Turn Execution Reusable by Long-Lived Direct Workers

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs`
- Modify: `plugins/codex/scripts/lib/app-server-protocol.d.ts`
- Modify: `tests/runtime.test.mjs`
- Modify: `tsconfig.app-server.json`

**Interfaces:**
- Produces: `runAppServerTurnWithClient(client, cwd, options): Promise<TurnResult>`
- Extends `TurnResult` with `threadIds`, `nativeChildThreadIds`, and `nativeChildPeak`.
- Preserves: `runAppServerTurn(cwd, options)` behavior and output fields.

- [ ] **Step 1: Add a failing test for caller-owned clients**

In `tests/runtime.test.mjs`, add a test that:

1. installs fake Codex;
2. opens one `CodexAppServerClient.connect(cwd, { disableBroker: true })`;
3. calls `runAppServerTurnWithClient` twice sequentially;
4. asserts `appServerStarts === 1`;
5. closes the client explicitly.

Use:

```js
const client = await CodexAppServerClient.connect(repo, { disableBroker: true, env });
try {
  const first = await runAppServerTurnWithClient(client, repo, {
    prompt: "first",
    model: "gpt-5.6-luna",
    effort: "high",
    sandbox: "read-only"
  });
  const second = await runAppServerTurnWithClient(client, repo, {
    prompt: "second",
    model: "gpt-5.6-terra",
    effort: "high",
    sandbox: "read-only"
  });
  assert.notEqual(first.threadId, second.threadId);
} finally {
  await client.close();
}
```

- [ ] **Step 2: Add a failing native-child topology test**

Run fake behavior `with-subagent` and assert:

```js
assert.equal(result.threadIds.includes(result.threadId), true);
assert.equal(result.nativeChildThreadIds.length, 1);
assert.equal(result.nativeChildPeak, 1);
```

Also collect progress events and assert one event has:

```js
{
  eventType: "native-child-started",
  parentThreadId: result.threadId,
  threadId: result.nativeChildThreadIds[0]
}
```

- [ ] **Step 3: Run the focused runtime tests and confirm failure**

```bash
node --test tests/runtime.test.mjs --test-name-pattern "caller-owned|native-child topology"
```

- [ ] **Step 4: Extend capture state and progress metadata**

In `createTurnCaptureState`, add:

```js
nativeChildThreadIds: new Set(),
nativeChildPeak: 0,
```

On non-root `thread/started` and `turn/started`, register the child and emit:

```js
emitProgress(state.onProgress, `Native child started (${childId}).`, "investigating", {
  eventType: "native-child-started",
  threadId: childId,
  parentThreadId: state.threadId,
  agentNickname: message.params.thread.agentNickname ?? null,
  agentRole: message.params.thread.agentRole ?? null
});
```

On non-root `turn/completed`, emit `native-child-completed`. Update `nativeChildPeak` from `activeSubagentTurns.size`.

- [ ] **Step 5: Extract `runAppServerTurnWithClient`**

Move the body currently inside `withAppServer(cwd, async (client) => { ... })` into:

```js
export async function runAppServerTurnWithClient(client, cwd, options = {}) {
  // Existing thread start/resume, model validation, captureTurn, and result building.
}
```

Return:

```js
{
  status,
  threadId,
  turnId,
  threadIds: [...turnState.threadIds],
  nativeChildThreadIds: [...turnState.nativeChildThreadIds],
  nativeChildPeak: turnState.nativeChildPeak,
  finalMessage,
  reasoningSummary,
  turn,
  error,
  stderr,
  fileChanges,
  touchedFiles,
  commandExecutions
}
```

Then keep the existing public wrapper:

```js
export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(/* existing message */);
  }
  return withAppServer(cwd, (client) => runAppServerTurnWithClient(client, cwd, options));
}
```

- [ ] **Step 6: Update JSDoc/type-check scope**

Add `plugins/codex/scripts/orchestration/**/*.mjs` to the `include` array in `tsconfig.app-server.json`. Do not enable `experimentalApi` globally.

- [ ] **Step 7: Run runtime and build checks**

```bash
node --test tests/runtime.test.mjs
npm run build
```

Expected: PASS with all existing runtime tests unchanged.

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/lib/app-server-protocol.d.ts tests/runtime.test.mjs tsconfig.app-server.json
git commit -m "refactor: support caller-owned App Server turns"
```

---

### Task 7: Extend the Fake Codex Fixture for Parallel Orchestration

**Files:**
- Modify: `tests/fake-codex-fixture.mjs`
- Modify: `tests/helpers.mjs`
- Create: `tests/orchestration-worker.test.mjs`

**Interfaces:**
- Extends: `installFakeCodex(binDir, behavior, version, options?)`
- Produces: `readFakeCodexEvents(binDir): object[]`
- Adds behavior: `orchestration-read-only`, `orchestration-long-running`, `orchestration-transient-once`.

- [ ] **Step 1: Add failing fixture tests**

In `tests/orchestration-worker.test.mjs`, first test the fixture directly by spawning two direct App Servers and asserting the event log contains two `turn-started` events before either `turn-completed` event.

Use per-prompt markers:

```text
<orchestration_package_id>pkg-a</orchestration_package_id>
<orchestration_delay_ms>250</orchestration_delay_ms>
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/orchestration-worker.test.mjs --test-name-pattern "fixture records overlapping turns"
```

- [ ] **Step 3: Add append-only fake event logging**

Inside the generated fake `codex` script, define:

```js
const EVENTS_PATH = path.join(path.dirname(STATE_PATH), "fake-codex-events.jsonl");

function appendEvent(event) {
  fs.appendFileSync(
    EVENTS_PATH,
    JSON.stringify({ timestamp: Date.now(), pid: process.pid, ...event }) + "\n",
    "utf8"
  );
}
```

Record `app-server-started`, `thread-started`, `turn-started`, `turn-completed`, and `turn-interrupted`.

- [ ] **Step 4: Generate canonical package results**

When `turn/start.outputSchema` contains a `packageId` property, return:

```js
const packageIdMatch = prompt.match(/<orchestration_package_id>([^<]+)<\/orchestration_package_id>/);
const packageId = packageIdMatch ? packageIdMatch[1].trim() : "pkg-unknown";
const payload = JSON.stringify({
  packageId,
  status: "completed",
  summary: `Completed read-only analysis for ${packageId}.`,
  claims: [`Claim from ${packageId}`],
  evidence: [
    {
      type: "observation",
      description: `Observed repository state for ${packageId}.`,
      path: null,
      lineStart: null,
      lineEnd: null,
      command: null,
      exitCode: null
    }
  ],
  changedFiles: [],
  verification: { passed: true, commands: [] },
  residualRisks: [],
  confidence: 0.8,
  followUpRequests: []
});
```

- [ ] **Step 5: Add delayed, interruptible, and transient-once behavior**

- parse `<orchestration_delay_ms>` and delay completion;
- store active timers in `interruptibleTurns`;
- on `turn/interrupt`, clear the timer and emit a cancelled turn;
- for `orchestration-transient-once`, persist a per-package attempt counter and terminate the first App Server process during the first attempt only.

- [ ] **Step 6: Export event-reading helper**

Outside the generated script, export:

```js
export function readFakeCodexEvents(binDir) {
  const eventFile = path.join(binDir, "fake-codex-events.jsonl");
  if (!fs.existsSync(eventFile)) {
    return [];
  }
  return fs.readFileSync(eventFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
```

- [ ] **Step 7: Run fixture tests plus existing runtime tests**

```bash
node --test tests/orchestration-worker.test.mjs tests/runtime.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/fake-codex-fixture.mjs tests/helpers.mjs tests/orchestration-worker.test.mjs
git commit -m "test: simulate parallel Codex workers"
```

---

### Task 8: Implement Read-Only Package Prompts, Event Routing, and Worker Runtime

**Files:**
- Create: `plugins/codex/scripts/orchestration/package-prompt.mjs`
- Create: `plugins/codex/scripts/orchestration/event-router.mjs`
- Create: `plugins/codex/scripts/orchestration/worker-runtime.mjs`
- Modify: `tests/orchestration-worker.test.mjs`

**Interfaces:**
- Produces: `buildReadOnlyPackagePrompt(packageSpec, context): string`
- Produces: `createPackageEventRouter(options): (progressEvent) => void`
- Produces: `class OrchestrationWorker`
- `OrchestrationWorker.run(packageSpec, options): Promise<WorkerExecutionResult>`
- `OrchestrationWorker.interrupt(): Promise<{ attempted, interrupted }>`

- [ ] **Step 1: Add failing prompt boundary tests**

Assert the prompt includes:

```text
<orchestration_package_id>pkg-cache</orchestration_package_id>
<access_policy>Read-only. Do not modify files...</access_policy>
<objective>...</objective>
<dependencies>...</dependencies>
<acceptance_criteria>...</acceptance_criteria>
<native_subagent_policy>allowed; maximum 1 child...</native_subagent_policy>
<output_contract>Return one JSON object matching the supplied schema...</output_contract>
```

Assert it explicitly forbids push, deploy, publish, remote mutation, credential changes, and package creation outside the assigned objective.

- [ ] **Step 2: Add failing worker execution tests**

Tests must assert:

- the worker opens one direct App Server process and reuses it for sequential packages;
- each package receives the selected model and effort;
- output parses through `validatePackageResult`;
- `touchedFiles` is empty or execution fails with a Phase 1 boundary violation;
- native child IDs and peak are returned;
- exceeding `maxChildren` interrupts and fails the package;
- `interrupt()` sends `turn/interrupt` to the active thread/turn.

- [ ] **Step 3: Run and confirm failure**

```bash
node --test tests/orchestration-worker.test.mjs
```

- [ ] **Step 4: Implement the package prompt builder**

Use deterministic XML blocks. Do not include hidden Claude reasoning or unrelated conversation context. Include dependency result summaries only when the package depends on completed packages:

```js
export function buildReadOnlyPackagePrompt(packageSpec, context = {}) {
  const dependencySummaries = context.dependencyResults ?? [];
  return [
    `<orchestration_package_id>${escapeXml(packageSpec.id)}</orchestration_package_id>`,
    `<role>${escapeXml(packageSpec.role.class)}: ${escapeXml(packageSpec.role.label)}</role>`,
    `<objective>${escapeXml(packageSpec.objective)}</objective>`,
    `<access_policy>Read-only. Do not modify files, create commits, change credentials, push, publish, deploy, or mutate remote systems.</access_policy>`,
    `<dependencies>${escapeXml(JSON.stringify(dependencySummaries))}</dependencies>`,
    `<acceptance_criteria>${escapeXml(JSON.stringify(packageSpec.acceptanceCriteria))}</acceptance_criteria>`,
    `<native_subagent_policy>${escapeXml(`${packageSpec.nativeSubagents.policy}; maximum ${packageSpec.nativeSubagents.maxChildren} child agents`)}</native_subagent_policy>`,
    `<verification>Run only non-destructive checks needed to support the claims. Record exact commands and exit codes.</verification>`,
    `<output_contract>Return exactly one JSON object matching the supplied package-result schema. changedFiles must be an empty array.</output_contract>`
  ].join("\n\n");
}
```

- [ ] **Step 5: Implement event routing**

`createPackageEventRouter` receives `{ orchestrationId, packageId, maxChildren, onEvent, onLimitExceeded }` and normalizes string or object progress events into:

```js
{
  type: "package-progress" | "native-child-started" | "native-child-completed" | "package-log",
  phase,
  message,
  packageId,
  threadId,
  turnId,
  childThreadId,
  activeNativeChildren,
  nativeChildPeak
}
```

Call `onLimitExceeded` once when observed active children exceed `maxChildren`.

- [ ] **Step 6: Implement `OrchestrationWorker`**

Constructor:

```js
new OrchestrationWorker({
  id,
  workspaceRoot,
  env = process.env,
  onEvent = () => {},
  clientFactory = (cwd, options) => CodexAppServerClient.connect(cwd, options)
})
```

Methods:

```js
async start() {
  this.client = await this.clientFactory(this.workspaceRoot, { disableBroker: true, env: this.env });
}

async run(packageSpec, options = {}) {
  if (this.active) throw new Error(`Worker ${this.id} is already running a package.`);
  // Build prompt, capture thread/turn IDs from progress, enforce child limit,
  // call runAppServerTurnWithClient with read-only sandbox and output schema,
  // reject touched files, parse JSON, return normalized result.
}

async interrupt() {
  if (!this.active?.threadId || !this.active?.turnId) return { attempted: false, interrupted: false };
  await this.client.request("turn/interrupt", {
    threadId: this.active.threadId,
    turnId: this.active.turnId
  });
  return { attempted: true, interrupted: true };
}

async close() {
  await this.client?.close();
  this.client = null;
}
```

Use `parseStructuredOutput` followed by `validatePackageResult`. Preserve raw output and parse error in the failure object.

- [ ] **Step 7: Run worker tests and build**

```bash
node --test tests/orchestration-worker.test.mjs
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/package-prompt.mjs plugins/codex/scripts/orchestration/event-router.mjs plugins/codex/scripts/orchestration/worker-runtime.mjs tests/orchestration-worker.test.mjs
git commit -m "feat: execute read-only orchestration packages"
```

---

### Task 9: Implement Global Worker Leases and the Workspace Worker Pool

**Files:**
- Create: `plugins/codex/scripts/orchestration/global-worker-registry.mjs`
- Create: `plugins/codex/scripts/orchestration/worker-pool.mjs`
- Create: `tests/orchestration-pool.test.mjs`

**Interfaces:**
- Produces: `acquireGlobalWorkerLease(options): Promise<Lease>`
- Produces: `releaseGlobalWorkerLease(lease): Promise<void>`
- Produces: `class WorkerPool`
- `WorkerPool.acquire(packageId): Promise<OrchestrationWorker>`
- `WorkerPool.release(worker): void`
- `WorkerPool.cancel(packageId): Promise<CancelResult>`
- `WorkerPool.getSnapshot(): WorkerPoolSnapshot`

- [ ] **Step 1: Write failing global registry tests**

Use separate fake PIDs/lease IDs and assert:

- eight leases are accepted when limit is 8;
- the ninth is rejected with `Global Codex worker limit 8 reached`;
- leases owned by a dead process are pruned;
- releasing a lease allows another acquisition;
- registry JSON remains valid under concurrent acquisitions.

- [ ] **Step 2: Write failing pool tests with a fake worker factory**

Fake worker:

```js
class FakeWorker {
  constructor(id) {
    this.id = id;
    this.started = false;
    this.closed = false;
  }
  async start() { this.started = true; }
  async interrupt() { return { attempted: true, interrupted: true }; }
  async close() { this.closed = true; }
}
```

Assert:

- pool lazily creates up to configured size;
- a fourth acquire waits when size is 3;
- releasing a worker resolves the oldest waiter;
- idle workers are reused;
- idle TTL closes unused workers;
- `cancel(packageId)` targets the leased worker;
- `close()` rejects pending waiters and closes every worker.

- [ ] **Step 3: Run and confirm failure**

```bash
node --test tests/orchestration-pool.test.mjs
```

- [ ] **Step 4: Implement global lease storage**

Store under:

```text
<plugin-data>/orchestrations/_global/workers.json
<plugin-data>/orchestrations/_global/workers.lock
```

Lease shape:

```js
{
  id: `worker-${process.pid}-${crypto.randomUUID()}`,
  pid: process.pid,
  workspaceKey,
  workerId,
  acquiredAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString()
}
```

Use `withFileLock`. Prune leases whose PID is dead before enforcing the limit.

- [ ] **Step 5: Implement `WorkerPool`**

Constructor:

```js
new WorkerPool({
  workspaceRoot,
  size,
  globalTopLevelLimit,
  idleTtlMs,
  workerFactory,
  onEvent
})
```

Internal maps:

```js
this.workers = new Map();
this.idleWorkerIds = [];
this.packageLeases = new Map();
this.waiters = [];
```

Create workers only when no idle worker exists and `workers.size < size`. Acquire the global lease before `worker.start()`; release it if start fails.

- [ ] **Step 6: Add active Codex accounting hooks**

The pool receives worker events and tracks:

```js
activeTopLevelRoots = packageLeases.size;
activeNativeChildren = sum(worker.nativeChildActive);
activeCodex = activeTopLevelRoots + activeNativeChildren;
```

If `activeCodex` exceeds configured `globalActiveCodexLimit`, call the offending worker's `interrupt()` and emit `active-codex-limit-exceeded`.

- [ ] **Step 7: Run pool tests**

```bash
node --test tests/orchestration-pool.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/global-worker-registry.mjs plugins/codex/scripts/orchestration/worker-pool.mjs tests/orchestration-pool.test.mjs
git commit -m "feat: add bounded orchestration worker pool"
```

---

### Task 10: Implement the Deterministic Orchestration Controller

**Files:**
- Create: `plugins/codex/scripts/orchestration/controller.mjs`
- Create: `tests/orchestration-controller.test.mjs`

**Interfaces:**
- Produces: `class OrchestrationController`
- `start(planInput, context): Promise<OrchestrationSummary>`
- `status(reference): Promise<OrchestrationStatusSnapshot>`
- `result(reference): Promise<OrchestrationResult>`
- `cancel(reference): Promise<CancelSnapshot>`
- `shutdown(): Promise<void>`

- [ ] **Step 1: Write failing controller tests with an injected fake pool**

Create a deterministic fake pool whose `run` returns package results after controlled promises. Test:

1. two independent packages start before either completes;
2. the dependent package starts only after both dependencies complete;
3. package events persist to `events.jsonl`;
4. a transient worker failure retries once on a different attempt;
5. a second transient failure marks the package failed and blocks dependents;
6. cancelling a package interrupts only that package and blocks its dependents;
7. cancelling the orchestration cancels all running packages and prevents queued packages from starting;
8. final state/result is durable and can be read by a fresh controller instance.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/orchestration-controller.test.mjs
```

- [ ] **Step 3: Implement controller construction and plan acceptance**

Constructor:

```js
new OrchestrationController({
  workspaceRoot,
  config,
  pool,
  stateStore,
  now = () => new Date(),
  onMilestone = () => {}
})
```

`start`:

```js
async start(planInput, context = {}) {
  const plan = normalizeOrchestrationPlan(planInput, {
    workspaceRoot: this.workspaceRoot,
    config: this.config
  });
  const state = await this.stateStore.create(plan, context);
  this.runOrchestration(state.id).catch((error) => this.failControllerRun(state.id, error));
  return this.buildSummary(state.id);
}
```

Return immediately after the state is accepted and background execution is started.

- [ ] **Step 4: Implement the scheduling loop**

Maintain:

```js
this.activeRuns = new Map();
this.runningPackages = new Map();
```

The loop must:

1. load current state;
2. derive ready packages;
3. launch up to `plan.budget.workerParallelism` packages;
4. wait for one package promise to settle;
5. update scheduler and durable state;
6. propagate blocked packages;
7. repeat until terminal;
8. write final aggregate result.

Dependency results passed to a package contain only normalized result summaries and evidence—not raw hidden reasoning.

- [ ] **Step 5: Implement package execution and transient retry**

Transient errors are limited to:

```js
const TRANSIENT_CODES = new Set(["EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOENT", "CODEX_WORKER_EXIT"]);
```

Retry exactly once when the error code matches or the error has `transient === true`. Increment package attempt before each run. Do not retry schema errors, model/effort validation errors, read-only boundary violations, or package-reported `failed` status.

- [ ] **Step 6: Implement status/result/cancel**

`status` returns orchestration summary plus package state, pool snapshot, elapsed time, and latest milestones.

`result` returns `buildOrchestrationResult(state)` only for terminal orchestrations. For active orchestrations, throw:

```text
Orchestration <id> is still running. Use /codex:status <id>.
```

`cancel` behavior:

- exact package reference: mark `cancelling`, interrupt through pool, wait up to `DEFAULT_CANCEL_GRACE_MS`, then close the worker if still active; mark package `cancelled`; propagate blocked dependents;
- orchestration reference: mark orchestration `cancelling`, cancel every running package, mark unstarted packages `cancelled`, then finalize `cancelled`.

- [ ] **Step 7: Run controller tests**

```bash
node --test tests/orchestration-controller.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/controller.mjs tests/orchestration-controller.test.mjs
git commit -m "feat: add orchestration controller"
```

---

### Task 11: Add Workspace Controller IPC and Lifecycle Management

**Files:**
- Create: `plugins/codex/scripts/orchestration/ipc.mjs`
- Create: `plugins/codex/scripts/orchestration/controller-lifecycle.mjs`
- Create: `plugins/codex/scripts/orchestration/controller-client.mjs`
- Create: `plugins/codex/scripts/orchestration/controller-server.mjs`
- Create: `tests/orchestration-ipc.test.mjs`

**Interfaces:**
- Produces: `createControllerEndpoint(runtimeDir, platform?)`
- Produces: `parseControllerEndpoint(endpoint)`
- Produces: `ensureControllerServer(workspaceRoot, options): Promise<ControllerSession>`
- Produces: `class OrchestrationControllerClient`
- Protocol methods: `orchestration/start`, `orchestration/status`, `orchestration/result`, `orchestration/cancel`, `controller/status`, `controller/shutdown`.

- [ ] **Step 1: Write endpoint tests**

Assert Unix endpoint:

```text
unix:<runtime-dir>/controller.sock
```

Assert Windows endpoint starts with:

```text
pipe:\\.\pipe\<workspace-key>-codex-orchestrator
```

- [ ] **Step 2: Write a failing detached lifecycle integration test**

The test must:

1. create a temporary workspace and plugin data directory;
2. call `ensureControllerServer` twice concurrently;
3. assert both return the same endpoint/PID;
4. connect with `OrchestrationControllerClient` and call `controller/status`;
5. request `controller/shutdown`;
6. assert the process exits and runtime state is removed.

- [ ] **Step 3: Run and confirm failure**

```bash
node --test tests/orchestration-ipc.test.mjs
```

- [ ] **Step 4: Implement JSONL IPC helpers**

`ipc.mjs` must provide one request per client connection for simplicity:

```js
export async function requestController(endpoint, method, params = {}, options = {}) {
  // Connect, send { id: 1, method, params } + newline, wait for matching response,
  // enforce timeout, close socket, convert JSON-RPC error to Error with rpcCode.
}
```

Use `net.createConnection({ path })` for both Unix sockets and named pipes.

- [ ] **Step 5: Implement controller lifecycle state**

Runtime directory:

```text
<orchestration-workspace-dir>/_controller/
  controller.json
  controller.lock
  controller.sock (Unix only)
```

`controller.json`:

```js
{
  version: 1,
  pid,
  endpoint,
  workspaceRoot,
  pluginVersion,
  startedAt
}
```

`ensureControllerServer` must run under `withFileLock(controller.lock)`, probe an existing endpoint, remove stale state, spawn detached `controller-server.mjs`, and poll until `controller/status` succeeds.

- [ ] **Step 6: Implement controller client methods**

```js
export class OrchestrationControllerClient {
  constructor(endpoint) { this.endpoint = endpoint; }
  start(plan, context) { return requestController(this.endpoint, "orchestration/start", { plan, context }); }
  status(reference = "") { return requestController(this.endpoint, "orchestration/status", { reference }); }
  result(reference = "") { return requestController(this.endpoint, "orchestration/result", { reference }); }
  cancel(reference) { return requestController(this.endpoint, "orchestration/cancel", { reference }); }
  shutdown() { return requestController(this.endpoint, "controller/shutdown", {}); }
}
```

- [ ] **Step 7: Implement `controller-server.mjs`**

Server startup arguments:

```text
serve --workspace <path> --endpoint <endpoint> --runtime-file <path>
```

The server:

- loads effective config;
- constructs `WorkerPool` and `OrchestrationController`;
- handles one newline-delimited request at a time per socket;
- responds before long orchestration execution completes;
- refuses `controller/shutdown` while active orchestrations exist unless `force: true`;
- exits after configured controller idle TTL only when no active orchestration and no worker lease remain;
- removes Unix socket/runtime state on clean exit.

- [ ] **Step 8: Run IPC tests**

```bash
node --test tests/orchestration-ipc.test.mjs
```

- [ ] **Step 9: Commit**

```bash
git add plugins/codex/scripts/orchestration/ipc.mjs plugins/codex/scripts/orchestration/controller-lifecycle.mjs plugins/codex/scripts/orchestration/controller-client.mjs plugins/codex/scripts/orchestration/controller-server.mjs tests/orchestration-ipc.test.mjs
git commit -m "feat: add orchestration controller IPC"
```

---

### Task 12: Add the Orchestration CLI and Legacy Companion Adapter

**Files:**
- Create: `plugins/codex/scripts/orchestration/cli.mjs`
- Create: `plugins/codex/scripts/orchestration/companion-adapter.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/lib/job-control.mjs`
- Create: `tests/orchestration-runtime.test.mjs`
- Modify: `tests/runtime.test.mjs`

**Interfaces:**
- CLI: `start --plan-file <path> [--cwd <path>] [--json]`
- CLI: `status [reference] [--cwd <path>] [--json]`
- CLI: `result [reference] [--cwd <path>] [--json]`
- CLI: `cancel <reference> [--cwd <path>] [--json]`
- Adapter: `isOrchestrationReference`, `listOrchestrationStatus`, `getOrchestrationStatus`, `getOrchestrationResult`, `cancelOrchestration`.

- [ ] **Step 1: Add failing CLI tests**

Test direct CLI subprocess behavior:

```bash
node plugins/codex/scripts/orchestration/cli.mjs start --cwd <repo> --plan-file <plan.json> --json
```

Assert JSON includes:

```js
{
  orchestrationId: /^orch-/,
  status: "queued" | "running",
  objective,
  packageCount: 2,
  commands: {
    status: `/codex:status ${id}`,
    result: `/codex:result ${id}`,
    cancel: `/codex:cancel ${id}`
  }
}
```

- [ ] **Step 2: Add failing legacy companion routing tests**

Test:

- `codex-companion status orch-... --json` returns orchestration status;
- `status` with no reference returns both legacy jobs and orchestration summaries;
- `result pkg-... --json` returns the package result;
- `cancel orch-... --json` routes to the controller;
- unknown non-orchestration references still use legacy job errors.

- [ ] **Step 3: Run and confirm failure**

```bash
node --test tests/orchestration-runtime.test.mjs tests/runtime.test.mjs
```

- [ ] **Step 4: Implement `cli.mjs`**

Use existing `parseArgs` and `readStdinIfPiped`. `start` accepts exactly one plan source:

- `--plan-file`;
- piped JSON.

Reject positional natural language; Claude must create the structured plan first.

`start` flow:

```js
const workspaceRoot = resolveWorkspaceRoot(cwd);
const session = await ensureControllerServer(workspaceRoot, { env: process.env });
const client = new OrchestrationControllerClient(session.endpoint);
const plan = JSON.parse(planText);
const summary = await client.start(plan, {
  claudeSessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null
});
```

- [ ] **Step 5: Implement companion adapter**

Reference detection must not rely only on prefixes because package IDs are user-defined. Resolve against durable orchestration state first; return `null` when no match so legacy job resolution can continue.

```js
export async function tryResolveOrchestrationReference(cwd, reference) {
  try {
    return resolveOrchestrationReference(resolveWorkspaceRoot(cwd), reference);
  } catch (error) {
    if (/No orchestration or package found/.test(error.message)) return null;
    throw error;
  }
}
```

- [ ] **Step 6: Extend `codex-companion` handlers**

`handleStatus`:

- with a reference: try orchestration first, then legacy job;
- without a reference: add `orchestrations` to `buildStatusSnapshot` output;
- `--wait` remains legacy-job-only in Phase 1; reject `--wait` for orchestration references with a precise message.

`handleResult` and `handleCancel` follow the same orchestration-first, legacy-fallback order.

- [ ] **Step 7: Run routing tests**

```bash
node --test tests/orchestration-runtime.test.mjs tests/runtime.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/scripts/orchestration/cli.mjs plugins/codex/scripts/orchestration/companion-adapter.mjs plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/job-control.mjs tests/orchestration-runtime.test.mjs tests/runtime.test.mjs
git commit -m "feat: route orchestration commands"
```

---

### Task 13: Add Orchestration Renderers and Combined Status Output

**Files:**
- Modify: `plugins/codex/scripts/lib/render.mjs`
- Modify: `tests/render.test.mjs`
- Modify: `tests/orchestration-runtime.test.mjs`

**Interfaces:**
- Produces: `renderOrchestrationLaunch(summary)`
- Produces: `renderOrchestrationStatus(snapshot)`
- Produces: `renderOrchestrationResult(result)`
- Produces: `renderOrchestrationCancel(snapshot)`
- Extends: `renderStatusReport(report)` with an orchestration table.

- [ ] **Step 1: Add failing renderer tests**

Expected status table:

```markdown
Active orchestrations:
| Orchestration | Status | Packages | Running | Completed | Failed | Elapsed | Objective | Actions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
```

Package detail table:

```markdown
| Package | Role | Model / Effort | Status | Worker | Codex Session ID | Native Children | Summary |
```

Result output must include:

- orchestration ID and final status;
- each package's complete normalized summary, claims, evidence, verification, residual risks, and confidence;
- omissions and remaining work;
- no reasoning summary sections.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/render.test.mjs
```

- [ ] **Step 3: Implement orchestration renderers**

`renderOrchestrationLaunch`:

```text
Multi-Codex orchestration <id> started.
Status: <status>
Packages: <count>
Status: /codex:status <id>
Result: /codex:result <id>
Cancel: /codex:cancel <id>
```

`renderOrchestrationStatus` must show milestone progress but not raw command logs unless a package failed.

`renderOrchestrationResult` must render evidence entries as:

```text
- [file] src/cache.mjs:42-58 — Cache generation is not invalidated after config changes.
- [command] npm test -- cache (exit 0) — Regression test reproduced the stale value.
```

- [ ] **Step 4: Extend combined legacy status**

Add an orchestration section before active jobs. Preserve the existing job table exactly when there are no orchestrations.

- [ ] **Step 5: Run render and runtime tests**

```bash
node --test tests/render.test.mjs tests/orchestration-runtime.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/render.mjs tests/render.test.mjs tests/orchestration-runtime.test.mjs
git commit -m "feat: render orchestration status and results"
```

---

### Task 14: Add the Claude Command and Skill Policy Surface

**Files:**
- Create: `plugins/codex/commands/orchestrate.md`
- Modify: `plugins/codex/commands/status.md`
- Modify: `plugins/codex/commands/result.md`
- Modify: `plugins/codex/commands/cancel.md`
- Create: `plugins/codex/skills/codex-orchestration/SKILL.md`
- Create: `plugins/codex/skills/codex-work-package-contract/SKILL.md`
- Create: `plugins/codex/skills/codex-integration-policy/SKILL.md`
- Create: `plugins/codex/skills/codex-orchestration-recovery/SKILL.md`
- Create: `tests/orchestration-skill.test.mjs`
- Modify: `tests/commands.test.mjs`

**Interfaces:**
- `/codex:orchestrate <task>` causes Claude Root—not a forwarding subagent—to inspect the repository, construct a plan JSON, issue the compressed plan notification, and start the controller.
- `codex-orchestration` is the only auto-trigger orchestration skill.
- Internal policy skills use `user-invocable: false` and narrow descriptions.

- [ ] **Step 1: Add failing command/skill tests**

Assert:

- `orchestrate.md` exists and is included in the command file list;
- it does not invoke `codex:codex-rescue` or any general-purpose planning subagent;
- it requires a canonical plan file and calls `orchestration/cli.mjs start`;
- it requires a compressed 3–6 line plan notification before start;
- it states that local read-only execution begins without waiting for approval;
- the root skill contains hard exclusions and the ten-point Complexity Score;
- score 5+ prefers auto orchestration when enabled;
- Phase 1 rejects write packages;
- Root/native-child ownership is explicit;
- `Sol > Terra > Luna` and effort separation are explicit;
- internal skills are non-user-invocable;
- recovery skill states that controller restart auto-resume is deferred to Phase 3.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/orchestration-skill.test.mjs tests/commands.test.mjs
```

- [ ] **Step 3: Write `orchestrate.md`**

Frontmatter:

```yaml
---
description: Plan and start a Claude-managed read-only Multi-Codex orchestration
argument-hint: '<repository task>'
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*)
---
```

Required body sequence:

1. Load and follow `codex-orchestration`.
2. Inspect only enough repository context to identify package boundaries and acceptance criteria.
3. Refuse Phase 1 writer packages and explain that write orchestration arrives in Phase 2.
4. Write canonical JSON to a temporary file under `${TMPDIR:-/tmp}` with a collision-safe name.
5. Show the compressed plan notification.
6. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration/cli.mjs" start --cwd "$PWD" --plan-file "<absolute-plan-path>"
```

7. Delete the temporary plan file after the start command returns.
8. Return the launch output without inventing completion claims.

- [ ] **Step 4: Write the root orchestration skill**

The skill must include:

```yaml
---
name: codex-orchestration
description: Use for an explicit Multi-Codex request or, when automatic orchestration is enabled, for repository work with multiple genuinely independent packages that meets the Complexity Score threshold
user-invocable: false
---
```

It must define:

- hard exclusions;
- ten scoring factors;
- score behavior;
- package role classes;
- model routing;
- adaptive budget;
- dependency contract;
- read-only Phase 1 restriction;
- native child policy;
- exact canonical plan shape;
- compressed plan notification;
- controller invocation;
- evidence-based result interpretation;
- no automatic claim that queued work is complete.

- [ ] **Step 5: Write the three internal skills**

`codex-work-package-contract` defines bounded objective, dependencies, role, model/effort, max children, acceptance criteria, and expected outputs.

`codex-integration-policy` states that Phase 1 only interprets read-only results and must not apply patches, create branches, or merge changes.

`codex-orchestration-recovery` states:

- live controller reconnect is allowed;
- durable status/result remain readable after controller exit;
- an orchestration found `running` without a live controller is reported `failed` with a recovery limitation;
- automatic restart/resume and orphan reconciliation are Phase 3 work.

- [ ] **Step 6: Update status/result/cancel command copy**

Change hints to `[job-id|orchestration-id|package-id]` and preserve existing Bash entrypoints. Explain combined status and full orchestration/package output.

- [ ] **Step 7: Run skill and command tests**

```bash
node --test tests/orchestration-skill.test.mjs tests/commands.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add plugins/codex/commands plugins/codex/skills/codex-orchestration plugins/codex/skills/codex-work-package-contract plugins/codex/skills/codex-integration-policy plugins/codex/skills/codex-orchestration-recovery tests/orchestration-skill.test.mjs tests/commands.test.mjs
git commit -m "feat: add Claude Multi-Codex orchestration skill"
```

---

### Task 15: Prove Real Parallelism and Full Phase 1 Command Behavior

**Files:**
- Modify: `tests/orchestration-runtime.test.mjs`
- Modify: `tests/fake-codex-fixture.mjs`
- Modify: `tests/runtime.test.mjs`

**Interfaces:**
- No new production interface; this task is the Phase 1 integration gate.

- [ ] **Step 1: Add the parallel overlap test**

Start an orchestration with two independent 300 ms packages and one dependent package. Read fake events and assert:

```js
const starts = events.filter((event) => event.type === "turn-started" && ["pkg-a", "pkg-b"].includes(event.packageId));
const completes = events.filter((event) => event.type === "turn-completed" && ["pkg-a", "pkg-b"].includes(event.packageId));
assert.equal(starts.length, 2);
assert.equal(completes.length, 2);
assert.equal(Math.max(...starts.map((event) => event.timestamp)) < Math.min(...completes.map((event) => event.timestamp)), true);
```

Also assert at least two distinct App Server PIDs handled the independent packages.

- [ ] **Step 2: Add event isolation assertions**

Give packages distinct claims and assert neither package result contains the other's package ID, claims, thread ID, or events. Assert the dependent package receives only dependency result summaries through its prompt.

- [ ] **Step 3: Add transient retry coverage**

With `orchestration-transient-once`:

- first attempt exits the worker;
- controller records `package-retry`;
- second attempt succeeds;
- package attempt equals 2;
- unrelated package remains on attempt 1.

- [ ] **Step 4: Add package and whole-orchestration cancellation coverage**

For a long-running package:

```js
await cancelPackage(pkgId);
assert.equal(packageState.status, "cancelled");
assert.equal(events.some((event) => event.type === "turn-interrupted"), true);
```

For whole cancellation, assert queued packages never emit `turn-started`.

- [ ] **Step 5: Add malformed result and boundary violation coverage**

- malformed JSON marks only that package failed;
- a fake non-empty `changedFiles` result is rejected;
- a fake `fileChange` App Server item is rejected even if returned JSON says `changedFiles: []`;
- dependent packages become blocked;
- independent packages complete.

- [ ] **Step 6: Run the integration suite repeatedly**

```bash
for i in 1 2 3; do node --test tests/orchestration-runtime.test.mjs || exit 1; done
```

Expected: all three runs PASS without leaked controller or App Server processes.

- [ ] **Step 7: Run the full test suite and build**

```bash
npm test
npm run build
git diff --check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/orchestration-runtime.test.mjs tests/fake-codex-fixture.mjs tests/runtime.test.mjs
git commit -m "test: verify parallel Multi-Codex orchestration"
```

---

### Task 16: Document Phase 1 and Finalize the Release-Ready Verification Gate

**Files:**
- Modify: `README.md`
- Modify: `plugins/codex/CHANGELOG.md`
- Modify: `tsconfig.app-server.json`
- Modify: `.github/workflows/pull-request-ci.yml`
- Modify: `tests/commands.test.mjs`

**Interfaces:**
- Documentation only; no new runtime API.

- [ ] **Step 1: Add failing documentation assertions**

In `tests/commands.test.mjs`, assert README includes:

- `/codex:orchestrate`;
- `read-only Phase 1`;
- automatic entry enable/disable commands;
- default pool size 3 and configured range 1–8;
- top-level limit 8 and active Codex limit 12;
- status/result/cancel examples with orchestration IDs;
- explicit statement that writer worktrees and Git integration are Phase 2.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/commands.test.mjs
```

- [ ] **Step 3: Update README**

Add sections:

```text
Claude-Native Multi-Codex Orchestration
Automatic Entry
Plan and Package Contract
Worker and Budget Limits
Status, Results, and Cancellation
Phase 1 Read-Only Boundary
Configuration
```

Example explicit use:

```bash
/codex:orchestrate investigate the cache regression and independently challenge the concurrency assumptions
/codex:status orch-...
/codex:result orch-...
/codex:cancel orch-...
```

Example setup:

```bash
/codex:setup --enable-orchestration
/codex:setup --disable-orchestration
```

- [ ] **Step 4: Update changelog without changing the package version**

Add an `Unreleased` section summarizing Phase 1. Do not introduce a fork or upstream release version bump in this task.

- [ ] **Step 5: Expand CI to a platform matrix**

Change `pull-request-ci.yml` to run Node 22 on:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

Use platform-neutral commands. Replace shell-specific `mkdir -p` in the `prebuild` package script before enabling Windows CI:

```json
"prebuild": "node scripts/prepare-generated-dir.mjs && codex app-server generate-ts --out plugins/codex/.generated/app-server-types"
```

Create `scripts/prepare-generated-dir.mjs`:

```js
import fs from "node:fs";
fs.mkdirSync(new URL("../plugins/codex/.generated/app-server-types", import.meta.url), { recursive: true });
```

Add the file to the task's commit.

- [ ] **Step 6: Run all local gates**

```bash
npm ci
npm run check-version
npm test
npm run build
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Inspect for prohibited Phase 2/3 implementation leakage**

Run:

```bash
git grep -nE 'git worktree add|refs/codex-orchestration/snapshots|integration branch|danger-full-access' -- plugins/codex/scripts/orchestration
```

Expected: no production implementation of writer worktrees, snapshot refs, integration branches, or write sandbox. Documentation may name later phases, but runtime files must remain read-only.

- [ ] **Step 8: Commit**

```bash
git add README.md plugins/codex/CHANGELOG.md .github/workflows/pull-request-ci.yml package.json scripts/prepare-generated-dir.mjs tests/commands.test.mjs tsconfig.app-server.json
git commit -m "docs: document read-only Multi-Codex orchestration"
```

---

## Final Phase 1 Verification Checklist

- [ ] Create an isolated implementation worktree from the approved design/plan branch before changing code.
- [ ] Run `npm ci` before the first implementation task.
- [ ] Confirm the baseline suite passes before adding orchestration code.
- [ ] Complete Tasks 1–16 in order; do not combine commits unless a task cannot independently pass its focused tests.
- [ ] Confirm existing single-job broker reuse tests still pass.
- [ ] Confirm `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:transfer`, status/result/cancel for legacy jobs, setup, hooks, and review gate remain green.
- [ ] Confirm two top-level Roots overlap in time and use distinct App Server PIDs.
- [ ] Confirm a worker never runs two top-level packages simultaneously.
- [ ] Confirm native child events are attributed to the owning package and count against the active-Codex limit.
- [ ] Confirm model/effort validation still comes from the App Server catalog.
- [ ] Confirm every package run uses `read-only` sandbox and returns no file changes.
- [ ] Confirm malformed output and one package failure do not contaminate independent package results.
- [ ] Confirm transient failure retries only the failed package and at most once.
- [ ] Confirm package and whole-orchestration cancellation send interrupts and stop new scheduling.
- [ ] Confirm status/result remain readable from durable state when no controller is live.
- [ ] Confirm a stale `running` state without a live controller is reported honestly; do not claim Phase 3 recovery.
- [ ] Confirm automatic orchestration is disabled by default and explicit `/codex:orchestrate` remains available.
- [ ] Confirm setup flags persist only the intended user configuration patch.
- [ ] Confirm no runtime dependency was added.
- [ ] Confirm `npm run check-version` passes without a version bump.
- [ ] Confirm `npm test`, `npm run build`, and `git diff --check` pass on the final tree.
- [ ] Confirm the pull-request CI matrix passes on Ubuntu, macOS, and Windows.

## Spec Coverage Audit

| Approved Phase 1 requirement | Implemented by task(s) |
|---|---|
| `/codex:orchestrate` explicit command | 12, 14 |
| Automatic-entry skill and feature flag | 2, 14 |
| Plan and result schemas | 3 |
| Deterministic controller and persistent state | 4, 10, 11 |
| Workspace-scoped App Server worker pool | 6, 8, 9 |
| DAG scheduler and adaptive budget | 5, 10 |
| Model and effort routing/validation | 3, 6, 8, 14 |
| Read-only package execution | 3, 8 |
| Native-child event observation | 6, 8, 9 |
| Orchestration-aware status/result/cancel | 10, 12, 13 |
| Structured result capture and Markdown rendering | 3, 8, 13 |
| Concurrent Root proof | 7, 15 |
| Package-scoped failure and retry | 5, 10, 15 |
| Bounded workers and global limits | 2, 5, 9 |
| Durable milestone events | 4, 8, 10 |
| Cross-platform IPC and CI | 11, 16 |
| Existing single-job behavior preserved | 1, 6, 12, 15, 16 |
| Phase 2/3 boundaries preserved | Global Constraints, 14, 16 |
