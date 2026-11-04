---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--sandbox <read-only|workspace-write|danger-full-access>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--effort`, and `--sandbox` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.

Pre-flight questions (ask at most once):

The subagent cannot ask the user anything, so collect every open choice here and ask them together in a single `AskUserQuestion` call with one question per open choice. Skip the call entirely when nothing is open.

1. Thread choice:
   - If the request includes `--resume`, do not ask whether to continue. The user already chose.
   - If the request includes `--fresh`, do not ask whether to continue. The user already chose.
   - Otherwise, check for a resumable rescue thread from this Claude session by running:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
   ```

   - If that helper reports `available: true`, include a thread question with exactly these two choices:
     - `Continue current Codex thread`
     - `Start a new Codex thread`
   - If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
   - Otherwise put `Start a new Codex thread (Recommended)` first.
   - If the helper reports `available: false`, do not include the thread question.
2. Model: unless the request already names a model (`--model` or plain words such as "use spark" or "use gpt-5.4-mini"), include a model question with the choices `Codex default (Recommended)`, `gpt-5.4`, `gpt-5.4-mini`, and `spark`.
3. Reasoning effort: unless the request already names a concrete level (`--effort` or plain words such as "high effort"), include an effort question with the choices `Codex default (Recommended)`, `medium`, `high`, and `xhigh`. Other levels (`none`, `minimal`, `low`, `max`) stay reachable through the free-text answer.
4. Sandbox: unless the request already includes `--sandbox`, `--write`, or an explicit read-only / full-access instruction, include a sandbox question with these choices:
   - `workspace-write`: Codex may edit files inside the workspace; no network by default.
   - `read-only`: Codex can inspect but not change anything.
   - `danger-full-access`: no sandbox at all, including files outside the workspace and network. Only for trusted tasks.
   - Put `read-only (Recommended)` first when the request only asks for diagnosis, research, review, or a plan without edits. Otherwise put `workspace-write (Recommended)` first. Never mark `danger-full-access` as recommended.

- Skip the model, effort, and sandbox questions when the user says to use the defaults or not to ask.
- Applying the answers:
  - If the user chooses continue, add `--resume` before routing to the subagent.
  - If the user chooses a new thread, add `--fresh` before routing to the subagent.
  - `Codex default` means leave that flag unset so the user's Codex config decides.
  - Otherwise add `--model <choice>`, `--effort <choice>`, or `--sandbox <choice>` to the forwarded request. Map `spark` to `gpt-5.3-codex-spark`.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort or picks one in the pre-flight question.
- Leave the model unset unless the user explicitly asks for one or picks one in the pre-flight question. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Never add `--sandbox danger-full-access` unless the user explicitly asked for it or picked it in the pre-flight question.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
