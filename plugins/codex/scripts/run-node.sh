#!/bin/sh
set -u

target=${1:-}
if [ -z "$target" ]; then
  echo "Codex Companion Node launcher requires a script name." >&2
  exit 64
fi
shift

case "$0" in
  */*) script_base=${0%/*} ;;
  *) script_base=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_base" && pwd)

is_supported_node() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 18 || (major === 18 && minor >= 18) ? 0 : 1)' >/dev/null 2>&1
}

windows_path_to_posix() {
  value=$1
  [ -n "$value" ] || return 1
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$value"
    return
  fi

  normalized=
  remaining=$value
  while [ -n "$remaining" ]; do
    char=${remaining%"${remaining#?}"}
    remaining=${remaining#?}
    case "$char" in
      \\) normalized="${normalized}/" ;;
      *) normalized="${normalized}${char}" ;;
    esac
  done
  case "$normalized" in
    [A-Za-z]:/*)
      drive=${normalized%%:*}
      rest=${normalized#?:}
      printf '/%s%s\n' "$drive" "$rest"
      ;;
    *) printf '%s\n' "$normalized" ;;
  esac
}

find_windows_node() {
  root=
  if [ -n "${NVM_SYMLINK:-}" ]; then
    root=$(windows_path_to_posix "$NVM_SYMLINK") || root=
    for candidate in "$root/node.exe" "$root/node"; do
      [ -x "$candidate" ] || continue
      is_supported_node "$candidate" || continue
      printf '%s\n' "$candidate"
      return 0
    done
  fi
  if [ -n "${VOLTA_HOME:-}" ]; then
    root=$(windows_path_to_posix "$VOLTA_HOME") || root=
    for candidate in "$root/bin/node.exe" "$root/bin/node"; do
      [ -x "$candidate" ] || continue
      is_supported_node "$candidate" || continue
      printf '%s\n' "$candidate"
      return 0
    done
  fi
  if [ -n "${LOCALAPPDATA:-}" ]; then
    root=$(windows_path_to_posix "$LOCALAPPDATA") || root=
    for candidate in "$root/Volta/bin/node.exe" "$root/Volta/bin/node"; do
      [ -x "$candidate" ] || continue
      is_supported_node "$candidate" || continue
      printf '%s\n' "$candidate"
      return 0
    done
  fi
  program_files=${PROGRAMFILES:-${PROGRAMW6432:-${ProgramFiles:-}}}
  if [ -n "$program_files" ]; then
    root=$(windows_path_to_posix "$program_files") || root=
    for candidate in "$root/nodejs/node.exe" "$root/nodejs/node"; do
      [ -x "$candidate" ] || continue
      is_supported_node "$candidate" || continue
      printf '%s\n' "$candidate"
      return 0
    done
  fi
  return 1
}

node_dir_has_codex() {
  candidate=$1
  case "$candidate" in */*) candidate_dir=${candidate%/*} ;; *) candidate_dir=. ;; esac
  [ -x "$candidate_dir/codex" ] || [ -f "$candidate_dir/codex.cmd" ] || [ -f "$candidate_dir/codex.exe" ]
}

find_managed_node() {
  require_codex=$1
  home=${HOME:-}
  nvm_dir=$(windows_path_to_posix "${NVM_DIR:-$home/.nvm}") || nvm_dir=
  fnm_dir=$(windows_path_to_posix "${FNM_DIR:-$home/.local/share/fnm}") || fnm_dir=
  asdf_dir=$(windows_path_to_posix "${ASDF_DATA_DIR:-$home/.asdf}") || asdf_dir=
  mise_dir=$(windows_path_to_posix "${MISE_DATA_DIR:-$home/.local/share/mise}") || mise_dir=
  homebrew_prefix=$(windows_path_to_posix "${HOMEBREW_PREFIX:-}") || homebrew_prefix=
  homebrew_node=
  [ -n "$homebrew_prefix" ] && homebrew_node="$homebrew_prefix/bin/node"
  for candidate in \
    "$homebrew_node" /home/linuxbrew/.linuxbrew/bin/node /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node \
    "$home/.volta/bin/node" \
    "$nvm_dir"/versions/node/*/bin/node \
    "$fnm_dir"/node-versions/*/installation/bin/node \
    "$asdf_dir"/installs/nodejs/*/bin/node \
    "$mise_dir"/installs/node/*/bin/node; do
    [ -x "$candidate" ] || continue
    is_supported_node "$candidate" || continue
    if [ "$require_codex" = "true" ]; then
      node_dir_has_codex "$candidate" || continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

find_node() {
  if [ -n "${CODEX_COMPANION_NODE:-}" ]; then
    configured_node=$(windows_path_to_posix "$CODEX_COMPANION_NODE") || configured_node=$CODEX_COMPANION_NODE
    if [ -x "$configured_node" ] && is_supported_node "$configured_node"; then
      printf '%s\n' "$configured_node"
      return 0
    fi
  fi

  path_node=
  if command -v node >/dev/null 2>&1; then
    candidate=$(command -v node)
    if is_supported_node "$candidate"; then
      path_node=$candidate
      if command -v codex >/dev/null 2>&1; then
        printf '%s\n' "$path_node"
        return 0
      fi
    fi
  fi

  if candidate=$(find_managed_node true); then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [ -n "$path_node" ]; then
    printf '%s\n' "$path_node"
    return 0
  fi
  if candidate=$(find_managed_node false); then
    printf '%s\n' "$candidate"
    return 0
  fi
  find_windows_node && return 0
  return 1
}

node_bin=$(find_node) || {
  echo "Codex Companion requires Node.js >=18.18. Add a supported node to PATH or set CODEX_COMPANION_NODE to its executable path." >&2
  exit 127
}

add_supported_node_dir_to_path() {
  candidate=$1
  [ -x "$candidate" ] || return 0
  is_supported_node "$candidate" || return 0
  case "$candidate" in */*) candidate_dir=${candidate%/*} ;; *) candidate_dir=. ;; esac
  case ":${PATH:-}:" in *":$candidate_dir:"*) ;; *) PATH="${PATH:-}${PATH:+:}$candidate_dir" ;; esac
}

add_dir_to_path() {
  candidate_dir=$1
  [ -d "$candidate_dir" ] || return 0
  case ":${PATH:-}:" in *":$candidate_dir:"*) ;; *) PATH="${PATH:-}${PATH:+:}$candidate_dir" ;; esac
}

add_npm_prefix_dirs_to_path() {
  prefix=${NPM_CONFIG_PREFIX:-}
  if [ -z "$prefix" ] && command -v npm >/dev/null 2>&1; then
    prefix=$(npm prefix -g 2>/dev/null) || prefix=
  fi
  [ -n "$prefix" ] || return 0
  prefix=$(windows_path_to_posix "$prefix") || return 0
  add_dir_to_path "$prefix/bin"
  add_dir_to_path "$prefix"
}

add_windows_node_dirs_to_path() {
  root=
  if [ -n "${NVM_SYMLINK:-}" ]; then
    root=$(windows_path_to_posix "$NVM_SYMLINK") || root=
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/node.exe"
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/node"
  fi
  if [ -n "${VOLTA_HOME:-}" ]; then
    root=$(windows_path_to_posix "$VOLTA_HOME") || root=
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/bin/node.exe"
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/bin/node"
  fi
  if [ -n "${LOCALAPPDATA:-}" ]; then
    root=$(windows_path_to_posix "$LOCALAPPDATA") || root=
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/Volta/bin/node.exe"
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/Volta/bin/node"
  fi
  program_files=${PROGRAMFILES:-${PROGRAMW6432:-${ProgramFiles:-}}}
  if [ -n "$program_files" ]; then
    root=$(windows_path_to_posix "$program_files") || root=
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/nodejs/node.exe"
    [ -n "$root" ] && add_supported_node_dir_to_path "$root/nodejs/node"
  fi
}

case "$node_bin" in */*) node_dir=${node_bin%/*} ;; *) node_dir=. ;; esac
PATH="$node_dir${PATH:+:$PATH}"
home=${HOME:-}
nvm_dir=$(windows_path_to_posix "${NVM_DIR:-$home/.nvm}") || nvm_dir=
fnm_dir=$(windows_path_to_posix "${FNM_DIR:-$home/.local/share/fnm}") || fnm_dir=
asdf_dir=$(windows_path_to_posix "${ASDF_DATA_DIR:-$home/.asdf}") || asdf_dir=
mise_dir=$(windows_path_to_posix "${MISE_DATA_DIR:-$home/.local/share/mise}") || mise_dir=
homebrew_prefix=$(windows_path_to_posix "${HOMEBREW_PREFIX:-}") || homebrew_prefix=
homebrew_node=
[ -n "$homebrew_prefix" ] && homebrew_node="$homebrew_prefix/bin/node"
for candidate in "$homebrew_node" /home/linuxbrew/.linuxbrew/bin/node /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node "$home/.volta/bin/node" "$nvm_dir"/versions/node/*/bin/node "$fnm_dir"/node-versions/*/installation/bin/node "$asdf_dir"/installs/nodejs/*/bin/node "$mise_dir"/installs/node/*/bin/node; do
  add_supported_node_dir_to_path "$candidate"
done
add_windows_node_dirs_to_path
add_npm_prefix_dirs_to_path
export PATH

exec "$node_bin" "$script_dir/$target" "$@"
