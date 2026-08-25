# Changelog

## Unreleased

- Add read-only Claude-native Multi-Codex orchestration with durable status, results, cancellation, adaptive budgets, and bounded parallel workers.

## 1.0.7-eureka.2

- Added GPT-5.6 Sol, Terra, and Luna model/effort support based on the current Codex model catalog.
- Added `max` and `ultra` transport support for task and review flows.
- Refreshed stale shared brokers when the plugin or Codex CLI runtime changes while preserving active work and cancellation.
- Added model and effort selection to normal and adversarial review commands.
- Replaced generation-pinned rescue guidance with the version-neutral `codex-prompting` skill.
- Removed the deprecated generation-specific prompting alias and examples.
- Removed the obsolete lowest reasoning-effort alias from commands and runtime validation.
- Remapped the `spark` alias to `gpt-5.6-luna`.
- Identified this fork build separately from upstream plugin releases.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
