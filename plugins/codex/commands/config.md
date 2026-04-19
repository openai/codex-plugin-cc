---
description: Read and write Codex configuration interactively without editing TOML by hand
argument-hint: '[--get [key]] [--set <key> <value>] [--reset <key>] [--list] [--scope user|project]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Read or update Codex configuration through the companion config manager.

## Behaviour

With no arguments, show all current config values and offer to change them interactively.

With `--list`, show all known config keys, their current values, and allowed values.

With `--get <key>`, print the current value of a single key.

With `--set <key> <value>`, update a single key.

With `--reset <key>`, remove a key from the config file (restores Codex default).

With `--scope user`, target `~/.codex/config.toml` (user-level). Default is `project` (`.codex/config.toml` in the current repo).

## Interactive flow (no arguments)

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" config --list --json
```

Parse the JSON output to get the current config and known keys.

Then use `AskUserQuestion` to ask which setting the user wants to change. Build a list of options from the keys returned, plus `Done — no changes`. Put `Done — no changes` last.

For each key the user picks, use a second `AskUserQuestion` with the allowed values for that key (or ask them to type a value if it is a free-form string).

After the user makes a choice, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" config --set <key> <value> $ARGUMENTS
```

Continue offering changes until the user picks `Done — no changes`.

## Non-interactive flow (flags provided)

Run directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" config $ARGUMENTS
```

Present the output to the user verbatim.

## Output rules

- After any change, confirm what was written and to which file.
- Show the full resolved path of the config file that was modified.
- Do not edit config files directly. Always delegate to the companion script.
