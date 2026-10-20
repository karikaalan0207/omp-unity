#!/bin/zsh
# Update the omp-unity runtime in ~/.omp/agent from the public repo.
# Context files (AGENTS.md, CONTEXT.md, skills, commands) are untouched.
#
# Usage:
#   zsh omp-unity-update.sh [--check]

set -euo pipefail

REPO="${UNITY_REPO:-https://github.com/karikaalan0207/omp-unity.git}"
AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

info() { printf '==> %s\n' "$*" }
warn() { printf '!!  %s\n' "$*" >&2 }
die()  { printf 'XX  %s\n' "$*" >&2; exit 1 }

[[ -d "$AGENT_DIR" ]] || die "agent dir not found: $AGENT_DIR"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/omp-unity-update.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

info "Fetching $REPO"
git clone --depth 1 "$REPO" "$TMP/omp-unity" >/dev/null 2>&1 || die "could not clone $REPO"
SRC="$TMP/omp-unity"
OLD="$(cat "$AGENT_DIR/VERSION" 2>/dev/null || echo unknown)"
NEW="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"

if (( CHECK )); then
  if [[ "$OLD" == "$NEW" ]]; then
    info "up to date ($OLD)"
  else
    info "update available: $OLD → $NEW"
  fi
  exit 0
fi

if git -C "$AGENT_DIR" remote -v 2>/dev/null | grep -qF "$REPO"; then
  git -C "$AGENT_DIR" pull --ff-only || warn "git pull failed; checkout left as-is."
else
  mkdir -p "$AGENT_DIR/lib" "$AGENT_DIR/launchers" "$AGENT_DIR/extensions" "$AGENT_DIR/setup"
  for f in VERSION lib/unity-store.mjs lib/unity-cli.mjs \
    launchers/omp-unity-macos.sh launchers/unity-board.mjs launchers/cockpit-viewer.mjs \
    extensions/cockpit-state.ts setup/omp-unity-bootstrap.sh setup/omp-unity-update.sh; do
    if [[ -f "$SRC/$f" ]]; then
      cp "$SRC/$f" "$AGENT_DIR/$f"
    else
      warn "missing $f in the update"
    fi
  done
  chmod +x "$AGENT_DIR/launchers/omp-unity-macos.sh" "$AGENT_DIR/setup/omp-unity-bootstrap.sh" "$AGENT_DIR/setup/omp-unity-update.sh"
fi

info "updated $OLD → $NEW"
info "restart the workspace: tmux kill-session -t unity && omp"
