# Contributing

Thanks for taking the time to improve the Codex plugin for Claude Code. This repository is small, but it has a few moving parts: Claude Code plugin metadata, slash-command prompts, Node.js runtime scripts, generated Codex app-server types, and tests that exercise the whole flow.

## Development Setup

Use Node.js 18.18 or later.

Install dependencies:

```bash
npm ci
```

Some build steps use the `codex` binary to generate app-server type definitions. If you plan to run the build locally, install Codex too:

```bash
npm install -g @openai/codex
```

You do not need to be logged in to Codex for the unit tests. Runtime behavior that would normally call Codex is covered with fixtures.

## Repository Layout

- `plugins/codex/commands/` contains the Claude Code slash-command definitions.
- `plugins/codex/agents/` contains the rescue subagent definition.
- `plugins/codex/skills/` contains helper skills used by the plugin and subagent.
- `plugins/codex/scripts/` contains the Node.js runtime entrypoints and supporting libraries.
- `plugins/codex/hooks/` contains Claude Code lifecycle hook configuration.
- `tests/` contains Node test-runner coverage for command definitions, runtime behavior, rendering, state, git targeting, and process management.
- `scripts/bump-version.mjs` keeps package and plugin release metadata in sync.

## Common Commands

Run the full test suite:

```bash
npm test
```

Run the type/build check:

```bash
npm run build
```

Check that version metadata is synchronized across package and plugin manifests:

```bash
npm run check-version
```

Bump release metadata:

```bash
npm run bump-version -- 1.0.7
```

## Testing Notes

The full test suite intentionally covers background jobs, app-server broker behavior, hook behavior, and mocked Codex runs. It can take a few minutes locally.

When changing runtime behavior, add or update tests near the behavior being changed:

- command prompt/metadata changes usually belong in `tests/commands.test.mjs`
- review target and diff collection changes usually belong in `tests/git.test.mjs`
- rendering changes usually belong in `tests/render.test.mjs`
- state and job lifecycle changes usually belong in `tests/state.test.mjs` or `tests/runtime.test.mjs`

## Generated Types

`npm run build` runs `prebuild`, which creates `plugins/codex/.generated/app-server-types` by calling:

```bash
codex app-server generate-ts --out plugins/codex/.generated/app-server-types
```

The checked-in source imports those generated types through `plugins/codex/scripts/lib/app-server-protocol.d.ts`. If the Codex app-server protocol changes, regenerate the types and run the test suite before opening a PR.

## Release Metadata

Version values are stored in multiple places:

- `package.json`
- `package-lock.json`
- `plugins/codex/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

Use `npm run bump-version -- <version>` rather than editing these by hand, then run `npm run check-version`.

## Pull Request Checklist

Before opening a PR, please run:

```bash
npm test
npm run check-version
```

Also run `npm run build` when you touch app-server integration code, generated types, or files covered by `tsconfig.app-server.json`.
