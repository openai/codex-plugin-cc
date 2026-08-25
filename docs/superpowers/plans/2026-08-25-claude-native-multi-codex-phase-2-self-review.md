# Phase 2 Implementation Plan — Self-Review Amendments

- **Status:** Normative amendment
- **Applies to:** `2026-08-25-claude-native-multi-codex-phase-2.md`
- **Date:** 2026-08-25
- **Review outcome:** Implementation-ready after applying the amendments below

Implementers must read the base Phase 2 plan first and then this document. Where the two documents differ, **this amendment takes precedence**.

The review compared the Phase 2 plan against:

- the approved orchestration design;
- the merged Phase 1 runtime and its persistence contracts;
- the current Codex App Server request, sandbox, and approval surfaces;
- Git worktree, ref, index, hook, filter, and race behavior;
- macOS, Linux, and Windows execution constraints.

No unresolved product decision blocks implementation. The review did find several execution-order and safety gaps that must be corrected before coding.

---

## 1. Correct the write-start ordering

The base plan's controller sequence captures the baseline and then acquires the write lease. That is sufficient to reject a competing controller eventually, but it leaves an avoidable interval in which the first baseline can become stale.

Use this exact sequence:

1. Run a non-mutating preflight and confirm that the repository appears startable.
2. Acquire the workspace write lease.
3. Capture the authoritative clean baseline while holding lease ownership.
4. Immediately compare the current repository state with the captured baseline.
5. Persist the lease and baseline in orchestration state.
6. Create package worktrees.

If steps 3–5 fail, release the lease and create no worktree or orchestration Git ref.

Task 3 still owns baseline capture. Task 4 owns the lease. Task 18 must compose them in the order above.

---

## 2. Prohibit stale post-writer package execution

Phase 2 isolated package worktrees all start from the same clean baseline. A normal DAG package therefore cannot safely assume that it sees another writer's unintegrated code.

Add these plan-validation rules:

- A `read-only` package may not depend directly or transitively on a `write` package in Phase 2.
- A `write` package may depend on another writer only for evidence, ordering, or interface decisions that do not require the upstream package's concrete tree.
- When a writer needs upstream implementation output as its compilation or editing base, Claude must collapse the work into one writer package.
- Post-write testing belongs in controller-run package verification, integration verification, or the integration Reviewer—not in a normal package that reads the source workspace.

Do not add an `integration-worktree` DAG package mode in Phase 2. Scheduled post-integration packages and dependency-tip worktrees belong to Phase 3 dynamic replanning.

Task 1, Task 9, Task 18, and the orchestration skill must enforce and explain this boundary.

---

## 3. Add explicit workspace-preparation commands

A fresh Git worktree commonly lacks ignored dependencies, generated code, virtual environments, build caches, and other machine-local prerequisites. Verification commands alone do not solve this.

Extend write packages and top-level integration policy with optional preparation commands using the same argv-array contract as verification:

```json
{
  "preparationCommands": [
    {
      "argv": ["npm", "ci", "--ignore-scripts", "--offline"],
      "timeoutMs": 1200000
    }
  ]
}
```

Rules:

- Preparation commands execute after worktree creation and before the Codex Root starts.
- Integration preparation commands execute after integration-worktree creation and before package cherry-picks only when the command is tree-independent; otherwise run them after integration and before verification.
- Commands use `shell: false` and the same command-safety classifier as verification.
- Automatic orchestration does not grant network access to preparation commands.
- Failure is `WORKSPACE_PREPARATION_FAILED` and blocks that package before model execution.
- Preparation output is redacted and bounded identically to verification output.
- A plan may omit preparation commands when the checkout is already self-contained.

Update Tasks 1, 6, 8, 10, 13, 18, and 20 accordingly.

---

## 4. Harden controller-owned Git operations

Repository Git configuration can invoke hooks, filters, editors, credential prompts, fsmonitor processes, or LFS smudge behavior. Controller-owned Git must not inherit those effects silently.

Every orchestration Git command must use a hardened environment and explicit configuration equivalent to:

```text
GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=<non-interactive failure helper>
GIT_EDITOR=:
GIT_SEQUENCE_EDITOR=:
GIT_MERGE_AUTOEDIT=no
GIT_OPTIONAL_LOCKS=0 for read-only probes only
-c core.hooksPath=<controller-owned empty directory>
-c core.fsmonitor=false
-c credential.helper=
```

Additional rules:

