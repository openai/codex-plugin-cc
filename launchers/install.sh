#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_BIN="${HOME}/bin"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.150}"
PROVIDERS=(kimi glm qwen deepseek doubao minimax mimo stepfun longcat)

mkdir -p "$TARGET_BIN"

install -m 0755 "$ROOT/bin/cc-models" "$TARGET_BIN/cc-models"
install -m 0644 "$ROOT/bin/cc-model-lib.sh" "$TARGET_BIN/cc-model-lib.sh"
install -m 0644 "$ROOT/bin/cc-model-registry.tsv" "$TARGET_BIN/cc-model-registry.tsv"
install -m 0644 "$ROOT/bin/cc-model-research.tsv" "$TARGET_BIN/cc-model-research.tsv"
install -m 0644 "$ROOT/bin/cc-model-backlog.md" "$TARGET_BIN/cc-model-backlog.md"

for provider in "${PROVIDERS[@]}"; do
  install -m 0755 "$ROOT/bin/${provider}-code" "$TARGET_BIN/${provider}-code"
  ln -sfn "${provider}-code" "$TARGET_BIN/cc-${provider}"

  prompt="$ROOT/prompts/${provider}-proactive-tools.md"
  prompt_dir="${HOME}/.claude-envs/${provider}/prompts"
  mkdir -p "$prompt_dir"
  install -m 0644 "$prompt" "$prompt_dir/${provider}-proactive-tools.md"
done

if [ "${1:-}" = "--install-claude-code" ]; then
  for provider in "${PROVIDERS[@]}"; do
    opt_dir="${HOME}/.claude-envs/${provider}/opt"
    mkdir -p "$opt_dir"
    (cd "$opt_dir" && npm install "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}")
  done
fi

echo "Installed cn-cc launchers to $TARGET_BIN"
echo "Run: cc-models doctor"
