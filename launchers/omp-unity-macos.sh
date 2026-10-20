#!/bin/zsh
# omp-unity workspace for macOS.
#
# One tmux window is one workspace tab:
#   left        omp chat (the tab's own session)
#   right top   cockpit viewer
#   right lower Unity panel: global board in the parent, todos in an item/project
#
# The parent board opens item/project tabs. Each tab owns its session and can
# pause/stop/resume it. Detaching the workspace pauses every running session
# before the tmux session is closed.

set -euo pipefail

SELF="${0:A}"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CLI="$ROOT/lib/unity-cli.mjs"
VIEWER="$HERE/cockpit-viewer.mjs"
BOARD="$HERE/unity-board.mjs"

PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

TMUX_BIN="$(command -v tmux || true)"
NODE_BIN="$(command -v node || true)"
OMP_BIN="${UNITY_OMP_BIN:-$(whence -p omp || true)}"

[[ -n "$TMUX_BIN" ]] || { echo "tmux is required: brew install tmux" >&2; exit 1; }
[[ -n "$NODE_BIN" ]] || { echo "node is required: brew install node" >&2; exit 1; }
[[ -n "$OMP_BIN" ]] || { echo "omp was not found on PATH" >&2; exit 1; }
[[ -f "$VIEWER" && -f "$BOARD" && -f "$CLI" ]] || { echo "omp-unity files are missing under $ROOT" >&2; exit 1; }

cleanup_roots() {
  local root name
  for root in "${TMPDIR:-/tmp}"/omp-unity-*(N); do
    [[ -d "$root" && -f "$root/.session" ]] || continue
    name="$(cat "$root/.session" 2>/dev/null || true)"
    [[ -n "$name" ]] || continue
    if ! "$TMUX_BIN" has-session -t "$name" 2>/dev/null; then
      rm -rf "$root"
    fi
  done
}
cleanup_roots

ITEM=""
PROJECT=""
FORK=""
FRESH=0
BOOT=0
VAULT=""
while (( $# )); do
  case "$1" in
    --vault) VAULT="${2:-}"; shift 2 ;;
    --item) ITEM="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --fork) FORK="${2:-}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    *) shift ;;
  esac
done

[[ -n "$ITEM" && -n "$PROJECT" ]] && { echo "pass --item or --project, not both" >&2; exit 1; }
KIND=""
TARGET=""
if [[ -n "$PROJECT" ]]; then KIND="project"; TARGET="$PROJECT"; fi
if [[ -n "$ITEM" ]]; then KIND="item"; TARGET="$ITEM"; fi

[[ -n "$VAULT" ]] || VAULT="${UNITY_VAULT:-}"
if [[ -z "$VAULT" && -f "$HOME/.omp/agent/AGENTS.local.md" ]]; then
  VAULT="$(sed -n 's/^- Vault: //p' "$HOME/.omp/agent/AGENTS.local.md" | head -1)"
fi
[[ -n "$VAULT" ]] || VAULT="$HOME/Documents/Obsidian Vault"
[[ -d "$VAULT" ]] || VAULT="$HOME"

"$NODE_BIN" "$CLI" init "$VAULT" >/dev/null 2>&1 || true

TARGET_FLAGS=()
[[ "$KIND" == "project" ]] && TARGET_FLAGS=(--project)
if [[ "$KIND" == "item" ]]; then
  "$NODE_BIN" "$CLI" status "$VAULT" "$TARGET" focus >/dev/null 2>&1 || true
fi

SESSION=""
if [[ -n "$TARGET" ]]; then
  INFO="$("$NODE_BIN" "$CLI" "$KIND" "$VAULT" "$TARGET" "${TARGET_FLAGS[@]}" 2>/dev/null || true)"
  SESSION="$(print -r -- "$INFO" | awk -F '\t' 'NR == 1 { print $2 }')"
fi
[[ -z "$SESSION" && -n "$FORK" ]] && SESSION="$FORK"

if [[ -n "$SESSION" && ! -f "$SESSION" ]]; then
  "$NODE_BIN" "$CLI" session-clear "$VAULT" "$TARGET" "${TARGET_FLAGS[@]}" >/dev/null 2>&1 || true
  SESSION=""
  fi

