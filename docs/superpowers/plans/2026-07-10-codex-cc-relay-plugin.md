# Codex CC Relay Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend upstream `openai/codex-plugin-cc` v1.0.6 into relay release v1.1.6 with Fable-owned GPT-5.6 routing, model-neutral prompt shaping, deterministic resume-by-ID, a read-only Codex reviewer, and the two approved baseline fixes.

**Architecture:** Preserve the upstream plugin, command names, state format, license, and thin-agent execution model. Put changeable decision policy in internal skills, let the main Claude/Fable context apply those skills before delegating, and keep the runtime responsible only for validated transport and exact thread selection. Fresh rescue requests may be routed; resumed requests preserve their thread defaults unless the user supplies an explicit override.

**Tech Stack:** Claude Code plugin Markdown/YAML, Node.js ESM, `node:test`, Codex App Server JSON-RPC, npm.

## Global Constraints

- Implement only the capabilities approved in the design specification at `docs/superpowers/specs/2026-07-10-codex-cc-relay-plugin-design.md`.
- Preserve the Apache-2.0 license, upstream Git history, `/codex:rescue` namespace, existing state schema, and existing foreground output contract.
- Do not add model application, dynamic model-catalog validation, concurrent state locking, or new background semantics.
- Keep routing and prompt-shaping policy in separate internal skills so either can change without editing the runtime.
- Use test-driven development for every behavior change: add a focused failing test, run it and observe the expected failure, make the smallest implementation, then rerun the focused and full suites.
- Use one focused commit per task. Do not combine unrelated user changes already present in the worktree.
- Treat `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` as the approved relay model identifiers. Do not query App Server model catalogs or invent fallback model names.
- Treat `max` as a valid explicit reasoning effort and `ultra` as invalid. Automatic routing must never select `max`.

### Known Windows baseline

A fresh `npm test` run on 2026-07-10 in this Windows workspace completed 91 tests:
85 passed and these 6 upstream platform-specific tests failed:

- `createBrokerEndpoint uses Unix sockets on non-Windows platforms`;
- `setup is ready without npm when Codex is already installed and authenticated`;
- `transfer delegates the current Claude session directly to native import`;
- `transfer reports an actionable upgrade error when native import is unsupported`;
- `transfer fails visibly when native import completes without a ledger record`;
- `cancel sends turn interrupt to the shared app-server before killing a brokered task`.

Those portability failures are outside the approved relay scope and must not be fixed
in this plan. On Windows, every task must pass its focused tests and a full `npm test`
run must introduce no failure beyond those six named tests. The release gate remains
a zero-failure `npm test` run in the upstream Linux CI environment.

---

## Task 1: Establish a Hermetic Baseline and Fix Hook Metadata

**Interfaces**

- Consumes: process environment variables `CLAUDE_PLUGIN_DATA` and `CODEX_COMPANION_SESSION_ID`.
- Produces: one isolated plugin-data directory for the test process and a valid `hooks.json` schema.

**Files**

- Modify: `tests/helpers.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/commands.test.mjs`
- Modify: `plugins/codex/hooks/hooks.json`

- [ ] **Step 1: Add tests that expose the current baseline defects**

In `tests/commands.test.mjs`, replace the string-only hooks assertion with a parsed JSON contract:

```js
test("hooks manifest contains only supported top-level fields", () => {
  const hooks = JSON.parse(read("hooks/hooks.json"));
  assert.deepEqual(Object.keys(hooks), ["hooks"]);
  assert.ok(Array.isArray(hooks.hooks.SessionEnd));
});
```

In `tests/state.test.mjs`, replace the first test body with:

```js
test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
```

This proves the test no longer depends on a developer machine's real Claude plugin data.

- [ ] **Step 2: Run the focused tests and confirm the failure**

Run:

```powershell
node --test tests/commands.test.mjs tests/state.test.mjs
```

Expected result: the hooks contract fails because `plugins/codex/hooks/hooks.json` currently has a top-level `description` field. Record any state-isolation failure before changing production or helper code.

- [ ] **Step 3: Isolate test state at helper import time**

Add immediately after the imports in `tests/helpers.mjs`:

```js
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-plugin-cc-tests-"),
);
delete process.env.CODEX_COMPANION_SESSION_ID;
```

Keep the first `tests/state.test.mjs` test's save/delete/restore logic so it explicitly tests the default temp-directory branch even though the shared test environment is isolated.

- [ ] **Step 4: Remove unsupported hook metadata**

Delete only the top-level `description` property from `plugins/codex/hooks/hooks.json`. Do not change the `SessionEnd` hook command or timeout.

