---
name: image
description: Internal guidance for drafting craft-grade image prompts that Codex will pass to its native image generation tool inside the Codex Claude Code plugin
user-invocable: false
---

# Image Prompting

Use this skill only inside the `codex:codex-image` subagent.

Modern frontier image models (GPT Image 2 and successors) plan, reference, critique, and iterate before rendering. Treat the prompt as context, not a description. Diffusion-era prompt habits leave most of the model's capability unused.

Codex has a stable built-in `image_generation` feature. The subagent does not need to write a script or call any external API — it just hands a craft-grade prompt to Codex with a `task` instruction telling Codex to use its native image tool.

## The six rules (community-tested in the first thirty days post-launch)

1. **Lead with style and intended use.** The first words carry the highest visual weight. Open with the medium and aesthetic — "Premium editorial magazine cover...", "High-fidelity iOS UI screenshot...", "Photoreal editorial food photograph, shot on a Leica Q3 full-frame..." — before naming the subject.
2. **Quote every literal string.** Anything that must appear in the rendered image — labels, taglines, button copy, dates, file paths, handles, captions, all of it — goes inside double quotes inside the prompt. Quoting engages the high-accuracy text rendering path. Typography drifts when you do not.
3. **Treat the prompt as context.** Pack palette hex values, brand rules, anti-patterns, polish details, and named font families into the prompt. The model reasons over them.
4. **Aspect ratio = explicit pixel dimensions.** End every prompt with a literal line like `Output in exactly 1536px x 1024px (3:2 ratio) landscape format.` Do not rely on a bare ratio string. Map the user's intent or supplied ratio into pixel dimensions before sending.
5. **Constraints block is mandatory.** A dedicated paragraph of what NOT to do — typically as long as the subject section. The most underused part of an image prompt.
6. **Generate fresh, do not edit.** Image-to-image is still unreliable. If the user pastes a reference image, extract its qualities into words and regenerate from text only. Tell Codex explicitly to generate fresh, not to use a previous image as a starting point.

## Crafting checklist

Build the inner image prompt in this exact order. Every section is mandatory unless flagged optional.

1. **Style + intended use.** Open with the medium and aesthetic. For photoreal work, name the camera, lens, film stock, and lighting condition — specificity is realism.
2. **Scene.** Where, when, lighting, mood, weather, time of day. One paragraph.
3. **Subject.** The focal point. Pose, action, expression, materials. For people, lock in consistent traits (hair, build, age, distinguishing features).
4. **Details.** Background, props, micro-details. For photoreal work, include a believable-imperfections list (a stray seed, a juice bead on a thumbnail, a paper-cut on the index finger). Imperfection is the difference between AI-photo and editorial-photo.
5. **Quoted text.** Every literal string in the image, in double quotes, with exact punctuation, spacing, and casing. Be obsessive — `"Noon & Co."` not `Noon and Co`.
6. **Constraints.** A dedicated block of what NOT to do. Typical entries: no drop shadows, no fake bokeh, no glare, no lens flare; no emoji, no SF Symbols, no Apple defaults; five fingers per hand, correct knuckle spacing, no fused anatomy; two type families only — name them; no QR codes, no URLs, no hashtags; no additional text beyond what is quoted.
7. **Output dimensions.** Final line, always. Format: `Output in exactly [W]px x [H]px ([ratio]) [orientation].`

## Output dimension defaults

When the user does not provide dimensions, infer from intent:

| Intent signal | Pixel dimensions | Ratio | Orientation |
|---|---|---|---|
| Generic / ad / hero | `1536px x 1024px` | 3:2 | landscape |
| Square social card | `1024px x 1024px` | 1:1 | square |
| Wide social card | `1792px x 1024px` | 7:4 | landscape |
| Portrait phone screen | `1024px x 1792px` | 4:7 | portrait |
| Magazine cover | `1024px x 1280px` | 4:5 | portrait |
| Presentation slide | `1536px x 1024px` | 3:2 | landscape |
| App icon | `1024px x 1024px` | 1:1 | square |

State the targeted dimensions inside the prompt body itself. Codex's image tool reads the prompt and sizes accordingly.

## Wrapping for Codex

The drafted image prompt is the inner content. The subagent wraps it in a `<task>` block (per the `gpt-5-4-prompting` skill) instructing Codex to:

- Use its native image generation tool.
- Pass the inner `<image_prompt>` verbatim — no paraphrasing, no shortening, no "improvement."
- Save the resulting PNG and print the absolute saved path on the last line of stdout.
- If the slash command supplied `--out <path>`, also copy the saved PNG to that absolute path (creating the directory if needed) and print that path on the last line instead.
- Generate fresh — do not use any prior image as a reference or seed.

Codex's image tool handles the API call, file save, and path reporting. The subagent does not write or run any image-generation code itself.

## What you are NOT doing

- Not writing a script that calls an external image API. Codex's native tool handles it.
- Not running discovery interviews. The slash command may have asked once. The subagent commits to a craft-grade prompt from whatever intent it received.
- Not summarizing the prompt back. The subagent's only output is Codex's stdout.
- Not editing the prompt after Codex returns. The prompt is the artifact.
- Not chaining into other commands. This skill scopes a single forwarded `task` call.