PROMPT=""
if (( FRESH )) && [[ -n "$TARGET" ]]; then
  if [[ -n "$SESSION" ]]; then
    PROMPT="$("$NODE_BIN" "$CLI" prompt "$VAULT" "$TARGET" "${TARGET_FLAGS[@]}" --with-session 2>/dev/null || true)"
  else
    PROMPT="$("$NODE_BIN" "$CLI" prompt "$VAULT" "$TARGET" "${TARGET_FLAGS[@]}" 2>/dev/null || true)"
  fi
  "$NODE_BIN" "$CLI" session-clear "$VAULT" "$TARGET" "${TARGET_FLAGS[@]}" >/dev/null 2>&1 || true
  SESSION=""
  elif [[ -n "$TARGET" && -z "$SESSION" ]]; then
  PROMPT="$("$NODE_BIN" "$CLI" prompt "$VAULT" "$TARGET" "${TARGET_FLAGS[@]}" 2>/dev/null || true)"
fi

SESSION_NAME="${UNITY_SESSION:-unity}"
if [[ -n "$TARGET" ]]; then
  WIN_BASE="${KIND:0:1}-$TARGET"
else
  WIN_BASE="main"
fi

OMP_ENV="PATH=${(q)PATH} UNITY_VAULT=${(q)VAULT}"
[[ -n "${UNITY_OMP_BIN:-}" ]] && OMP_ENV="$OMP_ENV UNITY_OMP_BIN=${(q)UNITY_OMP_BIN}"
if [[ "$KIND" == "item" ]]; then
  OMP_ENV="$OMP_ENV UNITY_ITEM=${(q)TARGET}"
elif [[ "$KIND" == "project" ]]; then
  OMP_ENV="$OMP_ENV UNITY_PROJECT=${(q)TARGET}"
fi

window_name() {
  local session="$1" base="$2" name n
  name="$base"
  n=1
  while "$TMUX_BIN" list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "$name"; do
    n=$((n + 1))
    name="$base-$n"
  done
  print -r -- "$name"
}

state_root() {
  local session="$1" root
  root="$("$TMUX_BIN" show-options -t "$session" -v @unity_state 2>/dev/null || true)"
  if [[ -z "$root" ]]; then
    root="${TMPDIR:-/tmp}/omp-unity-${session}-$$"
    mkdir -p "$root"
    print -r -- "$session" > "$root/.session"
    "$TMUX_BIN" set-option -t "$session" @unity_state "$root"
  fi
  print -r -- "$root"
}


finish_workspace() {
  [[ "${FINISHED:-0}" == "1" ]] && return 0
  FINISHED=1
  if [[ "${UNITY_KEEP:-0}" != "1" ]]; then
    "$NODE_BIN" "$CLI" pause-all "$VAULT" >/dev/null 2>&1 || true
    "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
    [[ -n "${ROOT_STATE:-}" ]] && rm -rf "$ROOT_STATE"
  fi
  return 0
}


configure_session() {
  local session="$1"
  # Per-session only: no global tmux options or key bindings.
  "$TMUX_BIN" set-option -t "$session" mouse on
  "$TMUX_BIN" set-option -t "$session" focus-events on
  "$TMUX_BIN" set-option -t "$session" destroy-unattached off
  "$TMUX_BIN" set-option -t "$session" status-right ' tab pane · C-b d detach · C-b l back '
  "$TMUX_BIN" set-option -t "$session" pane-border-status top
  "$TMUX_BIN" set-option -t "$session" pane-border-format ' #{pane_title} '
}

