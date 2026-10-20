#!/bin/zsh
# Create or refresh the omp-unity environment on macOS.
#
# Idempotent: creates only missing files and appends only missing zsh blocks.
# Installs nothing (no Homebrew packages, omp, or Obsidian).
#
# Writes:
#   ~/.omp/agent/config.local.yml     machine overlay (shellPath)
#   ~/.omp/agent/AGENTS.local.md      vault / shell / Downloads
#   ~/.omp/env                        provider key file (mode 600)
#   ~/.zshrc                          completions, overlay, wrapper
#   <vault>/Unity/                    board, items, projects, sessions, registry
#   <vault>/.omp/config.yml           project config (if absent)
#   ~/.omp/agent/skills/*             registry skill links
#
# Usage:
#   zsh omp-unity-bootstrap.sh [options]
#
# Options:
#   --vault PATH       Vault/notes directory (default: AGENTS.local.md)
#   --shell PATH       omp shellPath (default: $SHELL)
#   --skills-dir PATH  Register and link an extra skill directory
#   --no-workspace     Do not add the bare-omp workspace wrapper
#   --no-cockpit       Alias of --no-workspace
#   -h, --help         Show this help

set -euo pipefail

SCRIPT="${0:A}"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"
AGENT_DIR="$HOME/.omp/agent"
ZSHENV="$HOME/.zshrc"
VAULT_DIR=""
SKILL_DIR=""
SHELL_PATH="${SHELL:-/bin/zsh}"
WITH_WORKSPACE=1

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
    --vault)          VAULT_DIR="${2:-}"; shift 2 ;;
    --vault=*)        VAULT_DIR="${1#--vault=}"; shift ;;
    --shell)          SHELL_PATH="${2:-}"; shift 2 ;;
    --shell=*)        SHELL_PATH="${1#--shell=}"; shift ;;
    --skills-dir)     SKILL_DIR="${2:-}"; shift 2 ;;
    --skills-dir=*)   SKILL_DIR="${1#--skills-dir=}"; shift ;;
    --no-workspace|--no-cockpit) WITH_WORKSPACE=0; shift ;;
    -h|--help)        usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS."
(( EUID != 0 )) || die "Run this as your own user, not with sudo."
for d in "$HOME/.omp/run" "$HOME/.omp/agent"; do
  if [[ -d "$d" && ! -w "$d" ]]; then
    warn "$d is not writable (root-owned?)."
    warn "Fix: sudo chown -R $(id -u):$(id -g) \"$HOME/.omp\""
  fi
done

