# Fix Recovered-Turn Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/codex:task`, native `/codex:review`, and the stop-review-gate from reporting failure when a turn recorded a transient (recovered) error but still completed with usable output.

**Architecture:** Add one named helper `resolveRunExitStatus(result, usableText)` in `lib/codex.mjs` that returns exit 0 when the turn completed with usable text (even if a stale `error` is set), else the raw `result.status`. Apply it at the two un-compensated caller sites in `codex-companion.mjs` (task + native review). Leave `buildResultStatus`, the runners, and the already-correct adversarial path untouched. The stop-gate needs no code change — it keys off the task's process exit code, which now becomes 0 on recovery; this is proven by test, not assumed.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, no external test deps. Fake Codex app-server fixture in `tests/fake-codex-fixture.mjs`.

**Working directory note:** All edits are in the `/Users/kentpeng/projects/codex-plugin-cc` repo on branch `feat/codex-self-collect-multiturn`. Run all commands from that repo root.

---

## File Structure

- **Modify** `plugins/codex/scripts/lib/codex.mjs` — add + export `resolveRunExitStatus`. (Single new pure function, ~5 lines, beside `buildResultStatus` at line 740.)
- **Modify** `plugins/codex/scripts/codex-companion.mjs` — import the helper; replace `exitStatus: result.status` at the task site (line 655) and the native-review site (line 414); normalize the matching `payload.status` / `payload.codex.status` fields.
- **Modify** `tests/fake-codex-fixture.mjs` — add a `gate-recovered` named scenario that emits `agentMessage` + `error` notice + `turn/completed` (models a recovered transient on the named-scenario path the gate test uses).
- **Modify** `tests/investigation.test.mjs` — add task-path recovery e2e tests (A) and native-review recovery e2e tests (B), mirroring the existing `runCompanion` harness.
- **Modify** `tests/runtime.test.mjs` — add stop-gate recovery test (C), mirroring the existing gate-block / gate-allow tests.

Each task below is independently committable and ordered TDD-first.

---