- Do not set `GIT_OPTIONAL_LOCKS=0` for mutations that require normal locking.
- Worktree creation, cherry-pick, and any checkout-like operation must disable repository hooks.
- The controller must not allow Git to prompt for credentials.
- Default worktree creation sets `GIT_LFS_SKIP_SMUDGE=1` to prevent implicit network access.
- If tracked LFS content is required for implementation or verification, fail with `LFS_CONTENT_UNAVAILABLE` and preserve an actionable diagnostic. Network-backed LFS hydration is not automatic in Phase 2.
- Do not initialize or update submodules automatically.
- Reject a write plan that requires changing a submodule gitlink or nested repository metadata.
- Record the effective hardening policy in local diagnostic state without persisting secrets.

Apply this to Tasks 3, 8, 11, 13, 15, 16, 17, and 20.

---

## 5. Keep managed worktrees outside the source repository

`${CLAUDE_PLUGIN_DATA}` is user-configurable. It may point inside the repository, inside `.git`, or through a symlink back into the repository. That would contaminate status, ownership, and recursion behavior.

Before creating managed paths, verify that the canonical orchestration data root and every package/integration worktree path are outside:

- the source worktree;
- the repository Git common directory;
- every currently registered linked worktree.

If the configured plugin-data root is unsafe, do not silently relocate durable state. Fail with `UNSAFE_PLUGIN_DATA_LOCATION` and tell the user which canonical paths conflict.

Task 8 must test direct containment, symlink containment, case-insensitive Windows path comparison, and linked-worktree containment.

---

## 6. Use plumbing for package commit normalization

Package normalization must not use `git commit`, `git reset --hard`, or the user's normal index. Those commands can invoke hooks, interact with signing configuration, or alter checked-out content unnecessarily.

Use this mechanical sequence in the isolated package worktree:

1. Audit the final tree and changed paths relative to the package base.
2. Create a temporary index outside the worktree.
3. Populate it from the package base with `git read-tree`.
4. Stage the package worktree into the temporary index with `GIT_INDEX_FILE`.
5. Write the tree using `git write-tree`.
6. Create the normalized commit using `git commit-tree <tree> -p <base>` with the required message and trailers.
7. Atomically move the package branch with `git update-ref <branch-ref> <new-commit> <expected-old-tip>`.
8. Update only the package worktree/index to the normalized commit and verify a clean package worktree.

The original model-created commits remain recoverable through local diagnostics until the package is accepted, but they are not integration inputs.

Task 11 must test hook suppression, commit-signing configuration, expected-old-tip races, and temporary-index cleanup.

---

## 7. Verification and preparation commands require policy checks

Argv arrays prevent shell injection but do not make an arbitrary executable safe. A plan could still request a deployment CLI, destructive script, remote mutation, or credential-bearing command.

Before executing a preparation or verification command:

1. Run the same deterministic command classifier used for App Server command approval.
2. Reject known remote, publication, deployment, credential, destructive, or repository-metadata mutation commands.
3. Reject a cwd outside the assigned worktree.
4. Reject Git branch/ref/index/worktree mutations unless the operation is an internal fixed controller command rather than a plan command.
5. Remove known secret values from the persisted command representation.

Execution environment rules:

- Start from a minimal allowlisted environment plus `PATH`, platform essentials, and explicitly configured variable names.
- Never persist environment values.
- Strip common cloud, package-registry, VCS, and authorization secrets unless an explicit future user-authorized mechanism supplies them.
- Set non-interactive/CI flags where safe.
- Network is not guaranteed to be OS-confined for arbitrary local processes; therefore command classification, secret stripping, no automatic credentials, and explicit documentation are required defense in depth.

Add `UNSAFE_PLAN_COMMAND` and `WORKSPACE_PREPARATION_FAILED` to the required error-code table.

Tasks 2, 6, 7, 18, and 20 must cover this behavior.

---

## 8. Preserve default App Server request rejection

The current App Server client rejects unsupported server-initiated requests. Phase 2 must add mediation without weakening existing callers.

Required client contract:

- `setServerRequestHandler` is opt-in per client.
- A client with no handler retains the existing JSON-RPC `-32601` response.
- The writer worker installs its handler before any thread or turn request.
- Every request receives exactly one response.
- Handler timeout, throw, malformed decision, or worker cancellation returns a fail-closed error/decline.
- Closing a client drains or rejects outstanding server requests deterministically.
- Generated current App Server types are authoritative; do not hand-maintain a permanent request-shape matrix when generated types expose it.

Task 7 must begin by regenerating types and inspecting the exact command, file-change, network, and permission request/decision unions supported by the installed Codex CLI.

---

## 9. Clarify sandbox mapping and unrestricted fallback

The plan-level string `workspace-write` is plugin configuration, not the wire representation. Convert it at one narrow adapter boundary to the current App Server sandbox-policy object with:

- package worktree as the primary writable root;
- network disabled;
- no source-worktree writable root;
- no Git common-directory writable root;
- no sibling package or integration worktree writable root.

`danger-full-access` rules:

