#!/bin/zsh
# Create or refresh the omp environment context on macOS.
#
# Idempotent: creates only missing files, appends only missing zsh blocks.
# Installs nothing (no Homebrew packages, omp, or Obsidian).
#
# Bootstraps:
#   ~/.omp/agent/config.local.yml    machine settings overlay (shellPath)
#   ~/.omp/agent/AGENTS.local.md     vault / shell / Downloads paths
#   ~/.omp/env                       empty provider key file (mode 600)
#   ~/.zshrc                         completions, overlay, optional cockpit
#   <vault>/.omp/config.yml          project config for the vault (if absent)
#
# Usage:
#   zsh omp-unity-bootstrap.sh [options]
#
# Options:
#   --vault PATH   Vault/notes directory (default: read from AGENTS.local.md)
#   --shell PATH   omp shellPath (default: $SHELL, usually /bin/zsh)
#   --no-cockpit   Do not add the bare-omp cockpit wrapper
#   -h, --help     Show this help

set -euo pipefail

SCRIPT="${0:A}"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"
AGENT_DIR="$HOME/.omp/agent"
ZSHENV="$HOME/.zshrc"
VAULT_DIR=""
SHELL_PATH="${SHELL:-/bin/zsh}"
WITH_COCKPIT=1

info() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'XX  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  awk 'NR > 1 && /^set -euo pipefail/ { exit } NR > 1 && /^#/ { sub(/^# ?/, ""); print }' "$SCRIPT"
  exit 0
}

while (( $# )); do
  case "$1" in
    --vault)        VAULT_DIR="${2:-}"; shift 2 ;;
    --vault=*)      VAULT_DIR="${1#--vault=}"; shift ;;
    --shell)        SHELL_PATH="${2:-}"; shift 2 ;;
    --shell=*)      SHELL_PATH="${1#--shell=}"; shift ;;
    --no-cockpit)   WITH_COCKPIT=0; shift ;;
    -h|--help)      usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS."
if (( EUID == 0 )); then
  die "Run this as your own user, not with sudo. Root-owned ~/.omp files break normal omp launches."
fi
for d in "$HOME/.omp/run" "$HOME/.omp/agent"; do
  if [[ -d "$d" && ! -w "$d" ]]; then
    warn "$d is not writable (root-owned?)."
    warn "Fix: sudo chown -R $(id -u):$(id -g) \"$HOME/.omp\""
  fi
