---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
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
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

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
' task-resume-candidate --json
```

Use that resolver exactly: a valid, non-empty `CLAUDE_PLUGIN_ROOT` is the fast path; otherwise read only `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json` and require exactly one valid record under the exact `codex@openai-codex` key. Each valid record must have an `installPath` containing a readable regular `scripts/codex-companion.mjs`. An unreadable or malformed registry, a missing key, or zero or multiple valid records must fail before companion execution. Never glob plugin caches or versions, and never use `eval`. Keep routed arguments after the inline script, inherit child stdio, and propagate its exact exit status.

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call, run the same fail-closed Node bootstrap used by the resume preflight with routed `task` arguments after the inline script, invoke the companion task exactly once, and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
