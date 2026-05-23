#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash -n "$ROOT/bin/cc-models" "$ROOT/bin/cc-model-lib.sh"
for script in "$ROOT"/bin/*-code; do
  bash -n "$script"
done

for prompt in "$ROOT"/prompts/*-proactive-tools.md; do
  [ -s "$prompt" ] || {
    echo "empty prompt: $prompt" >&2
    exit 1
  }
done

echo "launcher snapshot syntax ok"
