# PR Review Identity and Routing Design

**Status:** Approved for implementation

**Date:** 2026-07-10

**Applies to:** Draft PR #1

## Purpose

Address the two unresolved review threads by giving the relay its own plugin identity and expanding GPT-5.6 routing into a maintainable referenced policy bundle.

This design supersedes earlier statements that the relay preserves the upstream `codex` plugin name and `/codex:*` namespace. It does not change the upstream ancestry, Apache-2.0 license, runtime state format, or relay feature scope.

## Identity

Use these exact values:

| Surface | Value |
| --- | --- |
| Marketplace name | `codex-cc-relay` |
| Marketplace owner | `hotaru-ritsuki` |
| Plugin manifest name | `codex-relay` |
| Plugin author | `hotaru-ritsuki` |
| Slash-command namespace | `/codex-relay:*` |
| Agent and skill namespace | `codex-relay:*` |
| Private package name | `@hotaru-ritsuki/codex-cc-relay-plugin` |
| Physical plugin directory | `plugins/codex` |

The old `/codex:*` and `codex:*` namespaces are removed rather than retained as aliases. The folder remains `plugins/codex` because its path is an internal repository detail and renaming it would add churn without changing the installed identity.

Every user-facing command example, runtime hint, agent/skill reference, test contract, manifest, package-lock entry, changelog statement, and active design statement must use the new identity. References to the upstream repository and the separately installed `@openai/codex` CLI remain unchanged.

The relay remains at version `1.1.6` because this identity correction is part of the same unreleased draft.

## GPT-5.6 Routing Bundle

Keep `plugins/codex/skills/gpt-5-6-routing/SKILL.md` as a concise internal entry point and add:

- `references/complexity-rubric.md`: task breadth, ambiguity, exploration, diagnosis depth, reversibility, risk, verification burden, autonomy, and tier-boundary rules. It defines task classes but does not map them to model names.
- `references/model-effort-policy.md`: the authoritative Luna/Terra/Sol and effort mapping, explicit override precedence, resume preservation, higher-tier ambiguity rule, explicit-only `max`, invalid `ultra`, and leave-unset fallback.
- `references/routing-examples.md`: concrete small, normal, broad, high-risk, partial-override, resume, ambiguous-boundary, and insufficient-context examples.

`SKILL.md` must tell the caller to read the rubric and policy before routing. The examples are consulted when a classification boundary is unclear. This preserves progressive disclosure while ensuring the decision is grounded in the complete policy.

Routing remains fresh-task only and Fable-owned. No classification logic, model catalog query, dynamic validation, fallback model substitution, or model-application change enters the Node runtime.

## Compatibility and Documentation

- Preserve upstream Git history, exact base provenance, Apache-2.0 license, runtime behavior, state schema, commands, and features.
- Rename only installed identity and namespaced references; do not rename individual command files or agent files.
- Update installation examples to the `hotaru-ritsuki/codex-cc-relay-plugin` repository and `codex-cc-relay` marketplace.
- Update the existing relay design and provenance text so it no longer claims that the upstream plugin name is preserved.
- Keep the original implementation plan as a historical execution record; the present addendum is authoritative for the review-driven rename.

## Validation

- Tests parse both manifests and assert every exact identity value.
- The version bump script locates the renamed `codex-relay` marketplace entry and its tests use the new package/plugin identities.
- Command contracts require `/codex-relay:*` and `codex-relay:*` throughout active plugin files and README examples.
- Routing tests require all three reference files, verify that `SKILL.md` links them, and pin each reference's responsibility and approved behavior.
- A stale-identity scan permits upstream repository and `@openai/codex` CLI references but rejects active `/codex:*`, `codex:*`, `openai-codex`, `@openai/codex-plugin-cc`, and OpenAI author metadata.
- Focused tests, version checks, TypeScript compilation, and `git diff --check` must pass. The documented upstream Windows aggregate failures remain outside this review fix.

## GitHub Review Handling

Implementation and tests will address both unresolved review threads. GitHub replies and thread resolution are separate external writes and will occur only after explicit user authorization.