- [ ] **Step 5: Verify baseline correctness**

Run:

```powershell
node --test tests/commands.test.mjs tests/state.test.mjs
npm test
```

Expected result: the focused command exits 0 with no test reading or writing the user's real plugin data. The full suite meets the platform gate in `Known Windows baseline`.

- [ ] **Step 6: Commit the baseline fix**

```powershell
git add tests/helpers.mjs tests/state.test.mjs tests/commands.test.mjs plugins/codex/hooks/hooks.json
git commit -m "fix: isolate tests and validate hooks manifest"
```

---

## Task 2: Replace Model-Locked Prompting with a Model-Neutral Internal Skill

**Interfaces**

- Consumes: the user's original request and optional scope, success, and evidence information already available to the main Claude/Fable context.
- Produces: a Codex task prompt with the original request preserved exactly inside `<task>` and optional supporting blocks.

**Files**

- Delete: `plugins/codex/skills/gpt-5-4-prompting/SKILL.md`
- Delete: `plugins/codex/skills/gpt-5-4-prompting/references/coding-tasks.md`
- Delete: `plugins/codex/skills/gpt-5-4-prompting/references/prompt-recipes.md`
- Delete: `plugins/codex/skills/gpt-5-4-prompting/references/review-tasks.md`
- Create: `plugins/codex/skills/codex-prompting/SKILL.md`
- Modify: `plugins/codex/commands/rescue.md`
- Modify: `plugins/codex/agents/codex-rescue.md`
- Modify: `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- Modify: `tests/commands.test.mjs`

- [ ] **Step 1: Replace old prompt-shaping assertions with the new contract**

Update `tests/commands.test.mjs` so the rescue command contract asserts all of the following:

```js
assert.match(rescue, /codex:codex-prompting/);
assert.match(rescue, /main Claude context/i);
assert.match(rescue, /<task>/);
assert.match(rescue, /preserve.*exact/i);
assert.doesNotMatch(rescue, /gpt-5-4-prompting/);

assert.match(agent, /Do not rewrite or reshape/i);
assert.doesNotMatch(agent, /gpt-5-4-prompting/);
```

Add an internal-skill contract test that reads `plugins/codex/skills/codex-prompting/SKILL.md` and verifies:

- frontmatter includes `user-invocable: false`;
- `<task>` is required and exact;
- `<scope_and_success>` and `<evidence_and_final_response>` are optional;
- resume prompts contain only the new delta;
- review and adversarial-review prompts retain their native contracts;
- the text rejects generic “be concise,” “think harder,” and chain-of-thought requests.

- [ ] **Step 2: Run the command tests and observe the expected failure**

```powershell
node --test tests/commands.test.mjs
```

Expected result: tests fail because the old `gpt-5-4-prompting` skill is still referenced and `codex-prompting` does not yet exist.

- [ ] **Step 3: Create the internal prompt-shaping skill**

Create `plugins/codex/skills/codex-prompting/SKILL.md` with this complete contract:

```markdown
---
name: codex-prompting
description: Shape implementation prompts before delegating work to Codex.
user-invocable: false
---

# Codex Prompting

Use this skill in the main Claude context before invoking the Codex relay agent.

For a fresh implementation task, preserve the user's original task text exactly:

