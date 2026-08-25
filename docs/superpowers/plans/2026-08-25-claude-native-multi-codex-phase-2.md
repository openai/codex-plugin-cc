# Claude-Native Multi-Codex Orchestration Phase 2 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with test-first changes and focused commits. Do not start a later task while an earlier task's focused tests are red. The final implementation must preserve all Phase 1 behavior and remain mergeable as one coherent feature.

- **Status:** Approved implementation plan
- **Date:** 2026-08-25
- **Target repository:** `eureka-pd/codex-plugin-cc`
- **Base:** Phase 1 merged at `3444f60f4a124b2b24df654e5df6787b8478ab8d`
- **Scope:** Clean-tree local writer orchestration only

**Goal:** Extend the Phase 1 read-only Multi-Codex runtime with safe clean-tree writer execution, isolated package worktrees, controller-owned package commits, deterministic integration, independent review, full verification, one final squash commit, and conditional fast-forward application to an unchanged clean user branch.

**Architecture:** Claude Root still owns decomposition, ownership, risk declarations, reviewer policy, and final judgment. The detached Node.js controller owns mechanical write execution: workspace write leases, clean-tree baseline capture, package worktree lifecycle, App Server approval mediation, ownership auditing, package commit normalization, dependency-ordered integration, deterministic verification, reviewer execution, final commit creation, and safe application. Phase 2 uses the existing Phase 1 controller, scheduler, worker slots, state store, and command surfaces rather than adding a second orchestration runtime.

**Tech Stack:** Node.js 18.18+ ESM, built-in `node:test`, Git CLI invoked with argv arrays and `shell: false`, Codex App Server JSONL v2 protocol, workspace-write sandbox policies, server-initiated approval requests, filesystem-backed JSON/JSONL state, Unix sockets on macOS/Linux, named pipes on Windows.

---

## 1. Phase 2 Boundaries

### Included

- Git repositories whose user branch, index, and working tree are clean at orchestration start.
- One or more `access: "write"` work packages.
- Isolated package branches and worktrees for every multi-writer plan.
- Isolated worktree execution as the default even for one writer.
- A tightly gated direct single-writer optimization implemented only after the isolated path is complete.
- Controller-mediated command and file-change approvals.
- Controller-owned package commit normalization.
- Declared file ownership and changed-file auditing.
- Controller-run package and integration verification commands.
- Dependency-ordered package commit integration.
- Mechanical conflict detection and explicit decision-point records.
- Risk-triggered independent integration review.
- A single final commit whose parent is the orchestration base commit.
- Automatic fast-forward application only when the user branch is unchanged and clean.
- Preservation of package branches, worktrees, integration state, and final commit when automatic application is unsafe.

### Explicitly deferred to Phase 3

- Starting write orchestration from a dirty working tree.
- Hidden snapshot refs representing staged, unstaged, and untracked user work.
- Automatic recovery or resume of an interrupted write orchestration.
- Reattaching to orphaned write workers or blindly continuing an abandoned worktree.
- Dynamic DAG revision, repair-package insertion, or semantic conflict-resolution packages.
- Automatic retention pruning and stale worktree deletion.
- Cross-session write resumption.
- Replaying previously approved external actions.

### Never allowed automatically

- `git push`, force-push, remote branch deletion, PR mutation, release publication, deployment, cloud mutation, remote database mutation, credential changes, purchases, or destructive writes outside the package worktree.
- Semantic merge-conflict resolution invented by the controller.
- Silent reset, stash, checkout, clean, or index rewrite of the user's active worktree to make orchestration possible.
- Automatic fallback from a restricted writer sandbox to unrestricted local access.

---

## 2. Normative Implementation Decisions

These decisions resolve ambiguities between the approved design and the concrete Phase 1 implementation.

### 2.1 Preserve plan version 1

`ORCHESTRATION_PLAN_VERSION` remains `1`. Phase 2 extends the existing contract in a backward-compatible direction:

- Phase 1 read-only plans remain valid without new fields.
- Write packages require the new ownership, workspace, verification, and integration fields.
- Persisted Phase 1 orchestration records remain readable.

Do not invalidate existing read-only callers merely to distinguish the implementation phase.

### 2.2 Use state version 2 with read migration

`ORCHESTRATION_STATE_VERSION` becomes `2`. `loadOrchestrationState` must normalize version-1 records in memory by adding absent write/integration fields with safe read-only defaults. It must not rewrite old state merely because it was read.

### 2.3 Isolated writer mode is the correctness path

Every writer uses an isolated package worktree unless the strict direct-mode predicate in Task 16 succeeds. A single writer does not automatically imply direct execution.

### 2.4 All isolated writers start from the same immutable base

Phase 2 writer worktrees start from the clean orchestration-start `HEAD` commit. Package dependencies define scheduling and integration order, but a downstream writer does not automatically receive an upstream writer's unintegrated tree.

If a package requires another writer's concrete code as its implementation base, Claude must combine them into one writer package in Phase 2. Dependency-tip worktrees and dynamic repair packages are Phase 3.

### 2.5 Integration Reviewer is a post-package gate

The integration Reviewer is declared under the plan's top-level `integration.reviewer` policy. It is not a normal DAG package and does not compete with implementation packages for dependency scheduling. The controller may execute it only according to the pre-authorized plan policy and deterministic trigger rules.

Claude still chooses its role label, model, effort, and native-child policy in the plan. The controller does not invent a semantic reviewer configuration.

### 2.6 Verification commands are argv arrays

Package and integration verification commands use arrays, not shell strings:

```json
{
  "argv": ["npm", "test", "--", "auth"],
  "timeoutMs": 900000
}
```

The controller executes them with `shell: false`. Shell pipelines, redirects, command substitution, and chained commands are not supported in Phase 2. Claude must split them into multiple commands.

### 2.7 Prefer workspace-write sandboxing

Writer turns use a workspace-write sandbox rooted at the package worktree with network access disabled. The controller must not automatically fall back to `dangerFullAccess`.

An explicit project/user configuration may permit unrestricted writer access, but automatic orchestration must still fail closed when the active App Server or managed requirements cannot enforce the selected mode. The initial shipped default is workspace-write.

### 2.8 The controller owns Git commits

A Codex Root may leave uncommitted changes or create one or more local commits inside its isolated package branch. The controller always audits the final tree and normalizes it to exactly one package commit. Model-reported commit SHAs are advisory and never canonical.

### 2.9 Conflict decision points are terminal in Phase 2

A semantic cherry-pick conflict, reviewer `revise`/`reject`, ownership violation, unsafe user-branch movement, or failed required integration verification preserves artifacts and ends the orchestration as `blocked`, `degraded`, or `failed` with a structured decision point. Automatic resume and repair-package insertion arrive in Phase 3.

### 2.10 Final application is fast-forward only

The final squash commit is created with the orchestration base commit as its sole parent. Automatic application to the user branch uses a fast-forward-only operation after revalidating the original branch, `HEAD`, index, and clean worktree. If any check fails, the final commit is preserved but not applied.

---

## 3. Extended Plan Contract

A read-only Phase 1 package remains unchanged. A write-capable plan adds the following conceptual fields.

