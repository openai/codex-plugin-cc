# Changelog

## 1.0.9

- Preserve the built-in `:workspace` safeguards for scoped write tasks and require the approved read roots to cover the workspace.

## 1.0.8

- Require every `--read-root` to be an existing directory so scoped tasks do not claim unsupported file-level isolation on macOS.

## 1.0.7

- Add opt-in `--read-root` enforcement for Codex rescue tasks using request-scoped permission profiles.
- Preserve scoped roots across foreground, background, and resumed tasks, with fail-closed runtime compatibility errors.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
