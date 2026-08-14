---
name: codex-image-gen
description: Generate raster image assets (logo concepts, illustrations, icons, OG images, textures, placeholder art) via the Codex CLI's native image generation. Use whenever an image needs to be generated rather than authored as code — the user asks for a picture, artwork, logo exploration, or any visual asset that SVG/HTML rendering cannot produce. Requires codex-cli >= 0.144.
---

# Image generation via Codex CLI

Verified 2026-07-21 (codex-cli 0.144.1, model gpt-5.6-sol): the Codex model has a
native image-generation tool, exposed headlessly through `codex exec`.

## Invocation contract

```
codex exec -C <absolute-target-dir> -m gpt-5.6-sol --sandbox workspace-write \
  [--skip-git-repo-check] \
  "<image brief>. Save as <name>.png in the current directory. Reply DONE when written." \
  < /dev/null
```

- `--sandbox workspace-write` is REQUIRED. The default sandbox is read-only and
  cannot save into the workspace.
- Use absolute paths for the target directory, every reference image, and every
  brief file.
- Always redirect stdin from `/dev/null`. An inherited open stdin makes Codex wait
  for EOF that never comes.
- Always give the Bash call an explicit timeout of about 1800000ms; image runs have
  no internal deadline of their own.
- `--skip-git-repo-check` when the cwd is not a git repo (scratchpads, temp dirs).
- Mechanics: images land first in `~/.codex/generated_images/<uuid>/*.png`; the
  model then copies them into the cwd — so ALWAYS specify exact output filenames.
- Reference images: include absolute paths in the prompt; the model can view them
  (style references, existing screenshots, brand pages).
- Cost: roughly 25-30k Codex tokens per simple image. Batch related concepts into
  one run when possible.

## Prompt checklist (keep briefs in a versioned file)

- One concept per image; exact filename for each; canvas size (e.g. 1024x1024);
  background (transparent, or explicit hex).
- Full palette as hex values; style constraints stated (e.g. flat fills, no
  gradients) — mandatory if the asset must be vectorized later.
- Store the brief as a .md file in the repo (e.g. experimentation/brand/logo-prompt.md)
  and have Codex read it by path. Rerunning the same file reproduces the run.

## Mandatory verification loop

1. Read every produced PNG and actually look at it — never report unseen output.
2. Check: matches the brief, correct background, no diffusion speckle where it
   matters, legible at the target display size.
3. Iterate by editing the brief file and rerunning, not by ad-hoc prompt drift.

## Caveats

- Generated rasters carry diffusion artifacts (soft edges, background speckle).
  NEVER ship them as final logos/icons: pick the winning concept, then hand-author
  a clean SVG as code (Claude or Codex writes the vector; do not autotrace).
- Apple-touch/iOS icons need solid backgrounds (iOS blackens transparency);
  favicons must survive 16px.
- If `codex` is missing, outdated (< 0.144), or unauthenticated: stop and report.
  There is no local fallback image generator.