```json
{
  "version": 1,
  "objective": "Implement and verify the authentication change",
  "complexityScore": 7,
  "requestedBy": {
    "explicit": true,
    "sessionId": "claude-session-id"
  },
  "riskTags": ["authentication", "public-api"],
  "integration": {
    "enabled": true,
    "verificationCommands": [
      {
        "argv": ["npm", "test"],
        "timeoutMs": 1200000
      },
      {
        "argv": ["npm", "run", "build"],
        "timeoutMs": 1200000
      }
    ],
    "reviewer": {
      "mode": "auto",
      "role": {
        "class": "reviewer",
        "label": "integration-reviewer"
      },
      "model": {
        "name": "gpt-5.6-sol",
        "effort": "max"
      },
      "nativeSubagents": {
        "policy": "allowed",
        "maxChildren": 1
      }
    },
    "finalCommit": {
      "mode": "squash",
      "autoApply": true,
      "subject": "feat: implement authentication change"
    }
  },
  "packages": [
    {
      "id": "pkg-auth-backend",
      "title": "Implement authentication backend",
      "role": {
        "class": "implementer",
        "label": "authentication-backend-implementer"
      },
      "objective": "Implement the backend change without altering unrelated APIs.",
      "dependencies": [],
      "optional": false,
      "access": "write",
      "ownership": {
        "files": ["src/auth/**", "tests/auth/**"],
        "interfaces": ["auth-session-contract"]
      },
      "workspace": {
        "mode": "isolated-worktree",
        "base": "orchestration-head"
      },
      "model": {
        "name": "gpt-5.6-terra",
        "effort": "high"
      },
      "nativeSubagents": {
        "policy": "allowed",
        "maxChildren": 1
      },
      "acceptanceCriteria": [
        "Existing auth tests pass.",
        "Failure-path tests cover the new behavior."
      ],
      "verificationCommands": [
        {
          "argv": ["npm", "test", "--", "auth"],
          "timeoutMs": 600000
        }
      ],
      "riskTags": ["authentication"],
      "expectedOutputs": [
        "changed files",
        "normalized package commit",
        "verification evidence",
        "residual risks"
      ]
    }
  ]
}
```

### 3.1 Package access and workspace rules

| Access | Allowed workspace mode | Phase 2 behavior |
|---|---|---|
| `read-only` | `shared` | Existing Phase 1 behavior. |
| `write` | `isolated-worktree` | Default writer path. |
| `write` | `direct` | Strictly gated single-writer optimization from Task 16. |

Rules:

- A write package requires non-empty `ownership.files`.
- Ownership paths are repository-relative and use `/` separators.
- Absolute paths, `..`, empty path segments, `.git`, and unsupported glob syntax are rejected.
- A write package requires at least one package verification command unless the plan explicitly sets `verificationWaiver` with a non-empty reason. Automatic orchestration may not use a waiver.
- Any plan with a writer requires `integration.enabled: true`.
- `integration.finalCommit.mode` is `squash` in Phase 2.
- A read-only-only plan may omit `riskTags` and `integration` and remains a Phase 1 plan.

### 3.2 Supported ownership glob grammar

Implement a dependency-free constrained matcher:

- exact path: `src/auth/session.ts`
- recursive directory: `src/auth/**`
- single-segment wildcard: `src/*/index.ts`
- suffix wildcard inside one segment: `tests/auth/*.test.ts`

Reject braces, extglobs, negation, character classes, backtracking constructs, absolute paths, and patterns containing `..`. The limited grammar keeps matching deterministic and cross-platform.

### 3.3 Risk tags

Built-in tags:

- `security`
- `authentication`
- `authorization`
- `concurrency`
- `data-loss`
- `migration`
- `rollback`
- `public-api`
- `schema`
- `protocol`
- `build-system`
- `dependency`

Unknown non-empty tags may be preserved for forward compatibility, but built-in reviewer triggers rely only on the built-in set.

---

## 4. Write and Integration State

### 4.1 Orchestration write metadata

```js
write: {
  enabled: true,
  mode: "isolated" | "direct",
  lease: {
    orchestrationId,
    controllerInstanceId,
    pid,
    acquiredAt,
    heartbeatAt
  },
  baseline: {
    repositoryRoot,
    gitCommonDir,
    branch,
    detached,
    head,
    indexTree,
    statusPorcelainV2,
    capturedAt
  }
}
```

### 4.2 Package write metadata

```js
workspace: {
  mode: "isolated-worktree" | "direct",
  path,
  branch,
  baseCommit,
  createdAt,
  preserved: false
},
writeResult: {
  packageCommit,
  changedFiles,
  ownershipAudit,
  verification,
  modelReportedChangedFiles,
  normalizedAt
}
```

### 4.3 Integration metadata

```js
integration: {
  status: "pending" | "preparing" | "integrating" | "verifying" |
    "reviewing" | "approved" | "blocked" | "failed" | "applied" | "preserved",
  branch,
  worktreePath,
  baseCommit,
  integratedPackages: [],
  skippedPackages: [],
  conflicts: [],
  verification: null,
  reviewer: null,
  finalCommit: null,
  application: {
    requested: true,
    eligible: false,
    applied: false,
    reason: null
  },
  decisionPoint: null,
  startedAt: null,
  completedAt: null
}
```

### 4.4 Orchestration lifecycle

```text
queued
  → running
  → integrating
  → completed | completed-with-omissions

running/integrating
  → blocked | degraded | failed | cancelled
```

A write orchestration does not become `completed` merely because all packages are terminal. The controller must finish integration, required verification, reviewer gates, final commit creation, and application/preservation classification first.

---

## 5. File and Responsibility Map

### Existing files to modify

| File | Phase 2 responsibility |
|---|---|
| `plugins/codex/scripts/lib/app-server.mjs` | Add pluggable handling for server-initiated approval requests without changing default rejection behavior. |
| `plugins/codex/scripts/lib/app-server-protocol.d.ts` | Add server-request and current sandbox/approval request typing needed by writer workers. |
| `plugins/codex/scripts/lib/codex.mjs` | Accept caller-provided approval policy and turn-level sandbox policy; preserve read-only defaults. |
| `plugins/codex/scripts/lib/git.mjs` | Export or delegate safe low-level Git helpers while preserving review behavior. |
| `plugins/codex/scripts/orchestration/constants.mjs` | Add write, integration, reviewer, risk, and state constants. |
| `plugins/codex/scripts/orchestration/config.mjs` | Add Git, safety, verification, and write-mode configuration. |
| `plugins/codex/scripts/orchestration/plan-contract.mjs` | Normalize read/write packages, ownership, commands, risk tags, and integration policy. |
| `plugins/codex/scripts/orchestration/result-contract.mjs` | Separate model-reported write results from controller-canonical results and render integration results. |
| `plugins/codex/scripts/orchestration/state-store.mjs` | Persist state version 2, write baseline, worktrees, package commits, integration, reviewer, and decisions. |
| `plugins/codex/scripts/orchestration/package-prompt.mjs` | Build read-only, writer, and integration-review prompts. |
| `plugins/codex/scripts/orchestration/package-worker.mjs` | Execute read-only or write packages in the supplied workspace with approval mediation and sandbox policy. |
| `plugins/codex/scripts/orchestration/worker-pool.mjs` | Support per-execution workspace roots, access modes, sandbox policy, and approval context. |
| `plugins/codex/scripts/orchestration/controller.mjs` | Acquire write leases, prepare workspaces, normalize commits, integrate, review, verify, apply, preserve, and cancel. |
| `plugins/codex/scripts/orchestration/controller-server.mjs` | Expose integration/application status and preserve write state on shutdown. |
| `plugins/codex/scripts/orchestration/controller-client.mjs` | Add typed internal operations required by integration and tests. |
| `plugins/codex/scripts/orchestration/cli.mjs` | Render write/integration state and expose deterministic internal inspect/apply surfaces. |
| `plugins/codex/scripts/codex-companion.mjs` | Preserve routing while showing write/integration milestones and results. |
| `plugins/codex/scripts/lib/render.mjs` | Render worktree, commit, reviewer, verification, application, and decision-point information. |
| `plugins/codex/skills/codex-orchestration/SKILL.md` | Allow clean-tree local write plans and require ownership/risk/integration policy. |
| `plugins/codex/skills/codex-work-package-contract/SKILL.md` | Define writer boundaries, verification, and commit ownership. |
| `plugins/codex/skills/codex-integration-policy/SKILL.md` | Replace the Phase 1 prohibition with Phase 2 integration and reviewer policy. |
| `plugins/codex/skills/codex-orchestration-recovery/SKILL.md` | State that interrupted write runs preserve artifacts and do not auto-resume until Phase 3. |
| `plugins/codex/commands/orchestrate.md` | Document clean-tree write behavior and compressed plan fields. |
| `README.md` | Document writer safety, worktrees, reviewer gates, final commit, and Phase 3 exclusions. |
| `tsconfig.app-server.json` | Type-check all new writer and integration modules. |

### New runtime modules