## Task 1: Add `resolveRunExitStatus` helper (unit-tested)

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` (add function near line 745, after `buildResultStatus`)
- Test: `tests/fake-codex-fixture.test.mjs` (add a unit test block; it already imports from `lib/codex.mjs`)

- [ ] **Step 1: Write the failing test**

In `tests/fake-codex-fixture.test.mjs`, add `resolveRunExitStatus` to the existing import from `../plugins/codex/scripts/lib/codex.mjs` (line 5), then append this test at the end of the file:

```js
test("resolveRunExitStatus treats a completed turn with usable text as success despite a stale error", () => {
  // Recovered transient: turn completed, has usable text, but result.status is 1
  // (buildResultStatus saw the stale `error`). Must resolve to 0.
  assert.equal(
    resolveRunExitStatus({ turn: { status: "completed" }, status: 1 }, "ALLOW: looks fine"),
    0,
    "completed turn with usable text overrides the stale non-zero status"
  );

  // Genuine failure: no usable text => keep the raw status.
  assert.equal(
    resolveRunExitStatus({ turn: { status: "completed" }, status: 1 }, "   "),
    1,
    "completed turn with no usable text keeps the failure status"
  );

  // Genuine failure: turn did not complete => keep the raw status even with text.
  assert.equal(
    resolveRunExitStatus({ turn: { status: "failed" }, status: 1 }, "some text"),
    1,
    "non-completed turn keeps the failure status"
  );

  // Clean success: status already 0 => stays 0.
  assert.equal(
    resolveRunExitStatus({ turn: { status: "completed" }, status: 0 }, "done"),
    0,
    "a clean success stays 0"
  );

  // Missing turn => not recovered => raw status.
  assert.equal(
    resolveRunExitStatus({ turn: null, status: 1 }, "text"),
    1,
    "absent turn cannot be recovered; keep the raw status"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fake-codex-fixture.test.mjs`
Expected: FAIL — `resolveRunExitStatus is not a function` / `not exported` (import resolves to `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `plugins/codex/scripts/lib/codex.mjs`, immediately after the `buildResultStatus` function (which ends at line 745), add:

```js
// A turn can complete with usable output yet still carry a stale transient
// `error` (e.g. "Reconnecting... 1/5") that buildResultStatus turned into a
// non-zero status. Callers that produced a usable result should report success.
// `usableText` is the per-caller "did we get output" signal: finalMessage for
// tasks, reviewText for native review. buildResultStatus and the runners are
// intentionally left alone so result.status semantics stay stable for the
// adversarial path (which has its own, stricter parsed-verdict compensation).
export function resolveRunExitStatus(result, usableText) {
  const recovered =
    result.turn?.status === "completed" && Boolean(String(usableText ?? "").trim());
  return recovered ? 0 : result.status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fake-codex-fixture.test.mjs`
Expected: PASS — all assertions in the new test green; no other test in the file regresses.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs tests/fake-codex-fixture.test.mjs
git commit -m "feat(codex): add resolveRunExitStatus recovery helper"
```

---

## Task 2: Apply helper to the task path + native-review path

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs:21-24` (import), `:414` (native review exitStatus), `:398` (native review payload.codex.status), `:647` (task payload.status), `:655` (task exitStatus)
- Test: `tests/investigation.test.mjs` (add task + native-review recovery e2e)

- [ ] **Step 1: Write the failing tests**

In `tests/investigation.test.mjs`, append these tests AFTER the existing `runCompanion` helper definition (after line 670). They use the queue-driven fixture (`setupFakeCodex`) and the `runCompanion` spawn helper already in the file.

```js
test("task turn that recovered from a transient reconnect is NOT marked failed (e2e)", async () => {
  // A task turn emits a valid agent message AND a stale transient `error`
  // ("Reconnecting... 1/5"), then turn/completed. The companion must exit 0 and
  // report success — not propagate the stale non-zero status from buildResultStatus.
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      finalAnswer: { text: "ALLOW: looks fine" },
      turnError: { message: "Reconnecting... 1/5" }
    });

    const result = runCompanion(["task", "--json", "--cwd", cwd, "do the thing"], fake.env);

    assert.equal(result.status, 0, "a recovered task must exit 0, not propagate the stale transient error status");
    const payload = JSON.parse(result.stdout.trim());
    assert.match(payload.rawOutput, /ALLOW: looks fine/, "the real agent answer must be returned");
    assert.equal(payload.status, 0, "payload.status must be normalized to the resolved success status");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("task turn that errored with no usable output still fails (e2e)", async () => {
  // Guard the genuine-failure case: a transient/fatal error with NO agent message
  // must still exit non-zero. Otherwise resolveRunExitStatus would whitewash real
  // failures.
  const cwd = makeSelfCollectGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      finalAnswer: null,
      turnError: { message: "Connection lost; giving up." }
    });

    const result = runCompanion(["task", "--json", "--cwd", cwd, "do the thing"], fake.env);

    assert.notEqual(result.status, 0, "a turn that errored with no usable output must still fail");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("native review that recovered from a transient reconnect is NOT marked failed (e2e)", async () => {
  // The native /codex:review branch returns exitStatus from result.status raw.
  // A recovered native review (reviewText present + stale error) must exit 0.
  // Note: review uses reviewText as the usable-output signal, not finalMessage.
  const cwd = makeInlineGitFixture();
  const fake = setupFakeCodex({ cwd });
  try {
    fake.queueTurnResponse({
      reviewText: "Reviewed current changes.\nNo material issues found.",
      turnError: { message: "Reconnecting... 1/5" }
    });

    const result = runCompanion(
      ["review", "--base", "main", "--scope", "branch", "--cwd", cwd, "--json"],
      fake.env
    );

    assert.equal(result.status, 0, "a recovered native review with review text must exit 0");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.codex.status, 0, "payload.codex.status must be normalized to the resolved success status");
  } finally {
    fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

> NOTE for the implementer: the queue-driven fixture currently emits `agentMessage` for `entry.finalAnswer` but has no `reviewText` path. The native-review test above depends on Step 2b (fixture review-recovery support). If you are running tests strictly before any implementation, the native-review test will fail at the fixture level first; that is expected and is fixed in Step 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="recovered from a transient reconnect is NOT marked failed|errored with no usable output still fails|native review that recovered" tests/investigation.test.mjs`
Expected: FAIL — the task recovery test fails with `result.status === 1` (regression present); the native-review test fails (no recovered review path / status 1).

- [ ] **Step 3: Wire the helper into the companion**

3a. In `plugins/codex/scripts/codex-companion.mjs`, add `resolveRunExitStatus` to the import block (lines 21-24). The block becomes:

```js
    resolveReviewTurnIdleTimeoutMs,
    resolveRunExitStatus,
    runAppServerInvestigation,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
```

3b. In the native-review branch of `executeReviewRun`, normalize the payload status. Change the `codex` block (lines 397-402) from:

```js
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
```

to:

```js
      codex: {
        status: resolveRunExitStatus(result, result.reviewText),
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
```

3c. In the same branch, change the returned `exitStatus` (line 414) from:

```js
      exitStatus: result.status,
```

to:

```js
      exitStatus: resolveRunExitStatus(result, result.reviewText),
```

3d. In `executeTaskRun`, normalize the payload status. Change the `payload` block (lines 646-652) from:

```js
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };
```

to:

```js
  const exitStatus = resolveRunExitStatus(result, result.finalMessage);
  const payload = {
    status: exitStatus,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };
```

3e. In the same function, change the returned `exitStatus` (line 655) from:

```js
    exitStatus: result.status,
```

to:

```js
    exitStatus,
```

- [ ] **Step 4: Run the task tests to verify the task path passes**

Run: `node --test --test-name-pattern="recovered from a transient reconnect is NOT marked failed|errored with no usable output still fails" tests/investigation.test.mjs`
Expected: PASS — both task tests green. (The native-review test still needs the fixture work in Task 3 if its `reviewText` queue entry is unsupported; if it already passes because the fixture supports `reviewText`, even better — verify in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/investigation.test.mjs
git commit -m "fix(codex): exit success on recovered task and native review turns"
```

---

## Task 3: Support recovered review text in the queue-driven fixture

**Files:**
- Modify: `tests/fake-codex-fixture.mjs` (queue-driven `turn/start` block, lines 407-414) and `review/start` block (lines 338-367)
- Test: `tests/investigation.test.mjs` (the native-review recovery test from Task 2)

> WHY: `runAppServerReview` issues a `review/start` request, not `turn/start`. The queue-driven fixture's `review/start` handler (line 338) does not currently consume the queue or emit a `turnError`, so the native-review recovery test cannot inject a recovered transient. This task makes `review/start` honor a queued `{ reviewText, turnError }` entry.

- [ ] **Step 1: Confirm the native-review test currently fails**

Run: `node --test --test-name-pattern="native review that recovered" tests/investigation.test.mjs`
Expected: FAIL — the queued `reviewText` entry is ignored; review returns the default `nativeReviewText` and status 0 OR the assertion on `payload.codex.status`/recovery does not hold. (Record the actual failure so Step 3's fix is verified against it.)

- [ ] **Step 2: Make `review/start` consume the queue in queue-driven mode**

In `tests/fake-codex-fixture.mjs`, replace the `review/start` handler body (lines 338-367) so that, in `queue-driven` BEHAVIOR, it pops a queue entry and emits the review text plus an optional transient error. Replace:

```js
      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }
```

with:

```js
      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });

        // Queue-driven mode lets a test script the review text and inject a
        // transient (recovered) error to exercise the recovered-status path.
        const reviewEntry =
          BEHAVIOR === "queue-driven" && state.queue && state.queue.length > 0
            ? state.queue.shift()
            : null;
        if (reviewEntry) {
          saveState(state);
        }
        const reviewText = reviewEntry && typeof reviewEntry.reviewText === "string"
          ? reviewEntry.reviewText
          : nativeReviewText(message.params.target);

        send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
        send({
          method: "item/started",
          params: { threadId: reviewThread.id, turnId, item: { type: "enteredReviewMode", id: turnId, review: "current changes" } }
        });
        if (BEHAVIOR === "with-reasoning") {
          send({
            method: "item/completed",
            params: {
              threadId: reviewThread.id,
              turnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + turnId,
                summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                content: []
              }
            }
          });
        }
        send({
          method: "item/completed",
          params: { threadId: reviewThread.id, turnId, item: { type: "exitedReviewMode", id: turnId, review: reviewText } }
        });
        if (reviewEntry && reviewEntry.turnError) {
          send({ method: "error", params: { threadId: reviewThread.id, turnId, error: { message: reviewEntry.turnError.message } } });
        }
        send({ method: "turn/completed", params: { threadId: reviewThread.id, turn: buildTurn(turnId, "completed") } });
        break;
      }