<task>
[the user's exact task text]
</task>

Add these blocks only when they contain concrete information already known from the conversation or repository:

<scope_and_success>
[in-scope files, constraints, acceptance criteria, and non-goals]
</scope_and_success>

<evidence_and_final_response>
[required tests, verification evidence, and requested response shape]
</evidence_and_final_response>

Do not paraphrase, shorten, or “improve” the text inside <task>. Do not invent requirements. Do not add generic instructions such as “be concise” or “think harder,” and do not request hidden chain-of-thought.

For a resume, send only the user's new delta or correction. Do not repeat the original task or previously supplied context.

For review and adversarial-review work, retain the review command's native finding-first contract instead of wrapping it in the implementation-task structure above.
```

- [ ] **Step 4: Move prompt shaping to the main command context**

In `plugins/codex/commands/rescue.md`:

1. Tell the main Claude/Fable context to load `codex:codex-prompting` for fresh implementation tasks.
2. Shape the prompt before invoking `codex-rescue`.
3. State that the original request must remain exact inside `<task>`.
4. For resume operations, pass only the new delta.

In `plugins/codex/agents/codex-rescue.md`:

1. Remove `gpt-5-4-prompting` from preloaded skills.
2. State that the supplied prompt is already shaped.
3. Prohibit rewriting or adding prompt blocks.
4. Preserve the existing one-call, stdout-verbatim, error-visible contract.

In `plugins/codex/skills/codex-cli-runtime/SKILL.md`, remove the exception allowing the thin agent to rewrite prompts. State that the agent transports the prompt received from the main context unchanged.

- [ ] **Step 5: Delete the superseded model-specific skill**

Remove the complete `plugins/codex/skills/gpt-5-4-prompting` directory. Confirm no tracked file references it:

```powershell
rg -n "gpt-5-4-prompting" plugins tests README.md
```

Expected result: no matches.

- [ ] **Step 6: Verify prompting behavior**

```powershell
node --test tests/commands.test.mjs
npm test
```

Expected result: the focused command exits 0 and the full suite meets the platform gate in `Known Windows baseline`.

- [ ] **Step 7: Commit the prompting boundary**

```powershell
git add plugins/codex/commands/rescue.md plugins/codex/agents/codex-rescue.md plugins/codex/skills/codex-cli-runtime/SKILL.md plugins/codex/skills/codex-prompting tests/commands.test.mjs
git add -u plugins/codex/skills/gpt-5-4-prompting
git commit -m "feat: make Codex prompt shaping model neutral"
```

---

## Task 3: Accept the Complete Static Effort Vocabulary

**Interfaces**

- Consumes: `--effort <value>` for `task`, foreground and background.
- Produces: a validated effort forwarded unchanged to App Server, including explicit `max`.

**Files**

- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/commands/rescue.md`
- Modify: `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/commands.test.mjs`

- [ ] **Step 1: Add focused effort-validation tests**

Extend `tests/runtime.test.mjs` with:

```js
test("task forwards explicit max effort", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const result = run(
    "node",
    [SCRIPT, "task", "--effort", "max", "inspect this"],
    { cwd: repo, env: buildEnv(binDir) },
  );
  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.effort, "max");
});

test("task rejects ultra effort", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const result = run("node", [SCRIPT, "task", "--effort", "ultra", "inspect this"], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /none, minimal, low, medium, high, xhigh, max/);
});
```

Update `tests/commands.test.mjs` to require `max` in the rescue command's argument hint and effort documentation.

- [ ] **Step 2: Run focused tests and confirm `max` fails**

```powershell
node --test tests/runtime.test.mjs tests/commands.test.mjs
```

Expected result: the explicit-`max` test fails because the runtime currently accepts efforts only through `xhigh`.

- [ ] **Step 3: Centralize the static effort list**

In `plugins/codex/scripts/codex-companion.mjs`, replace the Set-only declaration with:

```js
const VALID_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const VALID_REASONING_EFFORT_SET = new Set(VALID_REASONING_EFFORTS);
```

Use `VALID_REASONING_EFFORT_SET` for membership checks and `VALID_REASONING_EFFORTS.join(", ")` in usage and validation errors. Do not add App Server model/effort discovery.

- [ ] **Step 4: Align the command and runtime skill**

Update the `/codex:rescue` argument hint and `codex-cli-runtime` accepted effort list to:

```text
none|minimal|low|medium|high|xhigh|max
```

State that `max` is explicit-only and `ultra` is not a valid effort value.

- [ ] **Step 5: Verify effort handling**

```powershell
node --test tests/runtime.test.mjs tests/commands.test.mjs
npm test
```

Expected result: focused tests pass; explicit `max` is forwarded unchanged; `ultra` exits nonzero before App Server is invoked; the full suite meets the platform gate in `Known Windows baseline`.

- [ ] **Step 6: Commit the effort vocabulary**

```powershell
git add plugins/codex/scripts/codex-companion.mjs plugins/codex/commands/rescue.md plugins/codex/skills/codex-cli-runtime/SKILL.md tests/runtime.test.mjs tests/commands.test.mjs
git commit -m "feat: support explicit max reasoning effort"
```

---

## Task 4: Add Fable-Owned GPT-5.6 Routing for Fresh Rescue Tasks

**Interfaces**

- Consumes: a fresh rescue task, plus any explicit `--model` or `--effort` supplied by the user.
- Produces: zero, one, or two CLI overrides chosen by the main Claude/Fable context before delegation.
- Does not run for: `--resume`, `--resume-last`, or `--resume-id` requests.

**Files**

- Create: `plugins/codex/skills/gpt-5-6-routing/SKILL.md`
- Modify: `plugins/codex/commands/rescue.md`
- Modify: `plugins/codex/agents/codex-rescue.md`
- Modify: `tests/commands.test.mjs`

- [ ] **Step 1: Add the routing-policy contract test**

In `tests/commands.test.mjs`, read `plugins/codex/skills/gpt-5-6-routing/SKILL.md` and assert that it contains the exact tier pairs:

```js
assert.match(routing, /user-invocable:\s*false/);
assert.match(routing, /gpt-5\.6-luna.*low/s);
assert.match(routing, /gpt-5\.6-terra.*medium/s);
assert.match(routing, /gpt-5\.6-sol.*high/s);
assert.match(routing, /gpt-5\.6-sol.*xhigh/s);
assert.match(routing, /ambiguous.*higher tier/i);
assert.match(routing, /cannot decide.*leave.*unset/is);
assert.match(routing, /max.*explicit-only/is);
assert.match(routing, /Do not query a model catalog/i);
assert.match(routing, /do not substitute fallback model names/i);
```

Extend the rescue command contract to assert:

- it loads `codex:gpt-5-6-routing` only for fresh work;
- explicit model and effort both win;
- model-only triggers effort selection;
- effort-only triggers model selection;
- neither triggers selection of both;
- resumed work skips automatic routing and preserves the thread's original defaults;
- ambiguous fresh work selects the higher tier;
- inability to decide leaves the missing value unset.

Extend the thin-agent contract to assert that the agent receives resolved routing values and does not evaluate complexity.

- [ ] **Step 2: Run the command tests and observe the missing policy**

```powershell
node --test tests/commands.test.mjs
```

Expected result: tests fail because `gpt-5-6-routing` does not exist and complexity evaluation still belongs to `codex-rescue`.

- [ ] **Step 3: Create the routing skill**

Create `plugins/codex/skills/gpt-5-6-routing/SKILL.md` with the following policy:

```markdown
---
name: gpt-5-6-routing
description: Select a GPT-5.6 model and reasoning effort for a fresh Codex rescue task.
user-invocable: false
---

# GPT-5.6 Routing

Apply this policy only to fresh /codex:rescue work. Never automatically route a resumed thread.

Respect user overrides:

- Explicit model and effort: preserve both.
- Explicit model only: preserve the model and select only the effort.
- Explicit effort only: preserve the effort and select only the model.
- Neither explicit: select both.

Evaluate task breadth and affected components, ambiguity and repository exploration,
implementation or diagnosis depth, reversibility and risk, required verification,
and whether the work is tightly bounded or needs a long autonomous run.

Classify only the missing values:

| Task class | Model | Effort |
| --- | --- | --- |
| Small and bounded | gpt-5.6-luna | low |
| Normal and bounded | gpt-5.6-terra | medium |
| Broad, ambiguous, or high-value | gpt-5.6-sol | high |
| Architectural, high-risk, or unusually difficult | gpt-5.6-sol | xhigh |

Use the higher tier when a fresh task falls between two tiers or is ambiguous. Never select max automatically; max is explicit-only. ultra is not an effort value.

If Fable cannot decide a missing value from the available task information, leave that value unset so the upstream runtime default applies. Do not query a model catalog and do not substitute fallback model names.
```

- [ ] **Step 4: Move complexity evaluation into the main Fable command**

Edit `plugins/codex/commands/rescue.md` so its fresh-task flow is:

1. Parse user-supplied model and effort without changing them.
2. Load `codex:gpt-5-6-routing`.
3. Classify the task in the main Claude/Fable context.
4. Fill only missing model/effort values.
5. Load `codex:codex-prompting` and shape the prompt.
6. Invoke `codex-rescue` with the resolved prompt and overrides.

Document the separate resume flow before the fresh flow. The resume flow must not load or apply routing; it passes only explicit user overrides.

- [ ] **Step 5: Make `codex-rescue` a routing-neutral transport agent**

In `plugins/codex/agents/codex-rescue.md`:

- remove instructions to evaluate complexity or choose a model/effort;
- accept model and effort as already resolved optional values;
- omit flags that remain unset;
- retain foreground-by-default behavior;
- retain a single Bash call;
- retain verbatim foreground stdout and visible errors.

- [ ] **Step 6: Verify the routing boundary**

```powershell
node --test tests/commands.test.mjs
npm test
```

Expected result: focused tests pass, the full suite meets the platform gate in `Known Windows baseline`, and no runtime code contains GPT-5.6 task classification.

- [ ] **Step 7: Commit the routing policy**

```powershell
git add plugins/codex/skills/gpt-5-6-routing/SKILL.md plugins/codex/commands/rescue.md plugins/codex/agents/codex-rescue.md tests/commands.test.mjs
git commit -m "feat: add Fable-owned GPT-5.6 routing"
```

---

## Task 5: Add the Read-Only `codex-reviewer` Agent

**Interfaces**

- Consumes: an optional native review target such as `--base main`, optional focus/adversarial framing, and an optional explicit `--background`/`--wait` preference.
- Produces: exactly one native `review` or `adversarial-review` runtime invocation and verbatim foreground stdout.

**Files**

- Create: `plugins/codex/agents/codex-reviewer.md`
- Modify: `tests/commands.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add a reviewer-agent contract test**

In `tests/commands.test.mjs`, add:

```js
test("codex-reviewer is a read-only native review forwarder", () => {
  const agent = read("agents/codex-reviewer.md");
  assert.match(agent, /^name:\s*codex-reviewer$/m);
  assert.match(agent, /^tools:\s*Bash$/m);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /normal request[\s\S]*codex-companion\.mjs" review/);
  assert.match(agent, /focus text[\s\S]*codex-companion\.mjs" adversarial-review/);
  assert.match(agent, /foreground by default/i);
  assert.match(agent, /only.*background.*explicit/i);
  assert.match(agent, /stdout.*exactly as-is/i);
  assert.match(agent, /Never invoke task, never add --write/i);
  assert.match(agent, /never add --resume, --resume-last, or --resume-id/i);
  assert.doesNotMatch(agent, /codex-companion\.mjs" task/);
  assert.doesNotMatch(agent, /^skills:/m);
});
```

Extend the README contract to require both `codex:codex-rescue` and `codex:codex-reviewer` in the agents section.

- [ ] **Step 2: Run the test and confirm the agent is missing**

```powershell
node --test tests/commands.test.mjs
```

Expected result: the new test fails with `ENOENT` for `agents/codex-reviewer.md`.

- [ ] **Step 3: Create the reviewer agent**

Create `plugins/codex/agents/codex-reviewer.md`:

```markdown
---
name: codex-reviewer
description: Proactively use when Claude should obtain an independent read-only Codex review of the current working tree or branch before finishing
model: sonnet
tools: Bash
---

You are a thin forwarding wrapper around the Codex companion native review runtimes.

Use exactly one Bash call. For a normal request, invoke:

node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review ...

When the request contains focus text, custom review instructions, or explicitly adversarial framing, invoke:

node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review ...

Forward only controls valid for the selected native review command, including --base <ref> and --scope <auto|working-tree|branch>. Forward focus text only to adversarial-review. Treat --background and --wait as Claude-side execution preferences, not runtime arguments. Use foreground by default. Use background only when the caller explicitly requests it.

This agent is review-only. Never invoke task, never add --write, and never add --resume, --resume-last, or --resume-id. Do not fix findings, inspect the repository independently, read files, grep, poll, fetch results, cancel jobs, summarize, or perform follow-up work.

For foreground review, return the command stdout exactly as-is with no commentary before or after it. If the Bash call fails, return nothing.
```

- [ ] **Step 4: Document proactive reviewer delegation**

In `README.md`:

- add `codex:codex-reviewer` beside `codex:codex-rescue` in the agent list;
- explain that the reviewer selects the existing native review or adversarial-review path from the request;
- state that it is read-only, foreground by default, and non-resumable;
- do not describe it as an implementation or general-task agent.

- [ ] **Step 5: Verify and commit the reviewer**

```powershell
node --test tests/commands.test.mjs
npm test
git add plugins/codex/agents/codex-reviewer.md tests/commands.test.mjs README.md
git commit -m "feat: add proactive Codex reviewer agent"
```

Expected result: focused tests pass and the full suite meets the platform gate in `Known Windows baseline` before the commit.

---

## Task 6: Add Deterministic `--resume-id` Support

**Interfaces**

- Consumes: `task --resume-id <thread-id> [prompt]` in foreground or background.
- Produces: a `turn/start` request against exactly that thread ID, with the prompt as the delta and optional explicit model/effort overrides.
- Exclusivity: `--resume-id`, `--resume`/`--resume-last`, and `--fresh` are mutually exclusive routing modes.

**Files**

- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/commands/rescue.md`
- Modify: `plugins/codex/agents/codex-rescue.md`
- Modify: `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/commands.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add foreground exact-resume tests**

In `tests/runtime.test.mjs`, follow the existing fake-Codex setup pattern and add:

```js
test("task --resume-id resumes the exact requested thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run(
    "node",
    [SCRIPT, "task", "--resume-id", "thr_exact", "apply only the requested fix"],
    { cwd: repo, env: buildEnv(binDir) },
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_exact");
  assert.equal(fakeState.lastTurnStart.prompt, "apply only the requested fix");
});
```

Add a second test that includes `--model gpt-5.6-sol --effort high` and asserts that both explicit overrides are forwarded unchanged while resuming `thr_exact`.

- [ ] **Step 2: Add routing-conflict tests**

Use a table-driven test:

```js
for (const conflictingArgs of [
  ["--resume-id", "thr_exact", "--resume"],
  ["--resume-id", "thr_exact", "--resume-last"],
  ["--resume-id", "thr_exact", "--fresh"],
]) {
  test(`task rejects conflicting resume mode: ${conflictingArgs.join(" ")}`, () => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir);
    initGitRepo(repo);
    const result = run("node", [SCRIPT, "task", ...conflictingArgs, "continue"], {
      cwd: repo,
      env: buildEnv(binDir),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Choose exactly one.*resume-id.*resume-last.*fresh/i);
  });
}
```

Add validation tests for a missing value and a value beginning with `--`. Both must exit nonzero before invoking Codex.

- [ ] **Step 3: Add command and agent contract tests for exact resume**

In `tests/commands.test.mjs`, extend the rescue contract:

```js
assert.match(rescue, /--resume-id <thread-id>/);
assert.match(rescue, /skip.*task-resume-candidate.*--resume-id/is);
assert.match(rescue, /skip.*GPT-5\.6 routing.*--resume-id/is);
assert.match(rescue, /resume-id.*new delta/is);
assert.match(agent, /--resume-id <thread-id>/);
assert.match(agent, /do not replace.*--resume-last/is);
assert.match(runtimeSkill, /--resume-id <thread-id>/);
```

These assertions must be added before modifying the command, agent, or runtime skill.

- [ ] **Step 4: Add a background round-trip test**

Follow the existing `task --background enqueues a detached worker` test:

1. Launch `task --background --json --resume-id thr_exact "continue exact thread"`.
2. Parse `jobId` from stdout.
3. Call `status <jobId> --wait --timeout-ms 15000 --json`.
4. Assert status `completed`.
5. Read `fake-codex-state.json` and assert `lastTurnStart.threadId === "thr_exact"` and the prompt is `"continue exact thread"`.
6. Read the finished job JSON from `resolveStateDir(repo)/jobs/<jobId>.json` and assert `request.resumeId === "thr_exact"` if the existing finished-job record stores the worker request; otherwise assert its public `threadId` is `"thr_exact"`. Do not introduce another job schema solely for this assertion.

- [ ] **Step 5: Run the focused runtime and command tests and observe failure**

```powershell
node --test --test-name-pattern "resume-id|conflicting resume mode|background round-trip" tests/runtime.test.mjs
node --test tests/commands.test.mjs
```

Expected result: the CLI rejects or ignores `--resume-id` because it is not a registered value option.

- [ ] **Step 6: Parse and validate the new routing mode**

In `handleTask` in `plugins/codex/scripts/codex-companion.mjs`:

1. Add `"resume-id"` to `valueOptions`.
2. Normalize it as a trimmed non-empty string.
3. Reject a missing value or one beginning with `-`.
4. Count the selected modes:

```js
const resumeLast = Boolean(options["resume-last"] || options.resume);
const resumeId = normalizeResumeId(options["resume-id"]);
const fresh = Boolean(options.fresh);
if ([resumeLast, Boolean(resumeId), fresh].filter(Boolean).length > 1) {
  throw new Error(
    "Choose exactly one of --resume-id, --resume/--resume-last, or --fresh.",
  );
}
```

Implement `normalizeResumeId` next to the existing model and effort normalizers:

```js
function normalizeResumeId(value) {
  if (value === undefined) {
    return null;
  }
  const resumeId = String(value).trim();
  if (!resumeId || resumeId.startsWith("-")) {
    throw new Error("--resume-id requires a non-empty thread ID.");
  }
  return resumeId;
}
```

Update the usage line to show:

```text
[--resume-last|--resume|--resume-id <thread-id>|--fresh]
```

- [ ] **Step 7: Carry `resumeId` through foreground and background requests**

Change:

```js
function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  write,
  resumeLast,
  resumeId,
  jobId,
}) {
  return { cwd, model, effort, prompt, write, resumeLast, resumeId, jobId };
}
```

Pass `resumeId` into `buildTaskRequest` and the foreground `executeTaskRun` call. The worker already spreads the stored request; verify that path with the background test.

Treat either resume mode as resumed metadata:

```js
const isResume = Boolean(resumeLast || resumeId);
const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast: isResume });
```

Change `requireTaskRequest(prompt, resumeLast)` to `requireTaskRequest(prompt, isResume)` so a prompt may be omitted when either resume mode supplies a thread, retaining `DEFAULT_CONTINUE_PROMPT` behavior.

- [ ] **Step 8: Select the exact thread before App Server invocation**

In `executeTaskRun`:

```js
let resumeThreadId = request.resumeId ?? null;
if (!resumeThreadId && request.resumeLast) {
  const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
    excludeJobId: request.jobId,
  });
  if (!latestThread) {
    throw new Error("No previous Codex task thread was found for this repository.");
  }
  resumeThreadId = latestThread.id;
}
```

Do not check whether the exact ID appears in relay-tracked state and do not replace it with the latest thread. Let App Server report an unknown or inaccessible thread ID.

- [ ] **Step 9: Document exact-resume semantics at every relay boundary**

In `plugins/codex/commands/rescue.md`:

- add `--resume-id <thread-id>` to the argument hint;
- skip the resume-candidate question when it is present;
- pass it through to `codex-rescue`;
- skip automatic GPT-5.6 routing;
- send only the new user delta.

In `plugins/codex/agents/codex-rescue.md` and `codex-cli-runtime/SKILL.md`:

- map `--resume-id <thread-id>` directly to the runtime;
- keep it out of the prompt text;
- do not replace it with `--resume-last`;
- allow explicit model/effort overrides only.

In `README.md`, add foreground and background examples and state that `--resume-id` is mutually exclusive with latest-resume and fresh modes.

- [ ] **Step 10: Verify exact resume end to end**

```powershell
node --test --test-name-pattern "resume|model selection|reasoning effort|background" tests/runtime.test.mjs
node --test tests/commands.test.mjs
npm test
```

Expected result: focused commands exit 0, the full suite meets the platform gate in `Known Windows baseline`, latest-resume behavior remains unchanged, exact ID is preserved in foreground and background, and fresh routing is not applied to resumes.

- [ ] **Step 11: Commit deterministic resumption**

```powershell
git add plugins/codex/scripts/codex-companion.mjs plugins/codex/commands/rescue.md plugins/codex/agents/codex-rescue.md plugins/codex/skills/codex-cli-runtime/SKILL.md tests/runtime.test.mjs tests/commands.test.mjs README.md
git commit -m "feat: resume an explicit Codex thread"
```

---

## Task 7: Record Upstream Provenance and Cut Relay Version 1.1.6

**Interfaces**

- Consumes: upstream base tag `v1.0.6` at commit `db52e28` and the completed relay commits from Tasks 1-6.
- Produces: synchronized release metadata for `1.1.6` plus an auditable upstream-sync record.

**Files**

- Create: `UPSTREAM.md`
- Modify: `README.md`
- Modify: `plugins/codex/CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `plugins/codex/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Prove the recorded upstream base before writing provenance**

Run:

```powershell
git remote get-url upstream
git rev-parse "v1.0.6^{commit}"
git merge-base --is-ancestor db52e28 HEAD
```

Expected output:

- remote URL: `https://github.com/openai/codex-plugin-cc.git`;
- `v1.0.6` resolves to `db52e28`, allowing Git to print the full object ID;
- `merge-base --is-ancestor` exits 0.