| File | Single responsibility |
|---|---|
| `plugins/codex/scripts/orchestration/git-state.mjs` | Capture and compare clean user-worktree baseline state and detect in-progress Git operations. |
| `plugins/codex/scripts/orchestration/workspace-write-lease.mjs` | Enforce one active write orchestration per repository across controller processes. |
| `plugins/codex/scripts/orchestration/ownership-policy.mjs` | Validate ownership patterns, detect package overlap, and audit actual changed files. |
| `plugins/codex/scripts/orchestration/approval-policy.mjs` | Classify App Server command/file/permission requests and return fail-closed decisions. |
| `plugins/codex/scripts/orchestration/verification-runner.mjs` | Execute declared argv commands with timeout, bounded logs, redaction, and process-tree termination. |
| `plugins/codex/scripts/orchestration/worktree-manager.mjs` | Create, validate, preserve, and remove package/integration worktrees and refs. |
| `plugins/codex/scripts/orchestration/package-commit.mjs` | Audit and normalize one writer package to one atomic commit with trailers. |
| `plugins/codex/scripts/orchestration/integration-manager.mjs` | Create integration state, cherry-pick package commits, detect conflicts, verify, create final commit, and apply/preserve. |
| `plugins/codex/scripts/orchestration/reviewer-policy.mjs` | Decide whether review is required and validate reviewer verdicts. |
| `plugins/codex/scripts/orchestration/redaction.mjs` | Redact approval, command, and verification logs before durable persistence. |

### Schemas to modify or add

| File | Responsibility |
|---|---|
| `plugins/codex/scripts/orchestration/schemas/config.schema.json` | Full Phase 2 configuration schema. |
| `plugins/codex/scripts/orchestration/schemas/orchestration-plan.schema.json` | Read/write package, ownership, risk, and integration policy schema. |
| `plugins/codex/scripts/orchestration/schemas/package-result.schema.json` | Model-reported package result schema permitting writer change claims. |
| `plugins/codex/scripts/orchestration/schemas/orchestration-result.schema.json` | Canonical aggregate result including integration/application. |
| `plugins/codex/scripts/orchestration/schemas/reviewer-result.schema.json` | `approve | revise | reject` integration Reviewer result. |
| `plugins/codex/scripts/orchestration/schemas/decision-point.schema.json` | Conflict, review, verification, ownership, and application decision records. |

### New focused tests

| File | Coverage |
|---|---|
| `tests/orchestration-write-contracts.test.mjs` | Backward-compatible read plans and strict write-plan validation. |
| `tests/orchestration-git-state.test.mjs` | Clean baseline, Git-operation detection, and branch/head/index comparisons. |
| `tests/orchestration-write-lease.test.mjs` | Cross-process single-writer lease and stale-owner behavior. |
| `tests/orchestration-ownership.test.mjs` | Pattern grammar, overlap detection, and changed-file audit. |
| `tests/orchestration-approval.test.mjs` | Command/file/network/permission decisions and redaction. |
| `tests/orchestration-verification.test.mjs` | Argv execution, timeout, cancellation, and bounded logs. |
| `tests/orchestration-worktree.test.mjs` | Package/integration worktrees, branch naming, and cross-platform cleanup. |
| `tests/orchestration-package-commit.test.mjs` | Uncommitted, single-commit, multi-commit, ownership violation, and trailers. |
| `tests/orchestration-integration.test.mjs` | Topological integration, omissions, conflicts, verification, final commit, and application. |
| `tests/orchestration-reviewer.test.mjs` | Trigger policy, Reviewer schema, and blocking verdicts. |
| `tests/orchestration-write-runtime.test.mjs` | Full fake-App-Server one-writer, two-writer, denial, cancellation, and no-auto-apply flows. |

---

# Implementation Tasks

## Task 1: Lock Phase 1 Regression Behavior and Add Write-Plan Contract Tests

**Files:**
- Modify: `tests/orchestration-contracts.test.mjs`
- Create: `tests/orchestration-write-contracts.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/constants.mjs`
- Modify: `plugins/codex/scripts/orchestration/plan-contract.mjs`
- Modify: `plugins/codex/scripts/orchestration/schemas/orchestration-plan.schema.json`

**Required outcomes:**

- Existing read-only plan normalization remains byte-for-byte equivalent for existing fields.
- Plan version remains `1`.
- Write packages are rejected until all required write fields are present.
- Ownership overlap is validated before any controller or worker starts.
- Any writer requires top-level integration policy.

- [ ] Add regression tests proving the current Phase 1 sample still normalizes and freezes correctly.
- [ ] Add failing tests for `access: "write"`, `ownership`, `workspace.mode`, package verification commands, `riskTags`, and `integration`.
- [ ] Add failing tests for absolute ownership paths, `..`, `.git/**`, unsupported glob syntax, duplicate command entries, shell-string commands, direct mode with multiple writers, and missing integration policy.
- [ ] Add failing tests proving a read-only plan may still omit all Phase 2 fields.
- [ ] Implement normalization helpers for command specs, ownership, risk tags, reviewer policy, and final-commit policy.
- [ ] Keep Phase 1's model, effort, native-child, dependency, optional, and budget validations unchanged.
- [ ] Freeze normalized plans recursively.

**Focused verification:**

```bash
node --test tests/orchestration-contracts.test.mjs tests/orchestration-write-contracts.test.mjs
```

**Commit:**

```text
feat: extend orchestration plan contracts for writers
```

---

## Task 2: Expand Configuration Without Changing Existing Defaults Unexpectedly

**Files:**
- Modify: `plugins/codex/scripts/orchestration/config.mjs`
- Modify: `plugins/codex/scripts/orchestration/schemas/config.schema.json`
- Modify: `tests/orchestration-config.test.mjs`
- Modify: `plugins/codex/commands/setup.md`

**Default configuration added in Phase 2:**

```json
{
  "git": {
    "writerMode": "isolated",
    "finalCommitMode": "squash",
    "autoApplyToCleanBranch": true,
    "preserveSuccessfulWorktrees": false
  },
  "safety": {
    "writeSandbox": "workspace-write",
    "allowDangerFullAccess": false,
    "allowWriterNetwork": false,
    "externalActions": "deny"
  },
  "verification": {
    "defaultCommandTimeoutMs": 900000,
    "maxCommandTimeoutMs": 3600000,
    "maxLogBytes": 1048576
  }
}
```

Rules:

- `writeSandbox` accepts `workspace-write` and `danger-full-access`.
- `danger-full-access` is invalid unless `allowDangerFullAccess` is true.
- Automatic orchestration may not enable writer network access.
- `externalActions` is fixed to `deny` in Phase 2.
- Unknown keys still fail validation.

- [ ] Add precedence tests for user and project write configuration.
- [ ] Add range and enum tests.
- [ ] Prove loading the old `{ auto, workers }` config returns all new defaults.
- [ ] Implement validation and atomic patching.
- [ ] Update setup documentation; do not add a broad "disable safety" flag.

**Focused verification:**

```bash
node --test tests/orchestration-config.test.mjs tests/commands.test.mjs
```

**Commit:**

```text
feat: add writer orchestration configuration
```

---

## Task 3: Capture a Clean Git Baseline and Detect Unsupported Repository States

**Files:**
- Create: `plugins/codex/scripts/orchestration/git-state.mjs`
- Create: `tests/orchestration-git-state.test.mjs`
- Modify: `plugins/codex/scripts/lib/git.mjs`

**Interfaces:**

```js
export function captureCleanGitBaseline(workspaceRoot) {}
export function compareGitBaseline(workspaceRoot, baseline) {}
export function detectInProgressGitOperation(workspaceRoot) {}
export function assertWriteOrchestrationStartable(workspaceRoot) {}
```

`captureCleanGitBaseline` records:

- canonical repository root;
- Git common directory;
- current branch or detached state;
- `HEAD` commit;
- index tree (`git write-tree` on an already clean index);
- `git status --porcelain=v2 --untracked-files=all` output;
- active merge/rebase/cherry-pick/revert/bisect operation;
- capture timestamp.

Start rules:

- write orchestration requires a Git repository;
- worktree/index must be clean;
- no in-progress Git operation;
- `HEAD` must resolve to a commit;
- detached `HEAD` may run isolated writers but is never auto-applied;
- non-Git write orchestration remains unsupported in Phase 2.

