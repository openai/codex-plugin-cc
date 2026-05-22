## Context

`/codex:observe` is a Claude Code slash command that wraps the CLI `observe` subcommand. It lives at `plugins/codex/commands/observe.md`. The CLI subcommand itself (defined in `plugins/codex/scripts/lib/observe.mjs`, dispatched from `codex-companion.mjs`) is a long-running live tail: it watches the per-job JSONL event stream, renders ANSI-colored events as they arrive, and only exits on `COMPLETED` or `SIGINT`.

The slash-command file currently has two intentions stacked together:

1. **Primary path** (lines 8–36): static prose telling the user to open a **new terminal** and paste a copy-paste command. This is the correct UX — live tail needs a real TTY and indefinite uptime.
2. **Inline fallback** (lines 38–48): an "if you want inline" affordance using Claude Code's `` !`...` `` exec block on line 40, plus model-facing prose ("Present the command output to the user…") on lines 42–48.

The inline fallback is structurally broken. Claude Code's `!exec` blocks capture stdout **after the child process exits**; they do not stream. A non-terminating `tail` process therefore stalls the entire slash-command body assembly — including the static guidance prose that precedes it. The user observes "no output" because the slash command never finishes rendering.

Compare to the working siblings (`cancel.md`, `result.md`, `status.md`): their `!exec` blocks invoke one-shot CLI calls that read state, write to stdout, and exit. Those are compatible with Claude Code's exec model. `observe.md` is the only file in the directory whose exec is long-running.

Stakeholders: any user who types `/codex:observe` in Claude Code (the primary surface).

## Goals / Non-Goals

**Goals:**
- Restore `/codex:observe`'s visible output: when invoked, the user sees clear instructions for running the live observer in a separate terminal.
- Eliminate the structural conflict between the slash-command exec model and a long-running tail process.
- Keep the change minimal — single file, deletions only, no behavior changes to CLI / observer logic / hooks / tests.

**Non-Goals:**
- Adding a non-blocking "snapshot" mode to the `observe` subcommand (alternative B in the exploration). Out of scope for this fix; tracked separately if user demand emerges.
- Changing how the CLI `observe` subcommand itself behaves. `observe.mjs` is untouched.
- Modifying the `observe-command` spec from the still-active `codex-live-observer` change. That spec covers CLI behavior, which is unchanged.
- Reworking how Claude Code renders `disable-model-invocation: true` commands. We work within the existing semantics.

## Decisions

### Decision 1: Remove the inline `!exec` fallback entirely (option A from exploration)

Rationale: The fallback never worked for the most common case (live, in-progress job). Even in the edge case where a job is already completed at exec time (one of the three branches of `handleObserveCommand`), the inline output would contain ANSI cursor-control codes (`\x1b[1A\x1b[2K`) that render as garbage in a non-TTY context, and the value of viewing a *historical* event dump inline is marginal — the user can already get this via `/codex:result` or by tailing the JSONL file directly. Stripping the broken affordance is cleaner than gating it on job status, and it removes the entire surface area where a future similarly-shaped bug could regress.

Alternatives considered:
- **Option B — add `--snapshot` flag to `observe` CLI** and have the slash command use it. Preserves inline value, but conflates two semantically distinct operations (live tail vs. snapshot dump) under one subcommand name. If snapshot mode is genuinely valuable, it should be a separate subcommand (`events`, `recent`) — not bolted onto `observe`. Out of scope here.
- **Option C — keep the prose but remove `disable-model-invocation` and let the model render guidance.** Adds latency and token cost for what should be an instantaneous static response. The current `disable-model-invocation: true` is correct for this command type; the bug is the exec block, not the directive.

### Decision 2: Introduce a new capability `observe-slash-command`, not modify `observe-command`

Rationale: The CLI subcommand (`observe-command` capability, currently defined in the unarchived `codex-live-observer` change) and the slash-command wrapper are two distinct surfaces with separate contracts. The CLI behavior is unchanged; only the slash-command body is. Adding requirements to `observe-command` would conflate them. A separate capability also captures a generalizable rule — **slash command bodies MUST NOT contain inline executions of long-running processes** — that other future slash commands will benefit from.

Alternatives considered:
- **Treat as pure bugfix with no spec change.** Loses the chance to encode the structural constraint that caused the bug. Likely to be re-violated by some future contributor adding another inline exec.
- **Add a delta to `observe-command`.** Conflates CLI and wrapper concerns; also awkward since `observe-command` is not yet in `openspec/specs/` (its parent change isn't archived).

### Decision 3: No test added

Rationale: The slash command body is a markdown file consumed by Claude Code's runtime, not by code in this repo. There is no test harness that exercises slash-command body rendering. A README-style "what the user sees" assertion would require mocking the entire Claude Code slash runtime, which is out of scope for a deletion-only fix. The existing `tests/observe.test.mjs` covers `observe.mjs` event reading and rendering — those code paths are untouched, and the existing tests should continue to pass unchanged.

Verification will be manual: after the change, run `/codex:observe` in Claude Code with (a) no running job, (b) a running job, (c) a completed job, and confirm the same guidance text renders immediately in all three cases (because the body is now static).

## Risks / Trade-offs

- **[Risk] A user who liked the inline fallback (for completed jobs) loses it.** → Mitigation: the inline fallback was already broken for the dominant case (live tail). For completed jobs, `/codex:result` or directly tailing the JSONL file are existing alternatives. Acceptable loss.
- **[Risk] Future slash commands could re-introduce inline `!exec` of long-running processes.** → Mitigation: the new `observe-slash-command` capability spec records the structural rule explicitly. Anyone proposing a similar pattern will see the contract.
- **[Trade-off] No design-level fix for "inline live observation inside Claude Code."** → Accepted: this is an inherent limitation of Claude Code's slash-exec model, not something a markdown-file change can solve. If genuinely needed, it would require a streaming hook or a separate UI surface — both far outside this change's scope.

## Migration Plan

- No data migration. No config migration. No user action required.
- Rollback: revert the single file change. The pre-change state is the (broken) status quo.