```

> This expands the `emitTurnCompleted` shorthand into explicit sends so the
> `error` notification can be slotted between the final review item and
> `turn/completed`, exactly as the queue-driven `turn/start` path does (lines
> 407-420). Non-queue-driven behaviors are unaffected: `reviewEntry` is null, so
> `reviewText` falls back to `nativeReviewText` and no error is sent.

- [ ] **Step 3: Run the native-review recovery test to verify it passes**

Run: `node --test --test-name-pattern="native review that recovered" tests/investigation.test.mjs`
Expected: PASS — recovered native review exits 0 and `payload.codex.status === 0`.

- [ ] **Step 4: Verify existing native-review tests still pass**

Run: `node --test --test-name-pattern="native-review|review renders|review includes reasoning|review logs reasoning|review accepts the quoted" tests/runtime.test.mjs tests/investigation.test.mjs`
Expected: PASS — the expanded `review/start` handler is behavior-equivalent for non-queue-driven scenarios (these tests use `installFakeCodex` named scenarios, not the queue, so `reviewEntry` is null).

- [ ] **Step 5: Commit**

```bash
git add tests/fake-codex-fixture.mjs
git commit -m "test(codex): let queue-driven fixture script native review text and transient errors"
```

---

## Task 4: Stop-gate proceeds to parse the answer on a recovered task

**Files:**
- Modify: `tests/fake-codex-fixture.mjs` (add a `gate-recovered` named scenario in `taskPayload` + `turn/start` named-scenario path)
- Test: `tests/runtime.test.mjs` (add a gate-recovery test mirroring the existing gate tests at lines 1801 and 1914)

> WHY a named scenario (not the queue): the stop-gate test harness installs the
> fake via `installFakeCodex(binDir, behavior)` and runs the real
> `stop-review-gate-hook.mjs`, which spawns `codex-companion.mjs task`. That child
> process has its own fresh fixture state, so the parent test cannot pre-queue
> turns for it. A named scenario bakes the recovered-transient behavior into the
> fake binary itself.

- [ ] **Step 1: Write the failing test**

In `tests/runtime.test.mjs`, add this test after the existing `"stop hook allows the stop when the review gate is enabled and the stop-time review task is clean"` test (after line ~1955; place it adjacent to the other gate tests). It mirrors that test's setup but installs the `gate-recovered` scenario:

```js
test("stop hook parses the ALLOW answer when the stop-time review task recovered from a transient error", () => {
  // Regression: a gate review that survives a transient "Reconnecting..." notice
  // still completes with a valid ALLOW answer. The task must exit 0 so the hook
  // parses ALLOW/BLOCK instead of false-positive blocking on "task failed".
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "gate-recovered");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-recovered",
      last_assistant_message: "I completed the refactor."
    })
  });

  // ALLOW => the hook does not emit a block decision; it exits cleanly with no
  // stdout decision payload (mirrors the existing clean-allow test).
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "", "a recovered ALLOW review must NOT block the session");
});
```

> The assertion mirrors the existing `"... allows the stop ... when ... clean"`
> test (runtime.test.mjs:1935-1936), which asserts `status === 0` and
> `stdout.trim() === ""`. This has been verified — match it exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="recovered from a transient error" tests/runtime.test.mjs`
Expected: FAIL. At this point the `gate-recovered` scenario does not exist yet, so `installFakeCodex(binDir, "gate-recovered")` falls through to the default task behavior (`taskPayload` returns the BLOCK answer), and the hook emits `decision: "block"` — so `result.stdout` is non-empty and the `stdout.trim() === ""` assertion fails. (Order note: Tasks are TDD-ordered, but the Task 2 companion fix is what makes the *recovered-transient* case exit 0; this test additionally needs the scenario from Step 3 to inject that transient. If you run this before Task 2's fix is committed, it fails for the BLOCK reason above; after Step 3 it passes only because Task 2's fix is also in place.)

