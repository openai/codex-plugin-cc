---
description: Trigger codex's protocol-native context compaction on a thread (recovery path for "prompt too long")
argument-hint: '<thread-id> [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" compact "$ARGUMENTS"`

When to use:

- A Codex task has stalled or failed with a context-overflow error and you want to recover the thread without losing its history.
- `/codex:events <job-id>` shows `phase:"stuck"` for an extended period and `phase:"metering"` records indicate the token budget is near the limit.
- A previous turn returned `phase:"failed"` with a context-length error and you want to compact before resuming.

Typical recovery sequence:

1. `/codex:cancel <job-id>` if a turn is still running and stuck.
2. `/codex:compact <thread-id>` — this command. Returns immediately after the codex app-server acknowledges the compaction request.
3. `/codex:rescue --resume <amended prompt>` — resume the (now compacted) thread with a tighter prompt.

Output format:

- Without `--json`: prints `Compaction started on <thread-id>.` and a hint for the resume flow.
- With `--json`: returns `{attempted, compacted, transport, result, detail}`.

If the thread id is malformed or the app-server rejects the request, the command exits non-zero and emits the codex-side error in `stderr` (or in `detail` under `--json`).

Notes:

- Compaction runs codex-side after this command returns; it is not a synchronous wait.
- `thread/compact/start` is a streaming RPC in the app-server protocol, but this wrapper does not consume the stream — codex completes compaction in the background regardless of whether a stream consumer is active.
- The exact success payload shape from codex CLI is preserved verbatim under `result` for forward-compat; downstream consumers should not depend on its keys beyond what they have observed.