- [ ] Add failing tests for clean branch, dirty tracked file, staged file, untracked file, detached HEAD, unborn branch, merge state, rebase state, and concurrent HEAD movement.
- [ ] Implement all Git calls through argv arrays with `shell: false`.
- [ ] Return structured differences rather than one opaque Boolean.
- [ ] Preserve existing review helpers in `lib/git.mjs`.

**Focused verification:**

```bash
node --test tests/orchestration-git-state.test.mjs tests/git.test.mjs
```

**Commit:**

```text
feat: capture clean writer orchestration baselines
```

---

## Task 4: Enforce One Write Orchestration Per Repository

**Files:**
- Create: `plugins/codex/scripts/orchestration/workspace-write-lease.mjs`
- Create: `tests/orchestration-write-lease.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/controller-lifecycle.mjs`
- Modify: `plugins/codex/scripts/orchestration/state-store.mjs`

**Interfaces:**

```js
export async function acquireWorkspaceWriteLease(options) {}
export async function heartbeatWorkspaceWriteLease(lease, options) {}
export async function releaseWorkspaceWriteLease(lease, options) {}
export function readWorkspaceWriteLease(workspaceRoot, options) {}
```

The lease contains the repository canonical path, orchestration ID, controller instance ID, PID, start time, and heartbeat. Acquisition is protected by the existing generic file lock.

Phase 2 stale behavior is fail-closed:

- If the owner PID is alive, reject the second writer orchestration.
- If the owner PID is dead but an unfinished write orchestration or preserved worktree exists, reject automatic replacement and report the orphan.
- Only a dead lease with no unfinished writer state may be removed automatically.

- [ ] Add cross-process contention tests.
- [ ] Add stale-live, stale-dead-safe, and stale-dead-orphan tests.
- [ ] Add controller shutdown tests proving a completed/cancelled run releases the lease.
- [ ] Do not hold a filesystem lock for the entire orchestration; persist a lease and heartbeat instead.

**Focused verification:**

```bash
node --test tests/orchestration-write-lease.test.mjs tests/orchestration-state.test.mjs
```

**Commit:**

```text
feat: serialize workspace writer orchestrations
```

---

## Task 5: Implement Deterministic Ownership Validation

**Files:**
- Create: `plugins/codex/scripts/orchestration/ownership-policy.mjs`
- Create: `tests/orchestration-ownership.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/plan-contract.mjs`

**Interfaces:**

```js
export function normalizeOwnershipPattern(pattern) {}
export function matchesOwnershipPattern(relativePath, pattern) {}
export function validatePackageOwnership(packages) {}
export function auditChangedFiles(changedFiles, ownership) {}
```

Required behavior:

- Normalize path separators to `/` only for repository-relative comparison.
- Reject absolute paths, drive roots, UNC paths, `.git`, parent traversal, and unsupported glob syntax.
- Detect overlapping write ownership before execution.
- Allow explicit overlap only when both packages declare the same `sharedOwnershipGroup` and are transitively ordered; otherwise reject.
- `auditChangedFiles` returns allowed, disallowed, unmatched patterns, and a Boolean pass/fail.
- Changed submodule gitlinks, `.gitmodules`, and nested repository metadata are disallowed in Phase 2 unless an exact file ownership entry explicitly permits `.gitmodules`; `.git` is never permitted.

- [ ] Add path-separator tests on Windows-style inputs.
- [ ] Add exact, recursive, segment wildcard, and suffix wildcard matching tests.
- [ ] Add overlap tests across independent and ordered packages.
- [ ] Add audit tests for created, modified, renamed, and deleted files.
- [ ] Integrate ownership validation into plan normalization.

**Focused verification:**

```bash
node --test tests/orchestration-ownership.test.mjs tests/orchestration-write-contracts.test.mjs
```

**Commit:**

```text
feat: enforce writer package ownership
```

---

## Task 6: Add Redaction and Deterministic Verification Execution

**Files:**
- Create: `plugins/codex/scripts/orchestration/redaction.mjs`
- Create: `plugins/codex/scripts/orchestration/verification-runner.mjs`
- Create: `tests/orchestration-verification.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/state-store.mjs`
- Modify: `plugins/codex/scripts/lib/process.mjs`

**Interfaces:**

```js
export function redactSensitiveText(text, options = {}) {}
export async function runVerificationCommands(commands, options) {}
```

Verification requirements:

- Execute `argv[0]` with the remaining argv entries and `shell: false`.
- Use the package or integration worktree as `cwd`.
- Reject empty argv and embedded NUL bytes.
- Apply per-command and global maximum timeouts.
- Terminate the full process tree on timeout or cancellation.
- Capture exit code, signal, duration, stdout/stderr byte counts, truncated/redacted excerpts, and optional full local log path.
- Do not persist complete environment values.
- Redact common authorization headers, API-key/token patterns, and configured secret environment values.
- A required verification command passes only on exit code zero.

- [ ] Add success, nonzero exit, timeout, cancellation, large output, and redaction tests.
- [ ] Add a test proving shell metacharacters remain literal argv text.
- [ ] Add Windows process-tree coverage through injected platform/process helpers.
- [ ] Persist only redacted bounded excerpts in state; full logs stay in a local file with mode `0600` where supported.

**Focused verification:**

```bash
node --test tests/orchestration-verification.test.mjs tests/process.test.mjs
```

**Commit:**

```text
feat: run deterministic orchestration verification
```

---

## Task 7: Support App Server Approval Mediation

**Files:**
- Create: `plugins/codex/scripts/orchestration/approval-policy.mjs`
- Create: `tests/orchestration-approval.test.mjs`
- Modify: `plugins/codex/scripts/lib/app-server.mjs`
- Modify: `plugins/codex/scripts/lib/app-server-protocol.d.ts`
- Modify: `plugins/codex/scripts/lib/codex.mjs`
- Modify: `tests/fake-codex-fixture.mjs`
- Modify: `tests/runtime.test.mjs`

**App Server client change:**

Add a server-request handler whose default behavior remains the current JSON-RPC `-32601` rejection.

```js
client.setServerRequestHandler(async (request) => {
  return { result: decisionPayload };
});
```

The handler must respond exactly once and must handle rejected/throwing callbacks by returning a structured JSON-RPC error without crashing the process.

**Approval policy behavior:**

- Command approvals inspect `commandActions` when available, otherwise the command preview and cwd.
- File-change approvals are accepted only for the active package worktree root.
- Network approval context is declined by default.
- Permission requests grant only the requested filesystem subset inside the package worktree and no network permission.
- Unknown server requests are declined or rejected fail-closed.
- Commands with cwd outside the package worktree are declined.
- Deny remote/destructive command families including `git push`, remote branch deletion, `gh`, deployment CLIs, publication commands, credential mutation, and destructive filesystem operations outside the worktree.
- Local Git inspection, compilation, testing, and repository-local editing may be accepted when bounded to the worktree.
- Approval decisions and reasons are redacted and appended to orchestration events.

**Sandbox execution change:**

`runAppServerTurnWithClient` accepts explicit thread approval policy and turn-level sandbox policy while preserving `approvalPolicy: "never"` and read-only defaults for existing callers.

- [ ] Add fake server-request tests for command, file-change, network, permission, unknown, duplicate, and late-resolved requests.
- [ ] Add regression tests proving review/rescue behavior still rejects unsupported server requests by default.
- [ ] Add tests for workspace-write sandbox parameters and no automatic danger-full-access fallback.
- [ ] Type-check against freshly generated current App Server types.

**Focused verification:**

```bash
node --test tests/orchestration-approval.test.mjs tests/runtime.test.mjs
npm run build
```

**Commit:**

```text
feat: mediate writer app-server approvals
```

---

## Task 8: Create and Validate Isolated Package Worktrees

**Files:**
- Create: `plugins/codex/scripts/orchestration/worktree-manager.mjs`
- Create: `tests/orchestration-worktree.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/state-store.mjs`

**Interfaces:**

```js
export function buildPackageBranchName(orchestrationId, packageId) {}
export function buildIntegrationBranchName(orchestrationId) {}
export async function createPackageWorktree(options) {}
export async function createIntegrationWorktree(options) {}
export function inspectManagedWorktree(options) {}
export async function removeManagedWorktree(options) {}
```

