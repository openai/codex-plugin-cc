# Root `.superpowers` Ignore Design

**Status:** Approved for implementation planning

**Date:** 2026-07-10

## Goal

Keep local Superpowers workflow artifacts out of repository status and commits.

## Design

Add this root-anchored pattern to `.gitignore`:

```gitignore
/.superpowers/
```

The leading slash limits the rule to the repository-root `.superpowers` directory. It does not ignore a `.superpowers` directory inside a nested package or fixture.

## Scope

- Ignore every untracked artifact below the root `.superpowers` directory.
- Do not delete the local directory or its contents.
- Do not untrack files that were already committed.
- Do not change global Git excludes or ignore similarly named nested directories.

## Verification

- `git check-ignore -v .superpowers/sdd/progress.md` reports the new repository `.gitignore` rule.
- `git status --short` does not show root `.superpowers` artifacts.
- `git diff --check` passes.
