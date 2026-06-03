---
description: Generate an image with Codex (managed and serialized) and save it to a file
argument-hint: '[--out <path>] [--force] [--image <ref[,ref...]>] [--background] [--model <model>] [what the image should be]'
allowed-tools: Bash(node:*)
---

Generate an image through the Codex companion's managed, serialized image path and return its output verbatim.

Raw user request:
$ARGUMENTS

Run one `Bash` call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" imagegen "$ARGUMENTS"
```

How it works:

- `imagegen` runs a single Codex app-server turn, captures the generated image the moment it is ready, writes it to `--out` (or reports the Codex copy under `~/.codex/generated_images/`), and interrupts the turn so the model's post-image steps do not run.
- It is serialized like every other companion job, so it never runs Codex concurrently. That is what avoids the 403/429 websocket contention and wasted quota that raw parallel `codex exec` causes.
- Pass a reference image for editing with `--image ref.png`. Comma-separate several: `--image a.png,b.png`.

Operating rules:

- Default to foreground. With `--background`, the job is queued: report the job id and tell the user they can watch it with `/codex:status <id>` and fetch it with `/codex:result <id>`.
- `--out` refuses to overwrite an existing file. If the user wants to replace it, add `--force`.
- Return the companion stdout to the user. Do not paraphrase the `Saved image:` path.
- If the companion reports that Codex is missing or unauthenticated, tell the user to run `/codex:setup`.
- If the user gave no prompt, ask what the image should be.
