# `/codex:test` Design Notes

This note summarizes the stable design constraints behind `/codex:test`.
It is intended for maintainers who need to evolve the test-planning pipeline
without re-learning the failure modes from past review cycles.

A useful review question for this command is: "Could uncertainty here cause
`/codex:test` to write tests in the wrong place, or collect the wrong context?"
Most of the constraints below exist to keep the answer to that question "no."

## Core Principles

1. Fail closed when required context is missing.

`/codex:test` should stop rather than guess when it cannot gather enough
repository context. Missing project guidance, missing test layout, or missing
test targets should be treated as hard failures instead of soft fallbacks.
When uncertainty would otherwise push the command toward the wrong context or
the wrong target file, failing closed is the intended behavior.

2. Keep repository context inside the repository boundary.

Repo walking must not escape `repoRoot`. Symlinked directories are skipped,
and symlinked files are only eligible when their realpath still stays under
the repository root. This prevents unrelated files or host secrets from being
pulled into the prompt.

3. Bound the prompt budget globally, not only per file.

Project guidance is useful, but unbounded guidance collection makes `/codex:test`
fragile in monorepos. Guidance files are prioritized and then capped by both a
small file-count limit and a total byte budget, with shallow high-priority files
winning over deep package-local READMEs.

4. Treat self-collected diff context as a first-class mode.

When the diff is too large to inline, the prompt must still tell Codex how to
collect the missing patch context with read-only git commands. Large changes
should degrade to a lighter summary, not to silent loss of guidance.

5. Only infer tests from live source files.

Changed-path lists can include deleted files. Deletion-only changes should not
cause `/codex:test` to propose creating brand-new tests for removed code, so
planning must ignore source paths that no longer exist in the working tree.

## Test Target Selection

1. Prefer the nearest package-local test root.

In monorepos, test planning should stay inside the package or module that owns
the changed source file. When a direct match is missing, new test targets should
be created under the nearest compatible test root instead of the first `tests/`
directory discovered anywhere in the repository. If no detected test root
actually belongs to the changed source's package, `/codex:test` should fail
closed instead of selecting the closest-looking package by shared path prefix.

2. Scope direct matches by locality, not basename alone.

Two packages can legitimately contain the same test basename such as
`id.test.js`. Basename matches are only safe after they have been narrowed to
the nearest package-local test root. Otherwise `/codex:test` may edit tests in
an unrelated package.

3. Preserve source subdirectories in created test paths.

When a new test file is created, the path should preserve the source structure
after the language-specific source root. For example:

- `src/pkg/foo.py -> tests/pkg/test_foo.py`
- `packages/b/src/new.js -> packages/b/tests/new.test.js`

Flattening nested paths causes collisions across modules with the same stem and
makes the planned test target drift away from the changed code.

4. Match existing tests conservatively.

Substring-based matching is too loose. `id` should not match `userid.test.js`,
and similarly named files in sibling packages should not be pulled into the same
plan. Matching should optimize for "smallest safe target set", even if that
means falling back to creating a new test file more often.

## Maintenance Notes

- If you loosen repo-walk or symlink behavior, add tests that prove prompt
  inputs still stay under `repoRoot`.
- If you change guidance selection, keep both a file-count cap and a total-byte
  cap unless there is a stronger replacement.
- If you change path inference, add monorepo fixtures that cover both direct
  matches and create-path planning.
- If you change diff collection, verify both inline-diff and self-collect modes.
