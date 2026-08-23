---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper (put the routed arguments after the inline script):

```bash
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const scriptFor = root => path.join(root, "scripts", "codex-companion.mjs");
  const validRoot = root => {
    if (!root) return false;
    const script = scriptFor(root);
    try {
      if (!fs.statSync(script).isFile()) return false;
      fs.accessSync(script, fs.constants.R_OK);
      return true;
    } catch { return false; }
  };
  let roots = validRoot(process.env.CLAUDE_PLUGIN_ROOT) ? [process.env.CLAUDE_PLUGIN_ROOT] : [];
  if (roots.length === 0) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || (process.env.HOME && path.join(process.env.HOME, ".claude"));
    if (!configDir) process.exit(1);
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"));
      const records = registry && registry.version === 2 && registry.plugins && registry.plugins["codex@openai-codex"];
      roots = Array.isArray(records) ? records.map(record => record && record.installPath).filter(validRoot) : [];
    } catch { process.exit(1); }
  }
  if (roots.length !== 1) process.exit(1);
  const result = spawnSync(process.execPath, [scriptFor(roots[0]), ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
' task ...
```

Resolver rules:
- Keep the resolver and companion execution in the one allowed Bash call, with exactly one `task` invocation.
- A valid, non-empty `CLAUDE_PLUGIN_ROOT` is the fast path. Otherwise read only `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json`, select the exact `codex@openai-codex` key, and require exactly one record whose `installPath` contains a readable regular `scripts/codex-companion.mjs`.
- An unreadable or malformed registry, a missing key, or zero or multiple valid records must fail before companion execution. Never glob plugin caches or versions, and never use `eval`.
- Keep routed arguments after the inline script. Forward them with `process.argv.slice(1)`, inherit child stdio, and propagate its exact exit status.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
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
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.