- Default remains disabled.
- It requires both `allowDangerFullAccess: true` and an explicit invocation.
- Automatic orchestration may not select it.
- The controller never falls back to it because workspace-write setup failed.
- Its use must be visible in the compressed plan and durable result.

Add `allowDirectMode: false` to default Git configuration. Direct mode requires both explicit invocation and `allowDirectMode: true`.

Tasks 2, 7, 10, 17, and 19 must apply these rules.

---

## 10. Restrict direct mode to explicit experimental use

Direct single-writer mode affects the user's visible working tree before verification completes. Ignored-file writes and arbitrary local tool side effects cannot be fully reconstructed through Git audits.

Therefore:

- Isolated writer mode is the shipped default and release-critical path.
- Automatic orchestration never uses direct mode in Phase 2.
- Direct mode requires explicit `/codex:orchestrate`, project/user `allowDirectMode: true`, a clean named branch, one writer, no concurrent packages, no mandatory Reviewer, workspace-write sandboxing, and successful preflight.
- The compressed plan must label it `experimental direct writer`.
- Failure/cancellation preserves visible changes and never resets them.
- If cross-platform tests cannot prove the branch/index/tree transition safely, direct mode may remain disabled without blocking isolated-writer Phase 2 release. In that case, document it as planned but unavailable rather than silently degrading to isolated mode after the user explicitly requested direct mode.

Task 17 is therefore an **optional release extension** after Tasks 1–16 and 18–20 are green. Acceptance criterion 17 applies only when direct mode is enabled in the release candidate.

---

## 11. Define safe final-application mechanics

The base plan correctly requires fast-forward-only application with an expected-old-value guard. Use a porcelain or plumbing sequence that provides all-or-nothing safety as far as Git permits.

For isolated mode, the preferred implementation is:

1. Revalidate branch, `HEAD`, index tree, status, and Git-operation state.
2. Confirm the final commit is a direct child of baseline.
3. Invoke a fast-forward-only operation from the user's active worktree with hooks, editors, credentials, and prompts disabled.
4. Verify `HEAD`, index tree, and clean status.

Do not use `reset --hard`, force-update, checkout overwrite, stash, or clean.

The implementation must include an injected race point in tests. If the branch moves before Git acquires its ref lock, application must fail without modifying the user's worktree. If an unexpected partial failure occurs after ref movement, mark `AUTO_APPLY_PARTIAL_FAILURE`, preserve diagnostics, and do not attempt an automatic rollback that could destroy user work.

Add `AUTO_APPLY_PARTIAL_FAILURE` to the required error-code table.

Task 16 owns this proof.

---

## 12. Separate controller preparation from model permissions

The controller may create worktrees, refs, package commits, integration commits, and final commits. The model may not.

Approval and sandbox tests must distinguish:

- fixed internal controller Git operations, constructed by code;
- plan-declared preparation/verification commands, subject to command policy;
- model-requested commands, subject to App Server approval policy;
- ordinary file edits inside writable roots.

Never grant the writer model writable access to the Git common directory merely because the controller later needs to commit.

Tasks 7, 8, 10, 11, and 13 must prove this separation.

---

## 13. Cancellation and controller-loss behavior

Cancellation order for write orchestration:

1. Persist `cancelling` before interrupting workers.
2. Stop new scheduling.
3. Interrupt active Roots.
4. Wait the configured grace period.
5. Terminate remaining worker process trees.
6. Capture model output, Git status, actual changed files, and worktree identity.
7. Preserve package branches/worktrees and direct-mode visible changes.
8. Persist terminal state and aggregate result.
9. Release the write lease.

Do not normalize, integrate, review, create a final commit, or auto-apply after cancellation begins.

On controller loss, a newly started controller may inspect but not mutate an unfinished write orchestration. It records `WRITE_RECOVERY_REQUIRES_PHASE_3`, preserves artifacts, and does not release or steal an orphan lease until the stale-owner safety checks in Task 4 are satisfied.

Task 18 must include crash points before and after worktree creation, package commit creation, integration, and final commit creation.

---

## 14. Read-only regression invariants

Phase 2 changes shared controller and App Server modules. Preserve these exact Phase 1 properties:

- Read-only plan normalization remains valid without write fields.
- Read-only packages use `access: "read-only"`, shared workspace, read-only sandbox, and empty canonical changed files.
- Read-only orchestration does not require Git, a clean tree, a write lease, preparation commands, worktrees, package commits, integration, or Reviewer state.
- Existing rescue/review/transfer and shared-broker behavior retains default server-request rejection.
- Existing model-catalog and reasoning-effort behavior remains unchanged.
- Read-only cancellation and transient retry semantics remain unchanged.