- [ ] **Step 3: Add the `gate-recovered` named scenario to the fixture**

3a. In `tests/fake-codex-fixture.mjs`, make `taskPayload` return an ALLOW answer for the gate prompt under the new scenario. Change the gate branch (lines 220-225) from:

```js
function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }
```

to:

```js
function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean" || BEHAVIOR === "gate-recovered") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }
```

3b. In the named-scenario `turn/start` path, emit a transient `error` notification for the `gate-recovered` scenario, after the agent message and before `turn/completed`. The non-subagent path builds an `items` array (lines 553-569) and emits it via `emitTurnCompleted` (line 589). `emitTurnCompleted` sends `turn/started`, the items, then `turn/completed` (fixture lines 147-159) — there is no slot for an interleaved `error`. So for `gate-recovered`, emit explicitly instead of calling `emitTurnCompleted`.

Change the tail dispatch (lines 586-590) from:

```js
		} else if (BEHAVIOR === "slow-task") {
		  emitTurnCompletedLater(thread.id, turnId, items, 400);
		} else {
		  emitTurnCompleted(thread.id, turnId, items);
		}
```

to:

```js
		} else if (BEHAVIOR === "slow-task") {
		  emitTurnCompletedLater(thread.id, turnId, items, 400);
		} else if (BEHAVIOR === "gate-recovered") {
		  // Recovered transient: emit the agent message, then a stale "error"
		  // notice, then turn/completed. The turn still has usable output, so the
		  // companion must exit 0 (resolveRunExitStatus) and the gate must parse
		  // the ALLOW answer rather than block on a phantom failure.
		  send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
		  for (const entry of items) {
		    if (entry && entry.completed) {
		      send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
		    }
		  }
		  send({ method: "error", params: { threadId: thread.id, turnId, error: { message: "Reconnecting... 1/5" } } });
		  send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
		} else {
		  emitTurnCompleted(thread.id, turnId, items);
		}
```

