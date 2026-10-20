#!/usr/bin/env zsh
# omp-unity entrypoint for WSL2.
#
# The workspace itself is the POSIX/tmux launcher. This wrapper only checks the
# WSL prerequisites and then execs that launcher. Windows Terminal is the host;
# tmux inside WSL is the tab/pane manager.

set -euo pipefail

SELF="${0:A}"
HERE="${SELF:h}"
LAUNCHER="$HERE/omp-unity-macos.sh"

PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
  [[ -r /proc/version ]] && grep -qi microsoft /proc/version
}

if ! is_wsl; then
  print -u2 -- "warning: this does not look like WSL; continuing anyway."
fi

[[ -f "$LAUNCHER" ]] || {
  print -u2 -- "omp-unity launcher missing: $LAUNCHER"
  exit 1
}

command -v zsh >/dev/null 2>&1 || {
  print -u2 -- "zsh is required: sudo apt install zsh"
  exit 1
}
command -v tmux >/dev/null 2>&1 || {
  print -u2 -- "tmux is required: sudo apt install tmux"
  exit 1
}
command -v node >/dev/null 2>&1 || {
  print -u2 -- "node is required: sudo apt install nodejs npm"
  exit 1
}
command -v omp >/dev/null 2>&1 || {
  print -u2 -- "omp is required: curl -fsSL https://omp.sh/install | sh"
  exit 1
}

exec zsh "$LAUNCHER" "$@"