Every task that modifies a shared module must run its existing Phase 1 focused tests in addition to its new writer tests.

---

## 15. Corrected implementation dependencies

The base plan's numbered order remains valid with these refinements:

- Task 1 defines preparation-command and post-writer dependency contracts.
- Task 2 adds `allowDirectMode` and explicit unrestricted-mode gates.
- Task 3 provides preflight and authoritative baseline capture primitives.
- Task 4 provides write lease ownership.
- Task 5 remains the ownership policy dependency for prompts, commits, integration, and application.
- Task 6 implements one reusable safe local-command runner for both preparation and verification.
- Task 7 implements App Server request mediation and the shared command classifier.
- Task 8 applies hardened Git/worktree environment and safe data-root checks.
- Task 9 defines model-facing writer/reviewer contracts.
- Task 10 executes Roots but does not normalize commits.
- Task 11 uses temporary-index plus `commit-tree` normalization.
- Task 12 persists v2 state after the value objects are stable.
- Tasks 13–16 implement integration, review, finalization, and safe application.
- Task 17 is optional explicit direct mode and must not delay the isolated-writer release.
- Task 18 composes the controller only after the lower-level components exist.
- Tasks 19–20 expose and verify the complete feature.

Task 18's start sequence is amended by Section 1 of this document.

---

## 16. Design-to-plan traceability

| Approved Phase 2 deliverable | Plan coverage | Amendment |
|---|---|---|
| Clean-tree writer orchestration | Tasks 1–5, 8, 10, 18 | Authoritative baseline captured after lease acquisition. |
| Writer package worktrees | Task 8 | Managed root must be outside repo/Git/worktrees; hooks/LFS hardened. |
| Package commit normalization | Task 11 | Temporary index + `commit-tree` + expected-old `update-ref`. |
| Integration branch | Tasks 13, 15 | Hardened Git; no semantic resolution. |
| Dependency-ordered cherry-pick | Task 13 | Post-writer DAG packages prohibited; writer code dependencies collapsed. |
| Conflict decision points | Tasks 13, 18, 19 | Terminal/preserved in Phase 2. |
| Risk-triggered Reviewer | Task 14 | Post-package gate declared by Claude, not invented by runtime. |
| Full verification | Tasks 6, 15 | Preparation added; commands policy-checked and non-shell. |
| Final local squash commit | Task 15 | Parent fixed to baseline; plumbing audit. |
| Safe clean-branch application | Task 16 | No reset/stash/clean; expected-old/race proof. |
| Controller-mediated approval | Task 7 | Opt-in request handler; default remains rejection. |
| Automatic local writes | Tasks 18–19 | Only clean isolated mode; unrestricted/direct excluded from auto-entry. |
| macOS/Linux/Windows support | Task 20 | Git hardening, path containment, process-tree and race coverage. |
| Preserve Phase 1 | Every shared-module task | Explicit regression invariants in Section 14. |
| Dirty-tree/recovery deferral | Tasks 4, 18, 19 | Preserve and block with Phase 3 error; no implicit resume. |

---

## 17. Additional required error codes

Add these to the base plan's table:

| Code | Meaning |
|---|---|
| `WORKSPACE_PREPARATION_FAILED` | A declared local preparation command failed. |
| `UNSAFE_PLAN_COMMAND` | A preparation/verification command violates command policy. |
| `UNSAFE_PLUGIN_DATA_LOCATION` | Managed state/worktree root overlaps repository metadata or a source worktree. |
| `LFS_CONTENT_UNAVAILABLE` | Required tracked LFS content cannot be hydrated without forbidden network access. |
| `AUTO_APPLY_PARTIAL_FAILURE` | Unexpected failure occurred after application began; no destructive rollback attempted. |

---

## 18. Final self-review verdict

The amended plan is sufficiently detailed for implementation.

The decisive safety structure is:

```text
clean preflight
→ exclusive write lease
→ authoritative baseline
→ isolated worktrees
→ workspace-write App Server sandbox
→ fail-closed approvals
→ Git-derived ownership audit
→ controller-run verification
→ controller-normalized package commits
→ deterministic integration
→ mandatory risk review
→ final single-parent commit
→ revalidated fast-forward or preservation
```

The implementation must not claim Phase 2 completion until:

- isolated one-writer and two-writer flows pass on all three operating systems;
- the current generated App Server approval and sandbox types are exercised;
- external and out-of-root requests are denied;
- package and final commits are independently audited;
- an injected user-branch race leaves user work intact;
- Phase 1 and all legacy single-job paths remain green;
- the authenticated disposable-repository smoke suite passes.

No dirty-tree, automatic recovery, dynamic repair-package, or semantic conflict-resolution behavior may be inferred from the existence of preserved worktrees. Those remain Phase 3.