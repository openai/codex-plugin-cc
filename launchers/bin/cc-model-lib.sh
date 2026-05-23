#!/usr/bin/env bash
# Shared helpers for Claude Code model launchers in ~/bin/cc-*.

cc_model_source_secrets() {
  local real_home="${REAL_HOME:-${HOME:-}}"
  local secret_file

  for secret_file in \
    "$real_home/.config/cc-model-secrets.env" \
    "$HOME/.config/cc-model-secrets.env"; do
    [ -n "$secret_file" ] || continue
    [ -r "$secret_file" ] || continue
    # shellcheck disable=SC1090
    . "$secret_file"
  done
}

cc_model_source_secrets

cc_model_unset_proxies() {
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy
}

cc_model_usage() {
  local command="${CC_MODEL_COMMAND:-cc-model}"
  local default_model="${CC_MODEL_SELECTED:-${MODEL:-}}"
  cat >&2 <<EOF
Usage: $command [options] [claude-code args...]

Options:
  -l, --list           List configured models
  -m, --model MODEL    Pick the startup model
  --doctor             Check launcher config without starting Claude Code
  --env                Print non-secret runtime environment
  -h, --help           Show this help

Default model: ${default_model:-unknown}
EOF
}

cc_model_print_models() {
  printf '%s\n' "${MODELS[@]}"
}

cc_model_json_options() {
  local description_prefix="$1"
  local value_prefix="${2:-}"
  local out="["
  local model value

  for model in "${MODELS[@]}"; do
    value="${value_prefix}${model}"
    out+="{\"value\":\"${value}\",\"label\":\"${model}\",\"description\":\"${description_prefix} · ${model}\"},"
  done
  printf '%s' "${out%,}]"
}

cc_model_reset_plugins() {
  local plug_dir="$HOME/.claude/plugins"
  [ -d "$plug_dir" ] || return 0

  printf '%s\n' '{"version":2,"plugins":{}}' > "$plug_dir/installed_plugins.json" 2>/dev/null || true
  printf '%s\n' '{}' > "$plug_dir/known_marketplaces.json" 2>/dev/null || true

  local d base
  for d in "$plug_dir/cache"/* "$plug_dir/marketplaces"/*; do
    [ -e "$d" ] || continue
    base="$(basename "$d" 2>/dev/null || true)"
    case "$base" in
      claude-plugins-official|"") ;;
      *) rm -rf "$d" ;;
    esac
  done
}

cc_model_secret_status() {
  if [ -n "${CC_MODEL_AUTH_VALUE:-}" ]; then
    printf 'set'
  else
    printf 'missing'
  fi
}

cc_model_json_status() {
  local env_name="$1"
  local label="$2"
  local value="${!env_name:-}"

  [ -n "$value" ] || return 0
  if command -v python3 >/dev/null 2>&1 && ENV_NAME="$env_name" python3 - <<'PY' 2>/dev/null
import json
import os

json.loads(os.environ[os.environ["ENV_NAME"]])
PY
  then
    echo "  $label: ok"
  else
    echo "  $label: invalid JSON ($env_name)"
    return 1
  fi
}

cc_model_doctor() {
  local ok=0
  local cli="${CC_MODEL_CLI:-${CLAUDE_CLI:-}}"
  local patch_marker="${CC_MODEL_PATCH_MARKER:-}"
  local prompt_file="${CC_MODEL_PROMPT_FILE:-}"

  echo "${CC_MODEL_COMMAND:-cc-model} doctor"
  echo "  provider: ${CC_MODEL_PROVIDER:-unknown}"
  echo "  home:     ${HOME:-unknown}"
  echo "  endpoint: ${ANTHROPIC_BASE_URL:-unknown}"
  echo "  model:    ${CC_MODEL_SELECTED:-${MODEL:-unknown}}"
  [ -n "${ANTHROPIC_DEFAULT_OPUS_MODEL:-}" ] && echo "  opus:     $ANTHROPIC_DEFAULT_OPUS_MODEL"
  [ -n "${ANTHROPIC_DEFAULT_SONNET_MODEL:-}" ] && echo "  sonnet:   $ANTHROPIC_DEFAULT_SONNET_MODEL"
  [ -n "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-}" ] && echo "  haiku:    $ANTHROPIC_DEFAULT_HAIKU_MODEL"
  [ -n "${ANTHROPIC_SMALL_FAST_MODEL:-}" ] && echo "  fast:     $ANTHROPIC_SMALL_FAST_MODEL"
  [ -n "${CLAUDE_CODE_SUBAGENT_MODEL:-}" ] && echo "  subagent: $CLAUDE_CODE_SUBAGENT_MODEL"
  [ -n "${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-}" ] && echo "  max_out:  $CLAUDE_CODE_MAX_OUTPUT_TOKENS"
  if [ -n "${CLAUDE_CODE_DISABLE_THINKING:-}" ] || [ -n "${MAX_THINKING_TOKENS:-}" ]; then
    local thinking_state="enabled"
    if [ "${CLAUDE_CODE_DISABLE_THINKING:-0}" = "1" ] || [ "${MAX_THINKING_TOKENS:-}" = "0" ]; then
      thinking_state="disabled"
    fi
    echo "  thinking: $thinking_state / max=${MAX_THINKING_TOKENS:-default}"
  fi
  echo "  auth:     ${CC_MODEL_AUTH_LABEL:-api key} = $(cc_model_secret_status)"

	  if [ -n "${ANTHROPIC_CUSTOM_MODEL_OPTIONS_JSON:-}" ]; then
	    if command -v python3 >/dev/null 2>&1 && python3 -c 'import json, os; json.loads(os.environ["ANTHROPIC_CUSTOM_MODEL_OPTIONS_JSON"])' 2>/dev/null; then
	      echo "  picker:   ok"
	    else
	      echo "  picker:   invalid ANTHROPIC_CUSTOM_MODEL_OPTIONS_JSON"
	      ok=1
	    fi
	  fi
  cc_model_json_status CLAUDE_CODE_EXTRA_BODY extra_body || ok=1
  cc_model_json_status CLAUDE_CODE_EXTRA_METADATA metadata || ok=1

	  if [ -n "$cli" ] && [ -f "$cli" ]; then
    echo "  cli:      ok ($cli)"
    if [ -n "$patch_marker" ]; then
      if grep -Iq . "$cli" 2>/dev/null; then
        if grep -q "$patch_marker" "$cli" 2>/dev/null; then
          echo "  patch:    ok ($patch_marker)"
        else
          echo "  patch:    missing marker ($patch_marker)"
          ok=1
        fi
      else
        echo "  patch:    skipped (native binary)"
      fi
    fi
  else
    echo "  cli:      missing (${cli:-unset})"
    ok=1
  fi

  if [ -n "$prompt_file" ]; then
    if [ -f "$prompt_file" ]; then
      echo "  prompt:   ok ($prompt_file)"
    else
      echo "  prompt:   absent ($prompt_file)"
    fi
  fi

  return "$ok"
}

cc_model_print_env() {
  env | LC_ALL=C sort | grep -E '^(ANTHROPIC_|CLAUDE_CODE_|MAX_|API_TIMEOUT_MS|BASH_).*' | \
    sed -E 's/(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=.*/\1=<redacted>/'
}

cc_model_handle_common_command() {
  case "${1:-}" in
    -h|--help)
      cc_model_usage
      exit 0
      ;;
    --doctor|doctor)
      cc_model_doctor
      exit $?
      ;;
    --env)
      cc_model_print_env
      exit 0
      ;;
  esac
}
