# CC Model Layer Backlog

This file tracks the continuing work for `~/bin/cc-*` Claude Code model launchers.

## Operating Rules

- Prefer official provider docs, official model cards, and papers/technical reports.
- Mark weak sources explicitly instead of treating third-party summaries as facts.
- Keep `cc-model-registry.tsv` aligned with launcher defaults.
- Run syntax checks plus `cc-models list`, `cc-models matrix`, and `cc-models doctor` after changing any launcher. `cc-models audit` is stricter and also fails for registry placeholders whose launcher scripts do not exist yet.
- Do not start real interactive model sessions during maintenance unless explicitly requested.

## Source Grades

- `A`: official docs, official model card, official API reference, or official paper/technical report.
- `B`: provider-adjacent or third-party summary that points to official material but still needs verification.
- `C`: community report, benchmark mirror, or anecdotal source; useful only as a hint.

## Current Priority Queue

1. Local: when remote Ollama is reachable, confirm dynamic picker refreshes from live tags.
2. MiniMax: add safe model metadata check against Anthropic-compatible model-list/details endpoints.
3. DeepSeek: live-test output/context limits against official Anthropic-compatible endpoint.
4. Grok: design or adopt a Responses-to-Anthropic bridge if server-side tools/multi-agent are needed in Claude Code.
5. LongCat: re-test Preview 128K after account quota/rate limit clears.
6. StepFun: verify full Claude Code streaming behavior on a real task after the direct API smoke tests.
7. MiMo: replace current B-grade readable source with Xiaomi first-party console docs once the app docs can be extracted.
8. Doubao: live-test large `max_completion_tokens` behavior only when a real task needs >32K output.
9. Gemini: monitor whether 3.1 Pro Preview graduates to stable and update IDs.

## Per Launcher Notes

### cc-kimi

- Current default: `kimi-for-coding`.
- Strong at long-horizon coding, coding-driven design, multimodal and agentic workflows.
- Learned: current Kimi patch only covers branding/theme/model-picker behavior, not provider request-body translation.
- Next: expose preserve-thinking and instant-mode knobs only after adding a safe request-body patch for Kimi's `thinking` fields.

### cc-glm

- Current default: `glm-4.7`; opus tier: `glm-5.1`; haiku tier: `glm-4.5-air`.
- Endpoint defaults to `https://api.z.ai/api/anthropic`, with `GLM_BASE_URL` available for legacy BigModel routes.
- Added `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` per GLM Claude Code guidance.
- Learned: official GLM Claude Code routing matches this local tier map; GLM-5.1 is best kept as opus because of higher quota multipliers.
- Done: raise default output cap to 128K to match official GLM-4.7 / GLM-5.1 limits; added balanced/max/turbo/cheap profiles and `GLM_THINKING=auto|enabled|disabled`.
- Next: live-test `api.z.ai` versus legacy `open.bigmodel.cn` with the user's key before removing the override.

### cc-qwen

- Current default: `qwen3-coder-next`.
- Coder models keep thinking disabled by default.
- `QWEN_PROFILE=coding-plan` switches to Coding Plan; `token/token-plan` switches to Token Plan; `max/payg` switches to PayG.
- Learned: official Anthropic endpoint supports broad Max/Plus/Flash/Turbo/Coder/open-weight model set; Coder models do not support thinking.
- Done: expanded picker model list, added profile endpoint routing, 64K output default, and `QWEN_ENABLE_THINKING` explicit body control.
- Next: recheck whether `qwen3-coder-next` should stay default or move to `qwen3-coder-plus` after live tool-call latency tests.

### cc-deepseek

- Current default: `deepseek-v4-pro[1m]`; fast/subagent: `deepseek-v4-flash`.
- Matches DeepSeek official Claude Code environment guidance.
- Learned: V4-Pro is 1.6T/49B active, V4-Flash is 284B/13B active, both 1M context and dual thinking/non-thinking modes.
- Done: added generic `deepseek-v4-pro` to picker while preserving official Claude Code default `deepseek-v4-pro[1m]`.
- Next: update output cap only after official Anthropic endpoint max-output documentation is found.

### cc-doubao

- Current default: `doubao-seed-code-preview-latest`.
- Current tier map still includes Seed 2.0 code/pro/lite.
- Learned: Volcano Claude Code guidance recommends `doubao-seed-code-preview-latest`; Seed Code docs show 256K context and 32K max_tokens / 64K max_completion_tokens.
- Live-tested: `latest`, `251028`, `seed-2.0-code`, `seed-2.0-lite`, and `ark-code-latest` all respond on `/api/coding`; `latest`/`251028` normalize to `doubao-seed-code`, router normalizes to `doubao-seed-2.0-pro`.
- Done: moved default/sonnet/subagent toward Code Preview Latest, added `DOUBAO_PROFILE`, added optional `DOUBAO_MAX_COMPLETION_TOKENS`, and defaulted body-level thinking off for replay safety.
- Next: only live-test high output limits when a real task requires it.

### cc-minimax

