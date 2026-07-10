---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--resume-id <thread-id>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent, Skill
---

Invoke the `codex-relay:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex-relay:codex-rescue"`), forwarding the prompt prepared in the main Claude context.
`codex-relay:codex-rescue` is a subagent, not a skill — do not call `Skill(codex-relay:codex-rescue)` (no such skill) or `Skill(codex-relay:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex-relay:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex-relay:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, `--resume-last`, or `--resume-id`, do not ask whether to continue. The user already chose a resumed routing mode.
- Skip the `task-resume-candidate` check entirely when the request includes `--resume-id <thread-id>`.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Routing and prompt flow:

Parse any user-supplied model and effort as explicit runtime overrides without changing them. If they ask for `spark`, map it to `gpt-5.3-codex-spark`; this documented alias is the sole normalization. Accepted effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `max` is explicit-only and `ultra` is not a valid effort value.

## Resume flow

Handle the resume flow before the fresh flow. A request is resumed when it includes `--resume`, `--resume-last`, or `--resume-id <thread-id>`, or when the user chooses `Continue current Codex thread`.

- For resume work, do not load or apply `codex-relay:gpt-5-6-routing`.
- Skip automatic GPT-5.6 routing when `--resume-id <thread-id>` is present.
- Preserve the thread's original model and effort defaults by passing only explicit user overrides. Never fill a missing model or effort for a resume.
- Pass only the user's new delta or correction. Do not repeat the original task or previously supplied context.
- For `--resume-id`, send only the new delta to the exact supplied thread ID.
- Invoke `codex-relay:codex-rescue` with the resume routing flag, delta prompt, and any explicit model or effort values.

## Fresh flow

A request is fresh when it includes `--fresh`, the user chooses `Start a new Codex thread`, or no resumable thread is available.

1. Parse the explicit model and effort without changing them (apart from the documented `spark` alias).
2. When both model and effort are explicit, forward both unchanged; do not load or apply `codex-relay:gpt-5-6-routing`; do not classify the task. Continue at step 6.
3. Otherwise, load `codex-relay:gpt-5-6-routing` with the `Skill` tool and apply it only to missing routing values.
4. Classify the task in the main Claude/Fable context. When the fresh task is ambiguous or falls between tiers, select the higher tier.
5. Fill only missing routing values:
   - Explicit model only: preserve the model and select only the effort.
   - Explicit effort only: preserve the effort and select only the model.
   - Neither explicit: select both.
   - If Fable cannot decide a missing value, leave that value unset so the upstream runtime default applies.
6. Load `codex-relay:codex-prompting` in the main Claude context and shape the implementation prompt according to that skill.
7. Invoke `codex-relay:codex-rescue` with the resolved prompt and resolved optional model and effort overrides.

Preserve the user's original request exactly inside `<task>`; do not ask the rescue subagent to rewrite or reshape it. Add optional scope, success, evidence, or final-response blocks only when the main context already has concrete supporting information.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex-relay:status`, fetch `/codex-relay:result`, call `/codex-relay:cancel`, summarize output, or do follow-up work of its own.
- Leave `--resume`, `--resume-id <thread-id>`, and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex-relay:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