done
[[ "$SHELL_PATH" == /* ]] || SHELL_PATH="/bin/$SHELL_PATH"
if [[ "$VAULT_DIR" == "~"* ]]; then
  VAULT_DIR="$HOME${VAULT_DIR#\~}"
fi
VAULT_DIR="${VAULT_DIR%/}"

# Fall back to the vault recorded in AGENTS.local.md.
if [[ -z "$VAULT_DIR" && -f "$AGENT_DIR/AGENTS.local.md" ]]; then
  VAULT_DIR="$(sed -n 's/^- Vault: //p' "$AGENT_DIR/AGENTS.local.md" | head -1)"
fi
if [[ -n "$VAULT_DIR" && ! -d "$VAULT_DIR" ]]; then
  warn "Vault directory does not exist: $VAULT_DIR (skipping vault context)."
  VAULT_DIR=""
fi

# ---------------------------------------------------------------- unity state
UNITY_CLI="$HERE/../lib/unity-cli.mjs"
if [[ -n "$VAULT_DIR" && -f "$UNITY_CLI" ]] && have node; then
  node "$UNITY_CLI" init "$VAULT_DIR" || warn "Could not initialize $VAULT_DIR/Unity."
  mkdir -p "$AGENT_DIR/skills"
  node "$UNITY_CLI" link-skills "$VAULT_DIR" "$AGENT_DIR/skills" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- agent files
if [[ ! -d "$AGENT_DIR" ]]; then
  warn "Agent config not found at $AGENT_DIR; skipping AGENTS.local.md and config.local.yml."
  warn "Clone omp-config to $AGENT_DIR first, then rerun this script."
else
  if [[ ! -f "$AGENT_DIR/config.local.yml" ]]; then
    cat > "$AGENT_DIR/config.local.yml" <<YAML
# Machine-local settings overlay (not synced).
shellPath: $SHELL_PATH
YAML
    info "Created $AGENT_DIR/config.local.yml"
  else
    info "Keeping existing $AGENT_DIR/config.local.yml"
  fi

  if [[ ! -f "$AGENT_DIR/AGENTS.local.md" ]]; then
    {
      printf '# Machine-local context (not synced)\n\n'
      printf '## Machine\n\n'
      printf -- '- macOS (%s)\n' "$(uname -m)"
      printf -- '- Native paths for native tools; POSIX paths in the shell.\n'
      printf '\n## Notes\n\n'
      [[ -n "$VAULT_DIR" ]] && printf -- '- Vault: %s\n' "$VAULT_DIR"
      printf -- '- Shell: %s\n' "$SHELL_PATH"
      printf -- '- Downloads: ~/Downloads\n'
    } > "$AGENT_DIR/AGENTS.local.md"
    info "Created $AGENT_DIR/AGENTS.local.md"
  else
    info "Keeping existing $AGENT_DIR/AGENTS.local.md"
  fi

  if [[ "$(uname -m)" != "arm64" ]] && ! grep -q 'Homebrew may live in /usr/local' "$AGENT_DIR/AGENTS.local.md"; then
    printf '\n- Homebrew may live in /usr/local on Intel Macs.\n' >> "$AGENT_DIR/AGENTS.local.md"
  fi
fi

# ---------------------------------------------------------------- env file
mkdir -p "$HOME/.omp"
if [[ ! -f "$HOME/.omp/env" ]]; then
  umask 077
  cat > "$HOME/.omp/env" <<'EOF'
# omp environment (not synced).
# export DEEPSEEK_API_KEY=...
EOF
  chmod 600 "$HOME/.omp/env"
  info "Created $HOME/.omp/env (mode 600)"
fi

# ---------------------------------------------------------------- zsh
if have omp; then
  if ! grep -qF 'omp shell completion' "$ZSHENV" 2>/dev/null; then
    printf '\n# omp shell completion\neval "$(omp completions zsh)"\n' >> "$ZSHENV"
    info "Added omp completions to $ZSHENV"
  fi
else
  warn "omp is not on PATH; skipping the completion line."
fi

if ! grep -qF '.omp/env' "$ZSHENV" 2>/dev/null; then
  printf '\n[ -f "$HOME/.omp/env" ] && source "$HOME/.omp/env"\n' >> "$ZSHENV"
  info "Added ~/.omp/env sourcing to $ZSHENV"
fi

if [[ -f "$AGENT_DIR/config.local.yml" ]] && ! grep -qF 'omp machine-local overlay' "$ZSHENV" 2>/dev/null; then
  cat >> "$ZSHENV" <<'EOF'

# omp machine-local overlay
export PI_CONFIG_FILES="$HOME/.omp/agent/config.local.yml"
EOF
  info "Added the machine-local overlay to $ZSHENV"
fi

if (( WITH_COCKPIT )); then
  for f in "$AGENT_DIR/launchers/cockpit-viewer.mjs" "$AGENT_DIR/extensions/cockpit-state.ts"; do
    [[ -f "$f" ]] || warn "Cockpit asset missing: $f (aim/alignment view may not work)."
  done
fi

COCKPIT="$AGENT_DIR/launchers/omp-unity-macos.sh"
if (( WITH_COCKPIT )) && [[ -f "$COCKPIT" ]]; then
  if ! grep -qF 'omp cockpit wrapper' "$ZSHENV" 2>/dev/null; then
    cat >> "$ZSHENV" <<'EOF'

# omp cockpit wrapper
omp() {
  if [[ -n "${OMP_COCKPIT_DIR:-}" ]]; then command omp "$@"; return; fi
  if [[ $# -eq 0 ]]; then zsh "$HOME/.omp/agent/launchers/omp-unity-macos.sh"; else command omp "$@"; fi
}
EOF
    info "Added the bare-omp cockpit wrapper to $ZSHENV"
  fi
  chmod +x "$COCKPIT" 2>/dev/null || true
elif (( WITH_COCKPIT )); then
  warn "Cockpit launcher not found at $COCKPIT; skipping the wrapper."
fi

# ---------------------------------------------------------------- vault context
if [[ -n "$VAULT_DIR" ]]; then
  if [[ ! -d "$VAULT_DIR/.omp" ]]; then
    mkdir -p "$VAULT_DIR/.omp"
    cat > "$VAULT_DIR/.omp/config.yml" <<'YAML'
# omp project config (created by the installer).
skills:
  customDirectories: []
YAML
    info "Created $VAULT_DIR/.omp/config.yml"
  else
    info "Keeping existing $VAULT_DIR/.omp"
  fi
fi

# ---------------------------------------------------------------- verify
if [[ -f "$AGENT_DIR/config.local.yml" ]]; then
  export PI_CONFIG_FILES="$AGENT_DIR/config.local.yml"
fi

info "Context summary"
printf 'agent:   %s\n' "$AGENT_DIR"
printf 'overlay: %s\n' "${PI_CONFIG_FILES:-<none>}"
printf 'vault:   %s\n' "${VAULT_DIR:-<none>}"
printf 'zshrc:   %s\n' "$ZSHENV"

if have omp && [[ -f "$AGENT_DIR/config.local.yml" ]]; then
  printf 'shellPath: '
  omp config get shellPath
fi
if [[ -f "$COCKPIT" ]]; then
  zsh -n "$COCKPIT" && printf 'cockpit launcher: syntax ok\n'
fi
VIEWER="$AGENT_DIR/launchers/cockpit-viewer.mjs"
if have node && [[ -f "$VIEWER" ]]; then
  node --check "$VIEWER" && printf 'cockpit viewer: syntax ok\n'
fi
BOARD="$AGENT_DIR/launchers/unity-board.mjs"
if have node && [[ -f "$BOARD" ]]; then
  node --check "$BOARD" && printf 'unity board: syntax ok\n'
fi