- Current default: `MiniMax-M2.7`; sonnet/subagent: `MiniMax-M2.7-highspeed`; haiku/fast: `MiniMax-M2.5-highspeed`.
- Max output set to `64000` for Anthropic-compatible route.
- Learned: official Claude Code guide recommends `MiniMax-M2.7`; Anthropic-compatible docs list only seven M2-family models, all at 204,800 context.
- Done: add cn/global endpoint selection; make `parallel_tool_calls` and temperature body fields opt-in because unsupported/edge parameters should not be injected by default.
- Next: add safe metadata check command, not run by default, and live-test whether `thinking` is honored or ignored.

### cc-mimo

- Current default: `mimo-v2-pro`.
- Fast tier: `mimo-v2-pro` on token-plan endpoints; multimodal picker: `mimo-v2-omni`; Flash is opt-in with `MIMO_ENABLE_FLASH=1` or public region.
- Source quality remains weaker than the rest because the first-party console is not text-readable here; treat output caps as high-signal but still provisional.
- Learned: readable MiMo docs list Pro 1M/128K, Flash 256K/64K, Omni 256K/128K; OpenClaw provider docs list lower Pro/Omni max output at 32K.
- Live-tested: token-plan-sgp Pro works; raw Pro returns empty-signature `thinking` unless the request body includes `thinking: {"type":"disabled"}`; token-plan-sgp rejects `mimo-v2-flash`.
- Done: add region/base-url selection, accept `XIAOMI_API_KEY`, keep token-plan defaults on Pro, make Flash opt-in, and force the official disabled-thinking body by default.
- Next: verify public/official endpoint DNS/account behavior for Flash and Omni when those routes are reachable.

### cc-stepfun

- Current default: `step-3.5-flash-2603`.
- Endpoint follows Step Plan Anthropic SDK guidance.
- Fast tier: `step-3.5-flash`; optional picker route: `step-router-v1`.
- Learned: Step Plan supports 2603, flash, and router; `output_config.effort=low/high` is only for 2603, while router ignores it and has narrower content/tool constraints.
- Live-tested: direct Messages calls to 2603 accept base, `effort=low`, and `effort=high`; router accepts the same body but per official docs ignores `output_config.effort`. Responses still expose empty `model` and spend tiny output caps on `thinking`.
- Done: add router to picker, move subagent to 2603, map `STEPFUN_REASONING=low|high` to official `output_config.effort`, guard effort injection for non-2603 models, and make `none` inject disabled-thinking body.
- Next: verify full Claude Code streaming completion on a real task and only add a router profile if tool payload constraints stay clean.

### cc-longcat

- Current default: `LongCat-2.0-Preview`; fast: `LongCat-Flash-Lite`; subagent: `LongCat-2.0-Preview`.
- Learned: Preview is the 2026-04-20 Agent/Claude Code model; Omni/2602-Exp are OpenAI-only and should stay out of this Anthropic launcher.
- Live-tested: Preview accepts 64K `max_tokens`; 128K remains unverified because the account hit usage/rate limit before parameter validation. Thinking-2601 emits Anthropic-compatible `thinking` blocks, and body-level `thinking: disabled` does not suppress them.
- Done: move subagent to Preview and keep Preview default output at 64K because it is both officially documented and live-tested.
- Next: re-test Preview 128K after quota/rate limit clears.

### cc-gemini

- Current route: ccr OpenAI-compatible bridge.
- Current default: `gemini-3-flash-preview`; opus: `gemini-3.1-pro-preview`; fast: `gemini-3.1-flash-lite-preview`; subagent: `gemini-3.1-pro-preview-customtools`.
- Learned: `gemini-3-pro-preview` is shut down; Gemini OpenAI compatibility supports `reasoning_effort`, and current examples use Gemini 3 Flash.
- Live-tested: `GEMINI_REASONING_EFFORT=medium` is present in the outgoing ccr OpenAI-compatible request and the minimal request completed.
- Done: refresh model picker/tiering, sync ccr provider model list, and verify extra-body passthrough while keeping Anthropic-style thinking disabled.
- Next: monitor stable Gemini ID changes.

### cc-grok

- Current route: ccr OpenAI-compatible bridge.
- Current default: `grok-4.3`; opus/sonnet/subagent: `grok-4.3`; fast: `grok-code-fast-1`.
- Learned: xAI migration docs say switch current workloads to newer current models; Grok 4.3 is the unified flagship for reasoning/coding, and explicit reasoning knobs are not supported for current 4.20/4.1-style reasoning models.
- Live-tested: direct xAI Responses call to `grok-4.3` works and returns typed `reasoning` plus `message/output_text`, including `reasoning_tokens`.
- Done: move all heavy tiers to `grok-4.3`; keep `grok-4.20-multi-agent` out of the stable picker because official examples use Responses API/research tooling rather than the current ccr chat bridge.
- Next: only build a Responses-to-Anthropic bridge if we need xAI server-side search/code/multi-agent features inside Claude Code.

### cc-local

- Current route: ccr to remote Ollama.
- Current default/fallback: `qwen3-coder:30b`; fallback list: `qwen3-coder:30b`, `codestral:22b`, `gpt-oss:20b`.
- Learned: this is a local model-routing layer, so stale hard-coded picker entries are worse than a smaller but truthful live/fallback list.
- Done: make launcher export picker JSON from remote Ollama tags; make local patch read that JSON instead of embedding old M5 model rows.
- Next: when tailnet/M5 Ollama is online, rerun `cc-local --list` and let the picker refresh from live tags.