[[ "$SHELL_PATH" == /* ]] || SHELL_PATH="/bin/$SHELL_PATH"
[[ "$VAULT_DIR" == "~"* ]] && VAULT_DIR="$HOME${VAULT_DIR#\~}"
[[ "$SKILL_DIR" == "~"* ]] && SKILL_DIR="$HOME${SKILL_DIR#\~}"
VAULT_DIR="${VAULT_DIR%/}"
SKILL_DIR="${SKILL_DIR%/}"

if [[ -z "$VAULT_DIR" && -f "$AGENT_DIR/AGENTS.local.md" ]]; then
  VAULT_DIR="$(sed -n 's/^- Vault: //p' "$AGENT_DIR/AGENTS.local.md" | head -1)"
fi
if [[ -n "$VAULT_DIR" && ! -d "$VAULT_DIR" ]]; then
  warn "Vault directory does not exist: $VAULT_DIR"
  warn "Create it or pass --vault PATH. Skipping vault state."
  VAULT_DIR=""
fi

UNITY_CLI="$HERE/../lib/unity-cli.mjs"
has_unity_cli() { [[ -f "$UNITY_CLI" ]] && have node; }

# ---------------------------------------------------------------- unity state
if [[ -n "$VAULT_DIR" ]]; then
  if has_unity_cli; then
    node "$UNITY_CLI" init "$VAULT_DIR" || warn "Could not initialize $VAULT_DIR/Unity."
    if [[ -n "$SKILL_DIR" ]]; then
      node "$UNITY_CLI" registry-skill "$VAULT_DIR" "$(basename "$SKILL_DIR")" "$SKILL_DIR" \
        || warn "Could not register $SKILL_DIR."
    fi
    if [[ -d "$AGENT_DIR" ]]; then
      mkdir -p "$AGENT_DIR/skills"
      node "$UNITY_CLI" link-skills "$VAULT_DIR" "$AGENT_DIR/skills" >/dev/null 2>&1 || true
    fi
  else
    warn "node or $UNITY_CLI is missing; skipping the Unity store."
  fi
fi

# ---------------------------------------------------------------- agent files
if [[ ! -d "$AGENT_DIR" ]]; then
  warn "Agent config not found at $AGENT_DIR; skipping AGENTS.local.md and config.local.yml."
  warn "Run the installer, or clone your context repo there first."
else
  if [[ ! -f "$AGENT_DIR/config.local.yml" ]]; then
    printf '# Machine-local settings overlay (not synced).\nshellPath: %s\n' "$SHELL_PATH" \
      > "$AGENT_DIR/config.local.yml"
    info "Created $AGENT_DIR/config.local.yml"
  else
    info "Keeping $AGENT_DIR/config.local.yml"
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
      if [[ "$(uname -m)" != "arm64" ]]; then
        printf -- '- Homebrew may live in /usr/local on Intel Macs.\n'
      fi
    } > "$AGENT_DIR/AGENTS.local.md"
    info "Created $AGENT_DIR/AGENTS.local.md"
  else
    info "Keeping $AGENT_DIR/AGENTS.local.md"
  fi
fi

# ---------------------------------------------------------------- env file
mkdir -p "$HOME/.omp"
if [[ ! -f "$HOME/.omp/env" ]]; then
  umask 077
  printf '# omp environment (not synced).\n# export DEEPSEEK_API_KEY=...\n' > "$HOME/.omp/env"
  chmod 600 "$HOME/.omp/env"
  info "Created $HOME/.omp/env (mode 600)"
fi

# ---------------------------------------------------------------- zsh
if have omp; then
  if ! grep -qF 'omp shell completion' "$ZSHENV" 2>/dev/null; then
    printf '\n# omp shell completion\neval "$(omp completions zsh)"\n' >> "$ZSHENV"
    info "Added omp completions"
  fi
else
  warn "omp is not on PATH; skipping completions."
fi

if ! grep -qF '.omp/env' "$ZSHENV" 2>/dev/null; then
  printf '\n[ -f "$HOME/.omp/env" ] && source "$HOME/.omp/env"\n' >> "$ZSHENV"
  info "Added ~/.omp/env sourcing"
fi

if [[ -f "$AGENT_DIR/config.local.yml" ]] && ! grep -qF 'omp machine-local overlay' "$ZSHENV" 2>/dev/null; then
  cat >> "$ZSHENV" <<'EOF'

# omp machine-local overlay
export PI_CONFIG_FILES="$HOME/.omp/agent/config.local.yml"
EOF
  info "Added the machine-local overlay"
fi

LAUNCHER="$AGENT_DIR/launchers/omp-unity-macos.sh"
if (( WITH_WORKSPACE )); then
  if [[ -f "$LAUNCHER" ]]; then
    if ! grep -qF 'omp unity wrapper' "$ZSHENV" 2>/dev/null; then
      cat >> "$ZSHENV" <<'EOF'

# omp unity wrapper
omp() {
  if [[ -n "${OMP_COCKPIT_DIR:-}" ]]; then command omp "$@"; return; fi
  if [[ $# -eq 0 ]]; then zsh "$HOME/.omp/agent/launchers/omp-unity-macos.sh"; else command omp "$@"; fi
}
EOF
      info "Added the bare-omp workspace wrapper"
    fi
    chmod +x "$LAUNCHER" 2>/dev/null || true
  else
    warn "Launcher missing at $LAUNCHER; skipping the wrapper."
  fi
fi

# The extension loads from ~/.omp/agent/extensions. Point out a broken overlay.
for f in "$AGENT_DIR/launchers/cockpit-viewer.mjs" "$AGENT_DIR/launchers/unity-board.mjs" "$AGENT_DIR/extensions/cockpit-state.ts"; do
  [[ -f "$f" ]] || warn "Missing workspace asset: $f"
done

# ---------------------------------------------------------------- vault config
if [[ -n "$VAULT_DIR" ]]; then
  if [[ ! -d "$VAULT_DIR/.omp" ]]; then
    mkdir -p "$VAULT_DIR/.omp"
    printf '# omp project config (created by the installer).\nskills:\n  customDirectories: []\n' \
      > "$VAULT_DIR/.omp/config.yml"
    info "Created $VAULT_DIR/.omp/config.yml"
  else
    info "Keeping $VAULT_DIR/.omp"
  fi
fi

# ---------------------------------------------------------------- verify
if [[ -f "$AGENT_DIR/config.local.yml" ]]; then
  export PI_CONFIG_FILES="$AGENT_DIR/config.local.yml"
fi

info "Summary"
printf 'agent:   %s\n' "$AGENT_DIR"
printf 'overlay: %s\n' "${PI_CONFIG_FILES:-<none>}"
printf 'vault:   %s\n' "${VAULT_DIR:-<none>}"
printf 'zshrc:   %s\n' "$ZSHENV"
if [[ -f "$AGENT_DIR/setup/omp-unity-update.sh" ]]; then
  printf 'update:  zsh %s/setup/omp-unity-update.sh\n' "$AGENT_DIR"
fi

if have omp && [[ -f "$AGENT_DIR/config.local.yml" ]]; then
  printf 'shellPath: '
  omp config get shellPath
fi
if [[ -f "$LAUNCHER" ]]; then
  zsh -n "$LAUNCHER" && printf 'launcher: syntax ok\n'
fi
VIEWER="$AGENT_DIR/launchers/cockpit-viewer.mjs"
if have node && [[ -f "$VIEWER" ]]; then
  node --check "$VIEWER" && printf 'viewer: syntax ok\n'
fi
BOARD="$AGENT_DIR/launchers/unity-board.mjs"
if have node && [[ -f "$BOARD" ]]; then
  node --check "$BOARD" && printf 'board: syntax ok\n'
fi
