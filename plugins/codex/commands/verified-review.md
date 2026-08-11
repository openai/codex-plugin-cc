---
description: Run a native Codex review, then independently verify every finding
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--check "<command>"]...'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a verified Codex review through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Safe input transport:
- Additional command context supplies `CODEX_VERIFIED_REVIEW_CAPTURE_ID=<uuid>` for these raw arguments. Treat that UUID as opaque.
- Before any execution, find one valid `CODEX_VERIFIED_REVIEW_CAPTURE_ID` UUID marker in that context. If it is absent or invalid, fail closed: do not invoke the companion and report that the verified review cannot safely access its captured input.
- Pass only `--captured-input "<uuid>"` to the companion. Never copy, interpolate, export, pipe, or otherwise place raw `$ARGUMENTS` in Bash, a template string, an environment variable, or stdin.

Core constraint:
- This command is review-only and read-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Run one native Codex review, then one fresh ephemeral read-only Codex verification turn.
- The verifier must classify every finding as `confirmed`, `false-positive`, `style-only`, or `unverified` and include its evidence.
- Return the command stdout verbatim to the user. Do not paraphrase, summarize, or add commentary before or after it.

Explicit check trust boundary:
- Each repeated `--check "<command>"` value is an explicit user-authorized shell command for the verification turn.
- Preserve each value exactly. Never invent, rewrite, expand, or add a default test, build, lint, or check command.
- Those commands run in the local repository through Codex's read-only verification sandbox. Treat their text as trusted user input: they can invoke arbitrary local programs available to Codex.
- Without `--check`, the verifier must not run validation commands; it may only inspect repository files and git state read-only.

Execution mode rules:
- If raw arguments include `--wait`, do not ask. Run in the foreground.
- If raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate review size before asking:
  - If raw arguments explicitly select a branch with `--base` or `--scope branch`, never run Bash to size that branch; recommend background.
  - For auto or working-tree review with no explicit branch selector, run only fixed, argument-free working-tree sizing commands: `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat`.
  - Never copy or interpolate a raw base or ref into Bash.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - If the working tree is clean, the companion will fall back to branch review, or the size is unclear, recommend background.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing it with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- The captured input preserves `--base`, `--scope`, every `--check`, `--wait`, and `--background` exactly.
- `/codex:verified-review` supports only auto, working-tree, and branch review scopes. It does not support staged-only review, unstaged-only review, or focus text.
- The companion reads the captured input and parses `--wait`, `--background`, and repeated `--check`; Claude Code's `Bash(..., run_in_background: true)` is what detaches this slash-command turn.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" verified-review --captured-input "<uuid>"
```
- Return stdout verbatim, exactly as-is.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" verified-review --captured-input "<uuid>"`,
  description: "Codex verified review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Codex verified review started in the background. Check `/codex:status` for progress."
