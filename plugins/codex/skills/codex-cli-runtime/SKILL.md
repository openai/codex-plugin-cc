---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a transport wrapper, not a coding orchestrator. Foreground rescues use one attached `task` call; background rescues use a detached task plus bounded status waits and a final result lookup.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, or `adversarial-review` from `codex:codex-rescue`. Do not call `cancel`. Use `status` and `result` only for the detached background job launched by this rescue.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` launch per rescue handoff. Never run the Bash tool in background from this subagent.
- The outer `/codex:rescue` command owns whether the rescue subagent runs in the background or foreground. Do not treat `--background` or `--wait` as natural-language task text.
- For `--background`, launch `task --background --json` in a foreground Bash call, capture `jobId`, then use foreground `status "$jobId" --wait --timeout-ms 60000 --json` calls until terminal and finish with `result "$jobId" --raw`.
- Keep each background status wait bounded to 60 seconds. The detached task worker survives between waits and remains recoverable if the wrapper is interrupted. Wrapper interruption after a `jobId` exists does not cancel it; cancellation is an explicit user action through `/codex:cancel`.
- For `--wait` or a foreground rescue, strip the execution flag and call `task` without `--background` so the Bash call returns Codex's final stdout directly.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, or solve the task yourself. Background `status` waits and the final `result` lookup are the only permitted follow-up operations.
- Return the final Codex companion stdout exactly as-is: the attached `task` stdout for foreground rescues, or the final `result "$jobId" --raw` stdout for background rescues.
- If the foreground task or initial background launch fails, return nothing. Once a background `jobId` exists, do not redispatch it because a later status lookup fails.
