# Launcher Snapshot

This directory mirrors the local `~/bin/cc-*` Claude Code wrappers and their provider-specific appended prompts.

It intentionally excludes:

- API keys and shell profiles
- `~/.claude-envs/*/opt/node_modules`
- Claude Code session data, caches, and plugin state

## Install

```bash
./launchers/install.sh
```

To also install the pinned Claude Code package into each provider environment:

```bash
./launchers/install.sh --install-claude-code
```

The launcher scripts expect provider keys in your shell environment, for example `KIMI_API_KEY`, `DASHSCOPE_API_KEY`, `GLM_API_KEY` or `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `ARK_API_KEY`, `MINIMAX_API_KEY`, `MIMO_API_KEY`, `STEPFUN_API_KEY`, and `LONGCAT_API_KEY`.

## Verify

```bash
./launchers/verify.sh
cc-models doctor
```