Paths:

```text
${CLAUDE_PLUGIN_DATA}/orchestrations/<workspace-key>/<orch-id>/worktrees/packages/<package-key>
${CLAUDE_PLUGIN_DATA}/orchestrations/<workspace-key>/<orch-id>/worktrees/integration
```

Refs/branches:

```text
codex-orchestration/<orch-id>/package/<package-key>
codex-orchestration/<orch-id>/integration
refs/codex-orchestration/final/<orch-id>
```

Use sanitized short components plus stable hashes to stay within Windows path limits and avoid collisions.

Required behavior:

- Create branches from the exact baseline commit.
- Never reuse a non-empty path or a branch pointing at an unexpected commit.
- Verify the created worktree belongs to the original repository common directory.
- Reject symlinked managed roots that escape plugin data storage.
- Keep package and integration worktrees isolated from one another.
- Removal is best-effort only for successful applied runs; failed, blocked, or cancelled runs are preserved in Phase 2.
- Never run `git worktree prune` globally as an automatic cleanup shortcut.

- [ ] Add one- and two-worktree tests.
- [ ] Add existing-path, branch-collision, wrong-repository, symlink-escape, and long-path tests.
- [ ] Add Windows-compatible branch/path quoting tests.
- [ ] Verify the user's active branch, HEAD, index, and status are unchanged by isolated worktree creation.

**Focused verification:**

```bash
node --test tests/orchestration-worktree.test.mjs
```

**Commit:**

```text
feat: create isolated writer worktrees
```

---

## Task 9: Build Writer Prompts and Write-Aware Result Contracts

**Files:**
- Modify: `plugins/codex/scripts/orchestration/package-prompt.mjs`
- Modify: `plugins/codex/scripts/orchestration/result-contract.mjs`
- Modify: `plugins/codex/scripts/orchestration/schemas/package-result.schema.json`
- Create: `tests/orchestration-write-result.test.mjs`
- Modify: `tests/orchestration-contracts.test.mjs`

**Writer prompt requirements:**

- State the exact worktree root and package ID.
- Include objective, dependencies, ownership files/interfaces, acceptance criteria, risk tags, and expected outputs.
- Prohibit remote mutation, credentials, deployment, publication, work outside ownership, and edits outside the worktree.
- State that the controller owns final Git commit normalization.
- Tell the Root not to alter branches, remotes, worktrees, Git config, hooks, or repository metadata.
- Require a canonical JSON result with model-reported changed files, claims, evidence, verification observations, residual risks, and follow-up requests.
- Make clear that the controller independently audits changed files and reruns declared verification.

**Result normalization:**

- Read-only package results still require empty `changedFiles`.
- Write package model results may report changed files.
- Model-reported paths are normalized and compared later with controller-observed paths.
- Canonical controller result adds `packageCommit`, actual `changedFiles`, `ownershipAudit`, and `controllerVerification`.
- A mismatch between model-reported and actual changed files is a blocking audit failure, not silently corrected.

- [ ] Add read-only regression tests.
- [ ] Add valid write result tests.
- [ ] Add malformed paths, duplicate paths, missing evidence, wrong package ID, and claimed/actual mismatch tests.
- [ ] Keep raw model output available only for local diagnosis with redaction.

**Focused verification:**

```bash
node --test tests/orchestration-contracts.test.mjs tests/orchestration-write-result.test.mjs
```

**Commit:**

```text
feat: define writer prompts and results
```

---

## Task 10: Execute Write Packages in Their Assigned Workspaces

**Files:**
- Modify: `plugins/codex/scripts/orchestration/package-worker.mjs`
- Modify: `plugins/codex/scripts/orchestration/worker-pool.mjs`
- Modify: `tests/orchestration-runtime.test.mjs`
- Create: `tests/orchestration-write-runtime.test.mjs`
- Modify: `tests/fake-codex-fixture.mjs`

**Worker request shape:**

```js
{
  orchestrationId,
  sourceWorkspaceRoot,
  executionWorkspaceRoot,
  packageSpec,
  dependencyResults,
  access,
  sandboxPolicy,
  approvalContext,
  resultKind
}
```

Required behavior:

- Read-only packages continue using the source workspace and read-only sandbox.
- Write packages use the package worktree as `cwd` and execution workspace.
- Worker pool global accounting remains keyed to the source repository, not each generated worktree.
- Approval handler is installed before thread/turn start.
- Writer network access remains disabled.
- Progress and native-child accounting remain unchanged.
- The worker returns model result and App Server file/command observations; it does not create the canonical package commit.
- Worker process exit, timeout, and cancellation remain package-scoped.

Fake Codex behaviors must include:

- requesting command approval;
- requesting file-change approval;
- writing an owned file after acceptance;
- attempting a denied external command;
- attempting an out-of-worktree cwd;
- leaving uncommitted changes;
- creating multiple commits;
- returning a valid write result;
- interruption while files are modified.

- [ ] Add isolated writer success and denial tests.
- [ ] Add a regression test proving two read-only Roots still overlap on separate PIDs.
- [ ] Add two writer Roots modifying separate worktrees concurrently.
- [ ] Add no-network and out-of-root denial tests.
- [ ] Add Windows fake binary wrappers and path behavior.

**Focused verification:**

```bash
node --test tests/orchestration-write-runtime.test.mjs tests/orchestration-runtime.test.mjs
npm run build
```

**Commit:**

```text
feat: execute write packages in isolated worktrees
```

---

## Task 11: Normalize Every Writer to One Audited Package Commit

**Files:**
- Create: `plugins/codex/scripts/orchestration/package-commit.mjs`
- Create: `tests/orchestration-package-commit.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/state-store.mjs`

**Interfaces:**

```js
export async function normalizePackageCommit(options) {}
export function inspectPackageCommit(options) {}
```

Normalization algorithm for isolated worktrees:

1. Verify package branch and worktree identity.
2. Verify the branch descends from exactly the package base commit.
3. Reject merge commits, submodule metadata changes, branch changes, and commits that include unrelated history.
4. Collect all committed and uncommitted final-tree changes relative to the package base.
5. Reject an empty change set when the package claims implementation completion, unless `allowEmpty` is explicitly true.
6. Audit every changed path against ownership.
7. Compare model-reported changed files with actual changed files.
8. Run package verification commands in the final tree.
9. Reset only the isolated package branch to the base while preserving the final tree.
10. Create exactly one commit using the user's effective Git identity.
11. Include trailers:

```text
Codex-Orchestration-Id: <orchestration-id>
Codex-Package-Id: <package-id>
```

12. Reinspect the created commit and persist canonical metadata.

Do not rewrite the user's active branch or index.

Required result:

```js
{
  commit,
  baseCommit,
  changedFiles,
  ownershipAudit,
  verification,
  originalCommitCount,
  normalized: true
}
```

- [ ] Test uncommitted changes, one commit, multiple commits, merge commit rejection, wrong base, empty package, owned rename/delete, out-of-scope change, claimed-file mismatch, failed verification, and trailers.
- [ ] Test Git identity absence with an actionable blocked result; do not invent a fake user identity.
- [ ] Prove normalization changes only the package branch/worktree.

**Focused verification:**

```bash
node --test tests/orchestration-package-commit.test.mjs
```

**Commit:**

```text
feat: normalize writer package commits
```

---

## Task 12: Persist Phase 2 State and Migrate Phase 1 Reads

**Files:**
- Modify: `plugins/codex/scripts/orchestration/constants.mjs`
- Modify: `plugins/codex/scripts/orchestration/state-store.mjs`
- Modify: `plugins/codex/scripts/orchestration/result-contract.mjs`
- Modify: `plugins/codex/scripts/orchestration/schemas/orchestration-result.schema.json`
- Modify: `tests/orchestration-state.test.mjs`

Required behavior:

- New records use state version 2.
- Version-1 records load with `write.enabled: false` and `integration.status: "not-required"` in memory.
- Write baseline, lease identity, package workspace, commit, ownership audit, verification, integration, reviewer, final commit, application, and decision point are durable.
- State updates remain atomic and workspace scoped.
- Events remain append-only and redacted.
- Status/result reference resolution remains compatible.
- Canonical orchestration result includes preserved artifact paths only when local disclosure is safe and useful.