- [ ] **Step 2: Create the upstream synchronization record**

Create `UPSTREAM.md`:

```markdown
# Upstream Synchronization

This repository is a compatibility-first relay fork of
https://github.com/openai/codex-plugin-cc.

- Upstream remote: `upstream`
- Upstream release: `v1.0.6`
- Upstream commit: `db52e28`
- Relay release based on it: `v1.1.6`
- Last synchronized: `2026-07-10`

## Sync procedure

1. Ensure `upstream` points to `https://github.com/openai/codex-plugin-cc.git`.
2. Run `git fetch upstream --tags`.
3. Review upstream release notes, issues, and pull requests for the target tag.
4. Merge the selected upstream tag into a dedicated synchronization branch.
5. Resolve conflicts while preserving relay policy in the internal routing and prompting skills.
6. Run `npm test`, `npm run check-version`, and `npm run build`.
7. Update this file with the new upstream tag, exact commit, relay mapping, and date.

The relay keeps the upstream Apache-2.0 license, plugin name, `/codex:*` namespace,
and Git history. `UPSTREAM.md` is authoritative for the exact upstream base.
```

- [ ] **Step 3: Update user-facing identity without breaking plugin compatibility**

In `README.md`:

- title the repository `Codex CC Relay Plugin`;
- state that it is built on `openai/codex-plugin-cc` and link to `UPSTREAM.md`;
- retain the plugin name `codex` and every existing `/codex:*` command;
- explain that the separate `fable-codex-workflow` project owns orchestration and workflow setup;
- document fresh-only GPT-5.6 routing, precedence, explicit-only `max`, and resume preservation;
- document the model-neutral prompt envelope at a behavioral level;
- do not invent an `origin` URL or publication/install coordinates that do not exist yet.

- [ ] **Step 4: Add a focused 1.1.6 changelog entry**

At the top of `plugins/codex/CHANGELOG.md`, add:

```markdown
## 1.1.6 - 2026-07-10

