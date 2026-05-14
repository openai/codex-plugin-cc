# ADR 0002: Opt-in `review` / `adversarial-review` subagents with invoker tagging

- Status: Accepted
- Date: 2026-05-13
- Linked issue: <https://github.com/zackey-heuristics/codex-plugin-cc-devcontainer/issues/3>

## Context

`/codex:rescue` is exposed both as a slash command and as the
`codex:codex-rescue` subagent. `/codex:review` and
`/codex:adversarial-review` are slash-command-only and locked with
`disable-model-invocation: true`, so Claude cannot autonomously invoke
them. The asymmetry is intentional: rescue is an *inward* call (Claude
asking Codex for help) and should be proactively usable; review is an
*outward* verification step (the user checking Claude's output) and
should be user-initiated to avoid silent Codex spend during routine
work.

That asymmetry, however, blocks legitimate power-user automation —
`Stop` hooks that fire a review before report-as-done, agent loops that
self-correct, scheduled reviews. The only programmatic alternative
today is invoking `node codex-companion.mjs <review|adversarial-review>`
via Bash with an absolute script path, because `CLAUDE_PLUGIN_ROOT` is
injected only when Bash is launched from a slash command. That works
for plugin developers but is non-portable for plugin users installed
via marketplace.

We want a path for Claude to programmatically invoke review subcommands
that preserves the safety properties of the current
`disable-model-invocation: true` design: framing is not eroded, the
verbatim-return contract is not silently relaxed, and Claude-driven
invocations remain visible and (optionally) bounded.

## Decision

1. **Opt-in subagent registration through `/codex:setup`.**

   `handleSetup` learns two new flags, mirroring the existing
   `--enable-review-gate` / `--disable-review-gate` pattern:

   - `--enable-review-subagents` — materializes
     `plugins/codex/agents/codex-review.md` and
     `plugins/codex/agents/codex-adversarial-review.md` from templates,
     and `setup --json` derives `reviewSubagentsEnabled` from the
     filesystem via a non-throwing existence + provenance-marker check
     on both target files (`areReviewSubagentsMaterialized`).
   - `--disable-review-subagents` — removes the two materialized files,
     which causes the same filesystem-derived check to report
     `reviewSubagentsEnabled: false`. Never touches `codex-rescue.md`.

   `setup --json` exposes `reviewSubagentsEnabled` so callers can see
   the current state. Setup output explicitly notes that
   `/reload-plugins` is required to pick up registration changes in the
   current Claude Code session. Default is **disabled** — users must
   opt in.

2. **Template files live next to the materializer, not next to other
   prompts.**

   Source of truth is
   `plugins/codex/scripts/lib/agent-templates/codex-review.md` and
   `codex-adversarial-review.md`. They are static .md files (no
   `{{VAR}}` interpolation — unlike Codex turn prompts under
   `plugins/codex/prompts/`). The materialized destinations under
   `plugins/codex/agents/` are added to `.gitignore`. This keeps the
   repository's tracked state describing what *can* be installed,
   while the actual installation state is local to each plugin
   instance.

3. **Subagent bodies preserve the slash-command contract mechanically,
   not just by convention.**

   Each materialized subagent declares `tools: Bash` only. The
   subagent cannot use `Read`, `Glob`, `Grep`, or `Edit`, so it cannot
   pre-read files and paraphrase Codex's findings against them — the
   verbatim-return contract is enforced by what the subagent can
   physically do, not by prose alone. The body further requires:

   - Frontmatter `description` starts with `"Use ONLY when explicitly
     asked …"` (not the `"Proactively use …"` wording used by
     `codex-rescue.md`). This shapes Claude's selection behavior so
     the subagent is never fired as a self-directed "while I'm at it"
     check.
   - Exactly one Bash call of the form
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"
     <review|adversarial-review> --invoker claude-subagent <user args>`.
   - Return Codex's stdout verbatim. No commentary before or after.
   - Foreground only — `--background` is forbidden in the template.

   For `codex-adversarial-review`, the body additionally instructs:
   when the user's focus text is generic ("review this"), append a
   clarifier so Codex challenges design decisions rather than only
   hunting defects. The subagent may rephrase the focus text for
   adversarial framing, but it may not inspect the repository to do so.

4. **`--invoker` flag on `review` and `adversarial-review`.**

   `handleReviewCommand` learns a `--invoker` value option. The
   allowlist is pinned in a new module and shared by parser and
   contract tests:

   ```js
   // plugins/codex/scripts/lib/invoker.mjs
   export const INVOKER_VALUES = [
     "user-slash",
     "claude-subagent",
     "claude-bash",
     "hook"
   ];
   ```

   Unknown values throw. Default is `"user-slash"` — existing
   user-typed `/codex:review` and developer Bash invocations are
   unaffected. The new subagents pass `--invoker claude-subagent`. The
   invoker is persisted on the job record via the existing
   `upsertJob` / `createJobRecord` plumbing.

5. **Status surfaces the invoker per-job and in aggregate.**

   `lib/job-control.mjs#buildStatusSnapshot` extends its payload with
   `reviewInvokerBreakdown` (per-invoker counts within a recent
   window for `jobClass === "review"`).
   `lib/render.mjs#appendActiveJobsTable` adds an `Invoker` column,
   `pushJobDetails` emits an `Invoker:` line, and `renderStatusReport`
   prints the aggregate as a single line. JSON output exposes both per
   job and aggregate.

6. **Optional env-configured rate limit.**

   `CODEX_PLUGIN_REVIEW_RATE_LIMIT` accepts the format `N/Xmin`
   (e.g. `3/15min`). When set, `handleReviewCommand` refuses non-
   `user-slash` invocations that would exceed the budget, with a
   clear error message pointing at `/codex:adversarial-review` for
   explicit user-driven runs. `user-slash` invocations are **never**
   rate-limited.

   The check is implemented as `parseReviewRateLimit(envValue)` +
   `enforceReviewRateLimit({workspaceRoot, invoker, env, now})` in a
   dedicated `plugins/codex/scripts/lib/review-rate-limit.mjs` and
   wired in *before* `createCompanionJob` so refusal does not pollute
   the jobs list with stubbed records. Default is **off** — no rate
   limit unless the env var is set.

7. **Slash commands stay as they are.**

   `commands/review.md`, `commands/adversarial-review.md`,
   `commands/status.md`, `commands/result.md`, `commands/cancel.md`
   retain `disable-model-invocation: true`. The new subagent path is
   *additive* and *opt-in*; it does not weaken the existing
   model-invocation guard on the slash commands themselves.

## Consequences

**Positive**

- Power-user automation paths (`Stop` hook, agent loops, scheduled
  reviews) become possible without rewriting slash commands or
  exposing the `SlashCommand` tool to the model.
- Verbatim-return and adversarial framing are mechanically enforced
  via `tools: Bash` plus the foreground-only contract. The subagent
  cannot paraphrase findings against files it has read because it
  cannot read files.
- Claude-driven Codex invocations become *visible* (per-job invoker
  line + aggregate breakdown in `/codex:status`) and *bounded*
  (`CODEX_PLUGIN_REVIEW_RATE_LIMIT`). Cost overrun is a configuration
  choice, not an invisible default.
- `--invoker` is also a useful audit field for future analyses —
  "how many reviews were user-initiated vs hook-initiated last week"
  becomes greppable.
- Enabling or disabling in one workspace is immediately reflected by
  `setup --json` in every workspace because the materialized files are
  the single source of truth, matching where Claude Code actually
  reads them.

**Negative / risk**

- `--invoker` is self-reported. A misbehaving caller can pass
  `--invoker user-slash` to escape the rate limit. Accepted: the
  spoofer is only harming their own billing / log integrity, not a
  third party. A future improvement could route a subagent-issued
  identifier through a separate channel; out of scope here.
- The review rate limit is a soft budget, not a hard quota. Concurrent
  non-`user-slash` starts can race the non-atomic check and both pass;
  adding a state-directory lock is accepted as out of scope for this
  opt-in, disabled-by-default feature.
- Plugin reinstall wipes the materialized `agents/codex-review.md` and
  `agents/codex-adversarial-review.md` because they live under the
  install dir. Mitigation: `setup --enable-review-subagents` is
  idempotent; re-running it after an install restores the files.
- Toggling subagent state mid-session requires `/reload-plugins` —
  Claude Code only walks `agents/*.md` at plugin load. The setup
  output documents this requirement.
- The `claude-bash` invoker value is the most slippery: anything that
  shells out to `codex-companion.mjs` with no flag passed gets
  charged to `user-slash` by default. Tooling that wants to be
  honest about its source should pass `--invoker hook` or
  `--invoker claude-bash` explicitly.

**Out of scope**

- Removing or weakening `disable-model-invocation: true` on the
  slash commands. The slash command surface remains the
  user-explicit path.
- Subagent registration for `status`, `result`, `cancel`, `task`. The
  rescue subagent already covers write-capable Codex work; the
  display/control subcommands have no need to be invoked indirectly.
- Hard authentication on the `--invoker` value (spoofing is accepted
  per above).
- Changing the default state from disabled to enabled. The whole
  design rests on opt-in; future versions can revisit if usage data
  warrants it.