- [ ] Add v1 load tests using fixture JSON.
- [ ] Add v2 round-trip tests.
- [ ] Add concurrent package/integration update tests.
- [ ] Add result rendering tests for applied, preserved, blocked conflict, reviewer reject, and failed verification.
- [ ] Do not auto-rewrite v1 state during read.

**Focused verification:**

```bash
node --test tests/orchestration-state.test.mjs tests/render.test.mjs
```

**Commit:**

```text
feat: persist writer orchestration state
```

---

## Task 13: Integrate Package Commits Deterministically

**Files:**
- Create: `plugins/codex/scripts/orchestration/integration-manager.mjs`
- Create: `tests/orchestration-integration.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/scheduler.mjs`

**Interfaces:**

```js
export async function prepareIntegration(options) {}
export async function integratePackageCommits(options) {}
export function buildIntegrationOrder(plan, packageStates) {}
export function buildConflictDecisionPoint(options) {}
```

Integration rules:

- Start the integration branch/worktree from the exact baseline commit.
- Include only `completed` or accepted `partial` writer packages whose dependencies are usable.
- Exclude failed, blocked, or cancelled optional packages and record omissions.
- Refuse to integrate when a required writer is absent.
- Use stable topological order; ties follow plan order and then package ID.
- Cherry-pick normalized package commits one by one.
- After each cherry-pick, record package ID, source commit, integration commit, and resulting tree.
- Automatically accept only conflict-free Git operations.
- On conflict, abort the active cherry-pick while preserving conflict diagnostics and set a structured decision point containing package IDs, files, stages, ownership, and available evidence.
- Do not attempt a strategy-option merge or semantic resolution.

Phase 2 decision behavior:

- A conflict makes the orchestration `blocked`.
- Package branches and the integration worktree are preserved.
- Result output explains that Phase 3 will add repair/resume behavior.

- [ ] Add independent-order tests.
- [ ] Add dependency-order tests.
- [ ] Add optional omission and required failure tests.
- [ ] Add clean overlapping textual edits that Git can merge.
- [ ] Add true conflict tests and verify no user-branch mutation.
- [ ] Add deterministic rerun tests proving the same inputs create the same integrated tree.

**Focused verification:**

```bash
node --test tests/orchestration-integration.test.mjs tests/orchestration-scheduler.test.mjs
```

**Commit:**

```text
feat: integrate package commits deterministically
```

---

## Task 14: Add Risk-Triggered Integration Review

**Files:**
- Create: `plugins/codex/scripts/orchestration/reviewer-policy.mjs`
- Create: `plugins/codex/scripts/orchestration/schemas/reviewer-result.schema.json`
- Create: `tests/orchestration-reviewer.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/package-prompt.mjs`
- Modify: `plugins/codex/scripts/orchestration/package-worker.mjs`
- Modify: `plugins/codex/scripts/orchestration/worker-pool.mjs`

**Interfaces:**

```js
export function evaluateReviewerRequirement(context) {}
export function validateReviewerResult(input) {}
```

Automatic review triggers:

- two or more integrated writer packages;
- any built-in high-risk tag;
- any declared interface ownership;
- model-reported confidence below configured threshold;
- a writer required transient retry or model escalation;
- package evidence is incomplete;
- integration changed a public schema/protocol path declared by the plan;
- Claude set reviewer mode `required`.

Reviewer modes:

- `disabled`: valid only when no mandatory trigger exists; explicit orchestration only.
- `auto`: run when a trigger exists.
- `required`: always run.

Reviewer execution:

- Read-only sandbox in the integration worktree.
- Review the complete `base..integration` diff, package results, ownership, and controller verification.
- No file changes, command mutation, or external action.
- Canonical result:

```json
{
  "verdict": "approve",
  "summary": "...",
  "blockingFindings": [],
  "nonBlockingFindings": [],
  "evidence": [],
  "recommendedResolution": []
}
```

Behavior:

- `approve` permits final verification/commit.
- `revise` or `reject` blocks automatic integration in Phase 2 and records a decision point.
- Malformed output fails closed.
- Claude may report the preserved integration result but may not silently reinterpret a blocking verdict as approval.

- [ ] Add trigger matrix tests.
- [ ] Add reviewer-disabled invalid-plan tests.
- [ ] Add approve/revise/reject/malformed output tests.
- [ ] Add read-only boundary tests proving reviewer edits fail.
- [ ] Add model/effort routing tests preserving `Sol > Terra > Luna` tier semantics.

**Focused verification:**

```bash
node --test tests/orchestration-reviewer.test.mjs tests/model-policy.test.mjs
```

**Commit:**

```text
feat: gate integration with independent review
```

---

## Task 15: Run Full Verification and Create One Final Commit

**Files:**
- Modify: `plugins/codex/scripts/orchestration/integration-manager.mjs`
- Modify: `tests/orchestration-integration.test.mjs`
- Modify: `plugins/codex/scripts/orchestration/result-contract.mjs`

Finalization sequence:

1. Ensure package integration is complete and conflict-free.
2. Run top-level integration verification commands.
3. Run Reviewer when required.
4. Read the final integration tree.
5. Create one final commit whose sole parent is the original baseline commit.
6. Use the plan's final subject and a generated body summarizing included package IDs.
7. Include trailers:

```text
Codex-Orchestration-Id: <orchestration-id>
Codex-Packages: <comma-separated package ids>
```

8. Store the commit at `refs/codex-orchestration/final/<orchestration-id>`.
9. Reinspect parent, tree, message, and changed files.

Do not create the final commit when:

- required package integration is incomplete;
- required verification failed;
- Reviewer did not approve;
- ownership audit failed;
- conflict/decision point exists.

- [ ] Add full-verification pass/fail/timeout tests.
- [ ] Add final commit parent/tree/trailer tests.
- [ ] Prove package integration commits are not parents of the final squash commit.
- [ ] Prove final commit creation does not move the user branch.
- [ ] Add deterministic content tests excluding timestamps from commit-message semantics; commit SHA may vary with commit time, but tree and parent must be stable.

**Focused verification:**

```bash
node --test tests/orchestration-integration.test.mjs tests/orchestration-verification.test.mjs
```

**Commit:**

```text
feat: create verified orchestration squash commits
```

---

## Task 16: Apply the Final Commit Only to an Unchanged Clean User Branch

**Files:**
- Modify: `plugins/codex/scripts/orchestration/integration-manager.mjs`
- Modify: `plugins/codex/scripts/orchestration/git-state.mjs`
- Modify: `tests/orchestration-integration.test.mjs`

Eligibility predicate:

- Plan requests `autoApply` and config permits it.
- Baseline was on a named branch.
- Current branch equals baseline branch.
- Current `HEAD` equals baseline `HEAD`.
- Current index tree equals baseline index tree.
- Current porcelain-v2 status is empty.
- No Git operation is in progress.
- Final commit parent equals baseline `HEAD`.
- Final diff stays inside the union of accepted writer ownership.
- All required packages, verification, and review gates passed.

Application:

- Acquire/revalidate the workspace write lease.
- Run a fast-forward-only update from the user's active worktree.
- Verify resulting `HEAD` equals the final commit and status is clean.
- On any precondition failure, perform no branch/index/worktree mutation and mark application `preserved` with the exact reason.
- On unexpected Git failure, preserve the final ref and mark integration `blocked`; do not retry with reset or force.

- [ ] Add successful fast-forward test.
- [ ] Add tests for branch switch, HEAD movement, staged change, unstaged change, untracked file, detached HEAD, Git operation, ownership mismatch, and config-disabled auto-apply.
- [ ] Add a race test that changes `HEAD` after eligibility check but before ref update; use Git's expected-old-value semantics or an equivalent atomic guard.
- [ ] Prove no unsafe case mutates the user's branch or index.

**Focused verification:**

```bash
node --test --test-name-pattern="auto-apply|preserves final commit|HEAD movement" tests/orchestration-integration.test.mjs
```

**Commit:**