### Added

- Fable-owned GPT-5.6 routing for fresh rescue tasks.
- Model-neutral Codex prompt shaping.
- Read-only `codex-reviewer` agent.
- Exact `task --resume-id <thread-id>` support.

### Fixed

- Removed unsupported hook manifest metadata.
- Isolated test state from live Claude Code sessions.

### Compatibility

- Based on upstream `openai/codex-plugin-cc` v1.0.6 at `db52e28`.
- Preserves the `codex` plugin name, `/codex:*` commands, state format, and Apache-2.0 license.
```

Do not mention excluded issue/PR ideas as planned work.

- [ ] **Step 5: Bump every release manifest with the existing script**

Run:

```powershell
npm run bump-version -- 1.1.6
npm run check-version -- 1.1.6
```

Expected output ends with:

```text
All version metadata matches 1.1.6.
```

Inspect the diff and confirm only these version locations changed:

- `package.json`;
- root and `packages[""]` entries in `package-lock.json`;
- `plugins/codex/.claude-plugin/plugin.json`;
- metadata and plugin entries in `.claude-plugin/marketplace.json`.

- [ ] **Step 6: Run complete automated verification**

```powershell
npm test
npm run check-version -- 1.1.6
npm run build
git diff --check
```

Expected result: version, build, and diff checks exit 0. `npm test` meets the platform gate in `Known Windows baseline` and exits 0 in upstream Linux CI. The build regenerates App Server types through the existing `prebuild` step and passes TypeScript compilation.

- [ ] **Step 7: Perform bounded manual policy smoke checks**

In a local Claude Code session with this plugin loaded, invoke fresh `/codex:rescue` requests representing:

1. one-file mechanical change → `gpt-5.6-luna` / `low`;
2. normal bounded diagnosis → `gpt-5.6-terra` / `medium`;
3. broad cross-component work → `gpt-5.6-sol` / `high`;
4. architectural high-risk work → `gpt-5.6-sol` / `xhigh`.

Then verify:

- explicit model+effort remain unchanged;
- explicit model only fills effort;
- explicit effort only fills model;
- `--resume-id` preserves the supplied ID and does not reroute;
- `codex-reviewer` uses the native review path and does not write;
- foreground output contains no relay commentary.

Record observed model, effort, thread ID, and pass/fail for each case in the implementation session's final handoff. These observations are release evidence, not a new repository artifact.

- [ ] **Step 8: Audit scope against the approved specification**

```powershell
rg -n "concurrent|atomic write|computer-use|image-generation|plan-review|review-to-rescue|agent-tui" plugins tests README.md UPSTREAM.md
git diff v1.0.6...HEAD --stat
git status --short
```

Expected result:

- no new implementation or roadmap language for excluded features;
- the diff contains only the approved relay capabilities, tests, and documentation;
- no unrelated or generated scratch files are present.

- [ ] **Step 9: Commit release metadata and documentation**

```powershell
git add UPSTREAM.md README.md plugins/codex/CHANGELOG.md package.json package-lock.json plugins/codex/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: prepare relay release 1.1.6"
```

Do not tag or push until the user selects the repository remote and release workflow.

---

## Final Verification Checklist

- [ ] Focused Windows tests exit 0 and `npm test` introduces none beyond the six recorded upstream Windows failures.
- [ ] `npm test` exits 0 in upstream Linux CI.
- [ ] `npm run check-version -- 1.1.6` reports all metadata synchronized.
- [ ] `npm run build` exits 0.
- [ ] `git diff --check` exits 0.
- [ ] Fresh routing follows all four tiers and override precedence.
- [ ] Resumes skip automatic routing and preserve the exact or latest selected thread.
- [ ] Original fresh task text remains exact inside `<task>`.
- [ ] Prompting and routing policies reside in separate internal skills.
- [ ] Both agents perform one relay call and return foreground output verbatim.
- [ ] Reviewer paths are read-only and non-resumable.
- [ ] No excluded community proposal appears in code or roadmap language.
- [ ] `UPSTREAM.md` records `v1.0.6` / `db52e28` and relay `1.1.6`.