open_window() {
  local session="$1" name="$2" win root viewer_cmd board_cmd
  root="$(state_root "$session")"
  STATE_DIR="$root/$name"
  mkdir -p "$STATE_DIR"

  OMP_CMD="$OMP_ENV OMP_COCKPIT_DIR=${(q)STATE_DIR} ${(q)OMP_BIN}"
  if [[ -n "$SESSION" ]]; then
    OMP_CMD="$OMP_CMD --restore ${(q)SESSION}"
  elif [[ -n "$PROMPT" ]]; then
    OMP_CMD="$OMP_CMD ${(q)PROMPT}"
  fi
  OMP_CMD="$OMP_CMD; if [ -n \"\$TMUX_PANE\" ]; then \"$TMUX_BIN\" kill-window -t \"\$TMUX_PANE\" 2>/dev/null; fi"

  viewer_cmd="PATH=${(q)PATH} ${(q)NODE_BIN} ${(q)VIEWER} ${(q)STATE_DIR} ${(q)SELF}"
  local omp_override=""
  [[ -n "${UNITY_OMP_BIN:-}" ]] && omp_override="UNITY_OMP_BIN=${(q)UNITY_OMP_BIN} "
  if [[ -n "$TARGET" ]]; then
    board_cmd="PATH=${(q)PATH} ${omp_override}UNITY_VAULT=${(q)VAULT} UNITY_SCOPE=${(q)KIND} UNITY_ID=${(q)TARGET} UNITY_PARENT=${(q)PARENT_INDEX} ${(q)NODE_BIN} ${(q)BOARD} ${(q)VAULT} ${(q)SELF} --scope ${(q)KIND} --id ${(q)TARGET} --parent ${(q)PARENT_INDEX}"
  else
    board_cmd="PATH=${(q)PATH} ${omp_override}UNITY_VAULT=${(q)VAULT} ${(q)NODE_BIN} ${(q)BOARD} ${(q)VAULT} ${(q)SELF}"
  fi

  if (( BOOT )); then
    "$TMUX_BIN" respawn-window -k -t "$session:$name" -c "$VAULT" "$OMP_CMD"
    BOOT=0
  else
    "$TMUX_BIN" new-window -t "$session:" -n "$name" -c "$VAULT" "$OMP_CMD"
  fi
  win="$("$TMUX_BIN" list-windows -t "$session" -F '#{window_name} #{window_index}' | awk -v n="$name" '$1 == n { print $2; exit }')"
  "$TMUX_BIN" split-window -h -l 45% -t "$session:$win" -c "$VAULT" "$viewer_cmd"
  "$TMUX_BIN" split-window -v -l 50% -t "$session:$win.1" -c "$VAULT" "$board_cmd"
  "$TMUX_BIN" select-pane -t "$session:$win.0" -T "${TARGET:-omp}"
  "$TMUX_BIN" select-pane -t "$session:$win.1" -T viewer
  "$TMUX_BIN" select-pane -t "$session:$win.2" -T "${TARGET:+todos}${TARGET:-board}"
  "$TMUX_BIN" select-pane -t "$session:$win.2"
  rm_cmd="rm -rf ${(q)STATE_DIR}"
  "$TMUX_BIN" set-hook -t "$session:$win" window-unlinked "run-shell ${(q)rm_cmd}"
  print -r -- "$win"
}

if [[ -n "${TMUX:-}" ]]; then
  SESSION_CUR="$("$TMUX_BIN" display-message -p -t "${TMUX_PANE:-}" '#{session_name}' 2>/dev/null || true)"
  if [[ -z "$SESSION_CUR" ]]; then
    SESSION_CUR="$("$TMUX_BIN" list-sessions -F '#{session_name}' 2>/dev/null | head -1 || true)"
  fi
  [[ -n "$SESSION_CUR" ]] || { echo "could not resolve the tmux session" >&2; exit 1; }
  SESSION_NAME="$SESSION_CUR"
  PARENT_INDEX=""
  if [[ -n "${TMUX_PANE:-}" ]]; then
    PARENT_INDEX="$("$TMUX_BIN" display-message -p -t "$TMUX_PANE" '#{window_index}' 2>/dev/null || true)"
  fi

  configure_session "$SESSION_NAME"
  ROOT_STATE="$(state_root "$SESSION_NAME")"
  "$TMUX_BIN" set-hook -u -t "$SESSION_NAME" client-detached 2>/dev/null || true

  if [[ -n "$TARGET" ]]; then
    existing="$("$TMUX_BIN" list-windows -t "$SESSION_NAME" -F '#{window_name} #{window_index}' | awk -v n="$WIN_BASE" '$1 == n { print $2; exit }')"
    if [[ -n "$existing" ]]; then
      if (( ! FRESH )); then
        "$TMUX_BIN" select-window -t "$SESSION_NAME:$existing"
        "$TMUX_BIN" select-pane -t "$SESSION_NAME:$existing.0"
        exit 0
      fi
      "$TMUX_BIN" kill-window -t "$SESSION_NAME:$existing"
    fi
  fi
  name="$(window_name "$SESSION_NAME" "$WIN_BASE")"
  open_window "$SESSION_NAME" "$name" >/dev/null
  exit 0
fi

if "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
  configure_session "$SESSION_NAME"
  ROOT_STATE="$(state_root "$SESSION_NAME")"
  "$TMUX_BIN" set-hook -u -t "$SESSION_NAME" client-detached 2>/dev/null || true
  trap 'finish_workspace' EXIT HUP TERM INT
  "$TMUX_BIN" attach -t "$SESSION_NAME" || true
  finish_workspace
  exit 0
fi

PARENT_INDEX=""
"$TMUX_BIN" new-session -d -s "$SESSION_NAME" -n "$WIN_BASE" -c "$VAULT" "sleep 300"
configure_session "$SESSION_NAME"
ROOT_STATE="$(state_root "$SESSION_NAME")"
"$TMUX_BIN" set-hook -u -t "$SESSION_NAME" client-detached 2>/dev/null || true
BOOT=1
open_window "$SESSION_NAME" "$WIN_BASE" >/dev/null
trap 'finish_workspace' EXIT HUP TERM INT
"$TMUX_BIN" attach -t "$SESSION_NAME" || true
finish_workspace