```text
feat: safely apply final orchestration commits
```

---

## Task 17: Add the Strict Direct Single-Writer Optimization

**Files:**
- Modify: `plugins/codex/scripts/orchestration/worktree-manager.mjs`
- Modify: `plugins/codex/scripts/orchestration/package-commit.mjs`
- Modify: `plugins/codex/scripts/orchestration/controller.mjs`
- Modify: `tests/orchestration-package-commit.test.mjs`
- Modify: `tests/orchestration-write-runtime.test.mjs`

Direct mode is eligible only when:

- exactly one write package exists;
- no other package runs concurrently with the writer;
- baseline branch is named and clean;
- Reviewer is not mandatory;
- the plan explicitly requests `workspace.mode: "direct"` or config chooses direct mode;
- package ownership excludes `.gitmodules` and repository metadata;
- approval policy denies Git index/branch/commit operations initiated by the model;
- automatic final application is enabled.

Direct-mode algorithm:

1. Revalidate baseline immediately before starting the writer.
2. Run the writer in the user's worktree with workspace-write sandboxing.
3. Do not permit model-initiated `git add`, `git commit`, `git reset`, branch, worktree, or remote operations.
4. Audit the resulting working-tree changes.
5. Build the package/final tree through a temporary index based on baseline `HEAD`; do not use the user's index for staging.
6. Run package and integration verification against the visible user worktree.
7. Create the final commit with `git commit-tree` without moving `HEAD`.
8. Revalidate that user-visible file content exactly matches the final tree, the branch and `HEAD` remain baseline values, and the user index remains unchanged.
9. Atomically update the branch ref from baseline to final commit and update the index to the final tree.
10. Verify clean status.

Failure behavior:

- Never reset or discard visible writer changes.
- If verification, audit, or finalization fails, leave the user worktree dirty and report exact files and preserved commit/ref state.
- Cancellation leaves partial visible changes and marks the result accordingly.

- [ ] Add direct success test.
- [ ] Add model-staging denial test.
- [ ] Add concurrent user edit and HEAD movement tests.
- [ ] Add verification failure and cancellation tests proving changes are preserved, not reset.
- [ ] Add temporary-index tests proving the original index fingerprint is unchanged until final successful application.
- [ ] Keep isolated mode as default after direct mode exists.

**Focused verification:**

```bash
node --test --test-name-pattern="direct writer" tests/orchestration-package-commit.test.mjs tests/orchestration-write-runtime.test.mjs
```

**Commit:**

```text
feat: add gated direct single-writer mode
```

---

## Task 18: Integrate Write Phases into the Controller State Machine

**Files:**
- Modify: `plugins/codex/scripts/orchestration/controller.mjs`
- Modify: `plugins/codex/scripts/orchestration/controller-server.mjs`
- Modify: `plugins/codex/scripts/orchestration/controller-client.mjs`
- Create or modify: `tests/orchestration-controller.test.mjs`
- Modify: `tests/orchestration-runtime.test.mjs`
- Modify: `tests/orchestration-write-runtime.test.mjs`

Controller sequence for a write plan:

1. Normalize plan.
2. Capture clean Git baseline.
3. Acquire workspace write lease.
4. Persist write state before creating worktrees.
5. Prepare package workspaces.
6. Run Phase 1 scheduler for packages.
7. Normalize each successful writer package commit before marking it integration-usable.
8. Propagate package dependency failures.
9. When package execution is terminal, enter `integrating` rather than finalizing.
10. Prepare integration worktree and integrate commits.
11. Run integration verification.
12. Run Reviewer when required.
13. Create final commit.
14. Apply or preserve.
15. Persist aggregate result and release lease.

Read-only plans follow the existing Phase 1 path with no Git baseline, write lease, worktrees, or integration state.

Cancellation:

- Stop scheduling.
- Interrupt active Roots.
- Preserve writer worktrees and branches unless final application already completed.
- Direct mode leaves visible changes.
- Never auto-apply after cancellation.
- Release the write lease only after durable terminal state is written.

Controller-loss behavior in Phase 2:

- On startup, unfinished write orchestration state is not automatically resumed.
- Mark it `blocked` with reason `WRITE_RECOVERY_REQUIRES_PHASE_3` if the owning controller is gone.
- Preserve all refs/worktrees and report them.
- Read-only Phase 1 loss behavior remains unchanged.

- [ ] Add one-writer isolated end-to-end test.
- [ ] Add two-writer parallel execution and deterministic integration test.
- [ ] Add optional writer failure/omission test.
- [ ] Add required writer failure test.
- [ ] Add reviewer reject, verification failure, conflict, user-HEAD movement, and cancellation tests.
- [ ] Add controller-loss preservation test.
- [ ] Add read-only regression test proving no Git commands/worktrees are introduced.

**Focused verification:**

```bash
node --test tests/orchestration-controller.test.mjs tests/orchestration-write-runtime.test.mjs tests/orchestration-runtime.test.mjs
```

**Commit:**

```text
feat: orchestrate writer integration lifecycle
```

---

## Task 19: Update CLI, Rendering, Commands, and Skills

**Files:**
- Modify: `plugins/codex/scripts/orchestration/cli.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/lib/render.mjs`
- Modify: `plugins/codex/commands/orchestrate.md`
- Modify: `plugins/codex/commands/status.md`
- Modify: `plugins/codex/commands/result.md`
- Modify: `plugins/codex/commands/cancel.md`
- Modify: `plugins/codex/skills/codex-orchestration/SKILL.md`
- Modify: `plugins/codex/skills/codex-work-package-contract/SKILL.md`
- Modify: `plugins/codex/skills/codex-integration-policy/SKILL.md`
- Modify: `plugins/codex/skills/codex-orchestration-recovery/SKILL.md`
- Modify: `tests/commands.test.mjs`
- Modify: `tests/render.test.mjs`
- Modify: `tests/orchestration-skill.test.mjs`

Status output must expose:

- read-only versus write orchestration;
- baseline branch/HEAD;
- package worktree mode and path summary;
- package commit and ownership/verification status;
- integration status and included/omitted packages;
- conflict or other decision point;
- Reviewer requirement and verdict;
- final commit;
- application eligibility/result;
- preserved artifacts and Phase 3 recovery limitation.

Result output must clearly distinguish:

- **applied:** final commit is on the user's branch;
- **preserved:** final commit is ready but user branch was not changed;
- **blocked:** conflict, reviewer, audit, or verification prevented finalization;
- **degraded:** objective completed with permitted omissions;
- **failed/cancelled:** no automatic integration occurred.

Skill requirements:

- Automatic write orchestration is allowed only when orchestration auto-entry is enabled and the user tree is clean.
- Claude must declare ownership, risk tags, package verification, integration verification, Reviewer policy, and final commit subject.
- Claude must collapse writers that require each other's unintegrated code.
- Claude must not promise Phase 3 recovery.
- Claude must report blocking Reviewer findings and preserved artifacts.
- External actions always require a separate explicit user authorization and are not executed by Phase 2.

Do not add a large user-facing command vocabulary. A local final commit that was preserved may be applied later only after an explicit user request and a fresh safety check; the internal CLI may expose `apply <orchestration-id> --json`, but no automatic retry is performed by status/result.

- [ ] Add command surface tests.
- [ ] Add compressed plan examples for one and multiple writers.
- [ ] Add render snapshots for applied, preserved, blocked, degraded, and cancelled write runs.
- [ ] Remove the Phase 1 text that says all orchestration is strictly read-only.
- [ ] Preserve the Phase 1 read-only safety explanation as a supported mode.

**Focused verification:**

```bash
node --test tests/commands.test.mjs tests/render.test.mjs tests/orchestration-skill.test.mjs
```

**Commit:**

```text
docs: expose clean-tree writer orchestration
```

---

## Task 20: Cross-Platform Hardening and Release Verification

**Files:**
- Modify: `.github/workflows/pull-request-ci.yml`
- Modify: `package.json` only if adding a dedicated smoke script is necessary
- Modify: `tsconfig.app-server.json`
- Modify: `README.md`
- Add or modify tests from prior tasks

### CI matrix

