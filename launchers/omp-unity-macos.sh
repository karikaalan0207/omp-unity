#!/bin/zsh
# omp-unity workspace for macOS.
#
# Layout per tmux window (window = workspace tab):
#   left        omp chat
#   right top   cockpit viewer
#   right bottom Unity board (focus, items, projects)
#
# Keys in the board: j/k move, space status, enter open, f focus, n/p create,
# [ ] switch tabs, q quit. Keys in the viewer: n new tab, f fork, q quit.

set -euo pipefail

SELF="${0:A}"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STORE_CLI="$ROOT/lib/unity-cli.mjs"
VIEWER="$HERE/cockpit-viewer.mjs"
BOARD="$HERE/unity-board.mjs"

PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

TMUX_BIN="$(command -v tmux || true)"
NODE_BIN="$(command -v node || true)"
OMP_BIN="$(whence -p omp || true)"

[[ -n "$TMUX_BIN" ]] || { echo "tmux is required: brew install tmux" >&2; exit 1; }
[[ -n "$NODE_BIN" ]] || { echo "node is required: brew install node" >&2; exit 1; }
[[ -n "$OMP_BIN" ]] || { echo "omp was not found on PATH" >&2; exit 1; }
[[ -f "$VIEWER" && -f "$BOARD" && -f "$STORE_CLI" ]] || { echo "omp-unity files are missing under $ROOT" >&2; exit 1; }

ITEM=""
FORK=""
VAULT=""
while (( $# )); do
  case "$1" in
    --vault) VAULT="${2:-}"; shift 2 ;;
    --item) ITEM="${2:-}"; shift 2 ;;
    --fork) FORK="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

[[ -n "$VAULT" ]] || VAULT="${UNITY_VAULT:-}"
if [[ -z "$VAULT" && -f "$HOME/.omp/agent/AGENTS.local.md" ]]; then
  VAULT="$(sed -n 's/^- Vault: //p' "$HOME/.omp/agent/AGENTS.local.md" | head -1)"
fi
[[ -n "$VAULT" ]] || VAULT="$HOME/Documents/Obsidian Vault"
[[ -d "$VAULT" ]] || VAULT="$HOME"

"$NODE_BIN" "$STORE_CLI" init "$VAULT" >/dev/null 2>&1 || true
if [[ -n "$ITEM" ]]; then
  "$NODE_BIN" "$STORE_CLI" status "$VAULT" "$ITEM" active >/dev/null 2>&1 || true
fi

SESSION=""
if [[ -n "$ITEM" ]]; then
  SESSION="$("$NODE_BIN" "$STORE_CLI" session "$VAULT" "$ITEM" 2>/dev/null || true)"
fi
[[ -z "$SESSION" && -n "$FORK" ]] && SESSION="$FORK"

STATE_DIR="${TMPDIR:-/tmp}/omp-unity-$$"
mkdir -p "$STATE_DIR"

OMP_CMD="PATH='$PATH' UNITY_VAULT='$VAULT' UNITY_ITEM='$ITEM' OMP_COCKPIT_DIR='$STATE_DIR' '$OMP_BIN'"
[[ -n "$SESSION" ]] && OMP_CMD="$OMP_CMD --resume '$SESSION'"
VIEWER_CMD="PATH='$PATH' '$NODE_BIN' '$VIEWER' '$STATE_DIR' '$SELF'"
BOARD_CMD="PATH='$PATH' UNITY_VAULT='$VAULT' '$NODE_BIN' '$BOARD' '$VAULT' '$SELF'"

window_name() {
  local session="$1" base name n
  base="${ITEM:-main}"
  name="$base"
  n=1
  while "$TMUX_BIN" list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "$name"; do
    n=$((n + 1))
    name="$base-$n"
  done
  print -r -- "$name"
}

open_window() {
  local session="$1" name="$2"
  "$TMUX_BIN" new-window -t "$session" -n "$name" -c "$VAULT" "$OMP_CMD"
  local win
  win="$("$TMUX_BIN" list-windows -t "$session" -F '#{window_name} #{window_index}' | awk -v n="$name" '$1 == n { print $2; exit }')"
  "$TMUX_BIN" split-window -h -l 45% -t "$session:$win" -c "$VAULT" "$VIEWER_CMD"
  "$TMUX_BIN" split-window -v -l 50% -t "$session:$win.1" -c "$VAULT" "$BOARD_CMD"
  "$TMUX_BIN" select-pane -t "$session:$win.0"
  print -r -- "$win"
}

if [[ -n "${TMUX:-}" ]]; then
  # A window is one workspace tab. Reuse an item tab when it already exists.
  SESSION_CUR="$("$TMUX_BIN" display-message -p '#{session_name}')"
  if [[ -n "$ITEM" ]]; then
    existing="$("$TMUX_BIN" list-windows -t "$SESSION_CUR" -F '#{window_name} #{window_index}' | awk -v n="$ITEM" '$1 == n { print $2; exit }')"
    if [[ -n "$existing" ]]; then
      "$TMUX_BIN" select-window -t "$SESSION_CUR:$existing"
      "$TMUX_BIN" select-pane -t "$SESSION_CUR:$existing.0"
      exit 0
    fi
  fi
  name="$(window_name "$SESSION_CUR")"
  open_window "$SESSION_CUR" "$name" >/dev/null
  exit 0
fi

SESSION_NAME="unity"
NAME="${ITEM:-main}"
"$TMUX_BIN" new-session -d -s "$SESSION_NAME" -n "$NAME" -c "$VAULT" "$OMP_CMD"
"$TMUX_BIN" split-window -h -l 45% -t "$SESSION_NAME:$NAME" -c "$VAULT" "$VIEWER_CMD"
"$TMUX_BIN" split-window -v -l 50% -t "$SESSION_NAME:$NAME.1" -c "$VAULT" "$BOARD_CMD"
"$TMUX_BIN" select-pane -t "$SESSION_NAME:$NAME.0"
"$TMUX_BIN" set-hook -t "$SESSION_NAME" client-attached "set-option -t '$SESSION_NAME' destroy-unattached on"
"$TMUX_BIN" attach -t "$SESSION_NAME"