- [ ] **Step 4: Run the gate test to verify it passes**

Run: `node --test --test-name-pattern="recovered from a transient error" tests/runtime.test.mjs`
Expected: PASS — the recovered ALLOW review exits 0, the hook parses ALLOW, no block decision is emitted (`result.stdout` empty).

- [ ] **Step 5: Verify the existing gate tests still pass**

Run: `node --test --test-name-pattern="stop hook" tests/runtime.test.mjs`
Expected: PASS — `"... blocks on findings ..."`, `"... allows the stop ... clean"`, and `"... logs running tasks ... without blocking"` all green. The `gate-recovered` scenario only adds an ALLOW + transient path; other scenarios are untouched.

- [ ] **Step 6: Commit**

```bash
git add tests/fake-codex-fixture.mjs tests/runtime.test.mjs
git commit -m "test(codex): stop-gate parses ALLOW when the review task recovered from a transient error"
```

---

## Task 5: Full-suite verification and regression guard

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/*.test.mjs`
Expected: The suite completes and EXITS CLEANLY (no hang). The ONLY failures permitted are these four KNOWN pre-existing failures unrelated to this work:
  - `status shows phases, hints, and the latest finished job`
  - `status preserves adversarial review kind labels`
  - `result returns the stored output for the latest finished job by default`
  - `resolveStateDir uses a temp-backed per-workspace directory`

Net new failures must be **zero**.

- [ ] **Step 2: Confirm the pre-existing failures match the baseline**

Run (capture failing test names): `node --test tests/*.test.mjs 2>&1 | grep -E "^not ok|# failing" | sort -u`
Expected: every `not ok` line corresponds to one of the four known failures above. If any other test fails, it is a regression introduced by this work — stop and debug it (use systematic-debugging).

- [ ] **Step 3: Confirm clean exit (no process leak)**

Run: `node --test tests/*.test.mjs; echo "EXIT=$?"`
Expected: the command returns promptly (does not hang waiting on an abandoned turn). `EXIT` is non-zero only because of the four known failures, not because of a timeout/hang.

- [ ] **Step 4: Regression-guard the adversarial + idle-watchdog paths explicitly**

Run: `node --test --test-name-pattern="recovered finalize|recovered from a transient reconnect keeps its valid verdict|idle|watchdog" tests/investigation.test.mjs tests/fake-codex-fixture.test.mjs`
Expected: PASS — confirms the A2 caller-only fix did not disturb the adversarial compensation (codex-companion.mjs:575) or the idle-timeout failure semantics.

- [ ] **Step 5: No commit (verification task)**

If everything is green (modulo the four known failures), the implementation is complete. Proceed to the deploy step below only when the change is merge-ready.

---

## Deploy to the live local install (after merge-ready — do NOT do during implementation)

The running plugin is the CACHE build, not this repo. After the change is merge-ready and reviewed:

1. Back up the cache copies of the three changed files.
2. Copy the changed files into `~/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/...` preserving the same relative paths:
   - `plugins/codex/scripts/lib/codex.mjs`
   - `plugins/codex/scripts/codex-companion.mjs`
   - (tests are not deployed)
3. Mapping reference: memory `codex-plugin-runtime-source`.

---

## Out of scope (track separately; do NOT bundle into this work)

- `?? ""`-empty-string family (`cleanCodexStderr` returns "" collapsing `x ?? "default"` chains).
- Native `/codex:review` missing the idle watchdog and empty-diff short-circuit.
- `--turn-idle-timeout` has no upper bound (huge value overflows setTimeout).
- `runAppServerInvestigation` sets `truncated = true` when `totalCommandsRun === 0`.
- `captureTurn` `armIdle()` runs before the `belongsToTurn` filter.
- Uncommitted dead `runAppServerTurn` import in `tests/investigation.test.mjs`.
- Stale `DEFAULT_INLINE_DIFF_MAX_FILES = 2` comment in `tests/investigation.test.mjs`.