The existing Ubuntu, macOS, and Windows matrix remains mandatory. Add focused worktree/integration coverage to the normal `npm test` suite; do not hide it behind a platform-specific optional script.

### Cross-platform requirements

- Git paths are argv entries, never shell-concatenated strings.
- Repository-relative ownership paths use `/`; OS paths use `path` APIs.
- Named pipes and Unix sockets remain unchanged.
- Worktree paths stay below conservative Windows path-length budgets.
- Process-tree timeout/cancellation works on Windows.
- Symlink tests skip only when the runner cannot create symlinks and must report the skip.
- File mode assertions are conditional on filesystem capability.
- Atomic state writes and final application are verified on all platforms.

### Real Codex smoke suite

Provide a documented manual or authenticated CI smoke path for:

1. one isolated writer;
2. two parallel isolated writers;
3. denied external command;
4. integration verification;
5. Reviewer approve;
6. Reviewer reject;
7. final commit preserved after user `HEAD` movement;
8. successful clean-branch fast-forward;
9. direct single-writer mode;
10. cancellation with preserved changes.

The smoke suite must run in a disposable repository. It must never target the plugin's own active development checkout.

### Final merge gate

Run from a clean checkout:

```bash
npm ci
npm run check-version
npm test
npm run build
git diff --check
```

Then verify:

```bash
# Phase 1 read-only regression
node --test tests/orchestration-runtime.test.mjs

# Phase 2 write path
node --test tests/orchestration-write-runtime.test.mjs \
  tests/orchestration-worktree.test.mjs \
  tests/orchestration-package-commit.test.mjs \
  tests/orchestration-integration.test.mjs \
  tests/orchestration-approval.test.mjs
```

Required release evidence:

- all tests pass on Ubuntu, macOS, and Windows;
- two writer Roots overlap in time while modifying different worktrees;
- no package contaminates another package's tree/result;
- external command approval is denied and audited;
- final commit is a single child of baseline;
- unsafe auto-apply conditions leave the user branch unchanged;
- existing review/rescue/transfer/broker flows remain green;
- no dirty-tree snapshot ref or automatic write recovery has leaked into Phase 2.

**Commit:**

```text
test: verify clean-tree writer orchestration
```

---

## 6. Required Error Codes

Use stable machine-readable codes in state/events/results where applicable:

| Code | Meaning |
|---|---|
| `WRITE_REQUIRES_GIT` | Writer plan started outside a Git repository. |
| `WRITE_REQUIRES_CLEAN_TREE` | User branch/index/worktree is dirty. |
| `GIT_OPERATION_IN_PROGRESS` | Merge/rebase/cherry-pick/revert/bisect is active. |
| `WRITE_LEASE_CONFLICT` | Another write orchestration owns the repository. |
| `WRITE_ORPHAN_REQUIRES_RECOVERY` | Dead owner left unfinished write artifacts. |
| `INVALID_OWNERSHIP_PATTERN` | Ownership path grammar is unsafe or unsupported. |
| `OWNERSHIP_OVERLAP` | Writer packages overlap without valid ordering/group. |
| `OWNERSHIP_VIOLATION` | Actual changes exceed declared ownership. |
| `MODEL_CHANGED_FILES_MISMATCH` | Model-reported and actual changed-file sets differ. |
| `APPROVAL_DENIED` | Requested command/file/permission action was denied. |
| `EXTERNAL_ACTION_DENIED` | Remote or consequential action was attempted. |
| `WRITER_SANDBOX_UNAVAILABLE` | Required workspace-write policy cannot be established. |
| `PACKAGE_VERIFICATION_FAILED` | Controller-run package verification failed. |
| `PACKAGE_COMMIT_NORMALIZATION_FAILED` | Final package tree could not be normalized safely. |
| `INTEGRATION_CONFLICT` | Cherry-pick produced a semantic conflict. |
| `INTEGRATION_VERIFICATION_FAILED` | Full integration verification failed. |
| `REVIEWER_REVISE` | Reviewer requires changes. |
| `REVIEWER_REJECT` | Reviewer rejected integration. |
| `FINAL_COMMIT_INVALID` | Final parent/tree/message audit failed. |
| `AUTO_APPLY_PRECONDITION_FAILED` | User branch was not safely applicable. |
| `AUTO_APPLY_RACE` | Baseline changed during application. |
| `WRITE_RECOVERY_REQUIRES_PHASE_3` | Interrupted write orchestration cannot auto-resume. |

---

## 7. Security Invariants

The implementation is not complete unless all invariants are enforced by code and tests.

1. A write Root can write only in its assigned execution worktree under the selected sandbox policy.
2. The controller never auto-approves network access in Phase 2.
3. The controller never authorizes external mutation commands.
4. Git orchestration commands use `shell: false` and fixed argv construction.
5. Verification commands are plan-declared argv arrays and never shell-evaluated.
6. Actual changed files are derived from Git, not trusted from the model.
7. Every changed file must match declared ownership.
8. Package commits are controller-normalized and independently reinspected.
9. The integration manager never resolves semantic conflicts automatically.
10. The final commit's parent must equal the captured baseline commit.
11. Automatic application is fast-forward only and guarded by expected-old-value checks.
12. Failure or cancellation never resets the user's visible work to hide partial changes.
13. Read-only orchestration remains read-only and never acquires a write lease or creates a worktree.
14. Server-request handling defaults to rejection for callers that do not explicitly install an approval policy.
15. Durable logs are redacted and bounded.
16. Controller loss preserves write artifacts and fails closed until Phase 3 recovery exists.

---

## 8. Phase 2 Acceptance Criteria

Phase 2 is complete only when all of the following are demonstrated with fresh evidence:

1. Existing Phase 1 read-only orchestration passes unchanged.
2. A write plan cannot start from a dirty tree or active Git operation.
3. Two writer packages execute concurrently in different worktrees from the same base commit.
4. A writer cannot modify another package's worktree or files outside ownership.
5. Model-initiated external commands are denied and recorded.
6. Uncommitted, single-commit, and multi-commit writer output normalize to one package commit.
7. Package verification is controller-run and blocks invalid commits.
8. Required package commits integrate in deterministic topological order.
9. Optional failed packages may be omitted only when dependency/objective rules permit it.
10. Semantic Git conflicts produce a structured blocking decision point with no invented resolution.
11. Mandatory risk triggers run a Sol Reviewer according to the plan.
12. Reviewer `revise` or `reject` prevents final automatic application.
13. Full integration verification must pass before final commit creation.
14. The final commit is one child of the original baseline and contains the integration tree.
15. An unchanged clean user branch fast-forwards to the final commit.
16. Branch switch, HEAD movement, or any dirty state preserves the final commit without touching the user branch.
17. Direct single-writer mode never uses the user's index as a temporary staging area and never discards failed changes.
18. Cancellation preserves package/direct changes and never auto-applies.
19. A lost controller does not auto-resume write work in Phase 2.
20. The complete suite and type-check build pass on Ubuntu, macOS, and Windows.
21. A disposable authenticated smoke test proves real App Server approval, writer, integration, Reviewer, and application behavior.

---

## 9. Recommended Implementation Sequence

Execute commits in this exact dependency order:

1. `feat: extend orchestration plan contracts for writers`
2. `feat: add writer orchestration configuration`
3. `feat: capture clean writer orchestration baselines`
4. `feat: serialize workspace writer orchestrations`
5. `feat: enforce writer package ownership`
6. `feat: run deterministic orchestration verification`
7. `feat: mediate writer app-server approvals`
8. `feat: create isolated writer worktrees`
9. `feat: define writer prompts and results`
10. `feat: execute write packages in isolated worktrees`
11. `feat: normalize writer package commits`
12. `feat: persist writer orchestration state`
13. `feat: integrate package commits deterministically`
14. `feat: gate integration with independent review`
15. `feat: create verified orchestration squash commits`
16. `feat: safely apply final orchestration commits`
17. `feat: add gated direct single-writer mode`
18. `feat: orchestrate writer integration lifecycle`
19. `docs: expose clean-tree writer orchestration`
20. `test: verify clean-tree writer orchestration`

Do not squash these during development. Preserve focused commits until the final reviewed pull request; the repository owner may squash on merge.
