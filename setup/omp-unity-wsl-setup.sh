#!/usr/bin/env bash
# omp-unity installer for WSL2 Ubuntu.
#
# Installs the Linux runtime (git, curl, tmux, zsh, Node, omp), clones an omp
# context repo, overlays the omp-unity runtime, points it at a Windows vault,
# and adds the bare-omp wrapper to ~/.zshrc. The vault stays on Windows so
# Obsidian and Windows tools open it natively; WSL sees it through /mnt/c.
#
# Usage:
#   bash omp-unity-wsl-setup.sh [options]
#
# Options:
#   --vault PATH          Windows or WSL vault path (blank to skip)
#   --context-repo ARG    Context repo URL, "none", or "new" (default: public)
#   --template-repo URL   Source used by "new" (default: the context repo)
#   --shell PATH          omp shellPath (default: /bin/zsh)
#   --no-packages         Do not apt-install prerequisites
#   --no-workspace        Do not add the bare-omp wrapper
#   --skip-github         Do not offer GitHub login
#   --skills-dir PATH     Extra skill directory to register
#   --api-key KEY         DeepSeek API key (optional)
#   --dry-run             Print actions without changing anything
#   --yes                 Accept defaults; never prompt
#   -h, --help            Show this help

set -euo pipefail

SELF="${BASH_SOURCE[0]}"
SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"
OVERLAY_DIR="$(cd "$SELF_DIR/.." && pwd)"
AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
ZSHENV="${OMP_ZSHRC:-$HOME/.zshrc}"
DEFAULT_REPO="https://github.com/karikaalan0207/omp-unity.git"
TEMPLATE_REPO="${TEMPLATE_REPO:-$DEFAULT_REPO}"
AGENT_REPO="$DEFAULT_REPO"
NEW_CONTEXT=0
VAULT=""
SHELL_PATH=""
SKILL_DIR=""
SKIP_GITHUB=0
INSTALL_PACKAGES=1
WITH_WORKSPACE=1
ASSUME_YES=0
DRY=0
API_KEY="${DEEPSEEK_API_KEY:-}"

info() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'XX  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  awk 'NR > 1 && /^set -euo pipefail/ { exit } NR > 1 && /^#/ { sub(/^# ?/, ""); print }' "$SELF"
  exit 0
}

while (( $# )); do
  case "$1" in
    --vault)          VAULT="${2:-}"; shift 2 ;;
    --vault=*)        VAULT="${1#--vault=}"; shift ;;
    --context-repo)   AGENT_REPO="${2:-}"; shift 2 ;;
    --context-repo=*) AGENT_REPO="${1#--context-repo=}"; shift ;;
    --template-repo)  TEMPLATE_REPO="${2:-}"; shift 2 ;;
    --template-repo=*) TEMPLATE_REPO="${1#--template-repo=}"; shift ;;
    --shell)          SHELL_PATH="${2:-}"; shift 2 ;;
    --shell=*)        SHELL_PATH="${1#--shell=}"; shift ;;
    --skills-dir)     SKILL_DIR="${2:-}"; shift 2 ;;
    --skills-dir=*)   SKILL_DIR="${1#--skills-dir=}"; shift ;;
    --api-key)        API_KEY="${2:-}"; shift 2 ;;
    --api-key=*)      API_KEY="${1#--api-key=}"; shift ;;
    --no-packages)    INSTALL_PACKAGES=0; shift ;;
    --no-workspace)   WITH_WORKSPACE=0; shift ;;
    --skip-github)    SKIP_GITHUB=1; shift ;;
    --dry-run)        DRY=1; shift ;;
    --yes|-y)         ASSUME_YES=1; shift ;;
    -h|--help)        usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
  [[ -r /proc/version ]] && grep -qi microsoft /proc/version
}

to_wsl_path() {
  local p="$1"
  case "$p" in
    [A-Za-z]:\\*|[A-Za-z]:/*|\\\\*)
      if have wslpath; then wslpath -u "$p"; else printf '%s\n' "$p"; fi
      ;;
    *) printf '%s\n' "$p" ;;
  esac
}

confirm() {
  local label="$1" default="$2" reply
  if (( ASSUME_YES )) || [[ ! -t 0 ]]; then
    [[ "$default" == [yY]* ]]
    return
  fi
  printf '%s [%s]: ' "$label" "$default"
  read -r reply || reply=""
  reply="${reply:-$default}"
  [[ "$reply" == [yY]* ]]
}

run() {
  if (( DRY )); then
    printf 'would:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

is_wsl || die "Run this inside WSL2 Ubuntu, not on the Windows host."
(( EUID != 0 )) || die "Run as your own user, not with sudo. Use sudo only when prompted."

if [[ "$AGENT_REPO" == "new" ]]; then
  NEW_CONTEXT=1
  AGENT_REPO="$TEMPLATE_REPO"
fi
[[ "$AGENT_REPO" == "none" ]] && AGENT_REPO=""

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

if [[ -z "$SHELL_PATH" ]]; then
  if have zsh; then SHELL_PATH="$(command -v zsh)"; else SHELL_PATH="/bin/zsh"; fi
fi

if (( INSTALL_PACKAGES )); then
  if have apt-get; then
    if (( ! DRY )); then
      sudo -v || die "sudo is required for apt packages."
    fi
    info "Installing git, curl, tmux, zsh, Node, and GitHub CLI if available"
    run sudo apt-get update
    run sudo apt-get install -y git curl tmux zsh nodejs npm
    if (( ! DRY )); then
      node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
      if (( node_major < 18 )); then
        info "Node $node_major is too old; installing Node 22"
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
    fi
    run sudo apt-get install -y gh || warn "GitHub CLI was not installed; private repo clones need git credentials."
  else
    warn "apt-get not found; install git, curl, tmux, zsh, nodejs, and npm manually."
  fi
fi

if [[ -z "$VAULT" && -f "$AGENT_DIR/AGENTS.local.md" ]]; then
  VAULT="$(sed -n 's/^- Vault: //p' "$AGENT_DIR/AGENTS.local.md" | head -1)"
fi
if [[ -z "$VAULT" ]] && (( ! ASSUME_YES )) && [[ -t 0 ]]; then
  printf 'Windows vault path (e.g. C:\\Users\\you\\Karikaalan\x27s Vault, blank to skip): '
  read -r VAULT || VAULT=""
fi
if [[ -n "$VAULT" ]]; then
  VAULT="$(to_wsl_path "$VAULT")"
  VAULT="${VAULT%/}"
  if [[ ! -d "$VAULT" ]]; then
    warn "Vault directory does not exist in WSL: $VAULT"
    warn "Create it on Windows or pass the mounted path, e.g. /mnt/c/Users/you/Vault."
    VAULT=""
  fi
fi

if ! have omp; then
  info "Installing omp"
  if (( DRY )); then
    info "would install omp from https://omp.sh/install"
  else
    curl -fsSL https://omp.sh/install | sh || die "omp install failed."
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
if have omp; then
  info "omp: $(omp --version 2>/dev/null || echo installed)"
fi

if (( ! SKIP_GITHUB )) && have gh && (( ! DRY )); then
  if ! gh auth status >/dev/null 2>&1; then
    if [[ -t 0 ]] && confirm 'Set up GitHub login now? (needed for private context repos)' y; then
      gh auth login --hostname github.com --git-protocol https --web
      gh auth setup-git || warn "Could not configure the git credential helper."
    else
      warn "GitHub login skipped; run 'gh auth login' before cloning a private context repo."
    fi
  fi
fi

if [[ -n "$AGENT_REPO" ]]; then
  info "Context repo: $AGENT_REPO"
  run mkdir -p "$HOME/.omp"
  if [[ -d "$AGENT_DIR/.git" ]]; then
    run git -C "$AGENT_DIR" pull --ff-only || warn "Context repo pull failed; keeping the local copy."
  else
    if [[ -e "$AGENT_DIR" ]]; then
      backup="$AGENT_DIR.bak.$(date +%Y%m%d%H%M%S)"
      run mv "$AGENT_DIR" "$backup"
      info "Backed up existing agent dir to $backup"
    fi
    if ! run git clone "$AGENT_REPO" "$AGENT_DIR"; then
      warn "Context repo clone failed; continuing without shared settings."
      warn "If the repo is private, run 'gh auth login' and rerun."
    fi
  fi
  if (( NEW_CONTEXT )) && [[ -d "$AGENT_DIR/.git" ]] && (( ! DRY )); then
    rm -rf "$AGENT_DIR/.git"
    git -C "$AGENT_DIR" init -q
    if git -C "$AGENT_DIR" config user.name >/dev/null 2>&1 && git -C "$AGENT_DIR" config user.email >/dev/null 2>&1; then
      git -C "$AGENT_DIR" add -A
      git -C "$AGENT_DIR" commit -qm "chore: start my omp context"
      info "Initialized your own context repo at $AGENT_DIR"
    else
      warn "Set git user.name and user.email, then commit $AGENT_DIR."
    fi
  fi
else
  info "Skipping context repo."
fi

run mkdir -p "$AGENT_DIR/lib" "$AGENT_DIR/launchers" "$AGENT_DIR/extensions" "$AGENT_DIR/setup"
for f in VERSION lib/unity-store.mjs lib/unity-cli.mjs \
  launchers/omp-unity-macos.sh launchers/omp-unity-wsl.sh \
  launchers/unity-board.mjs launchers/cockpit-viewer.mjs \
  extensions/cockpit-state.ts setup/omp-unity-bootstrap.sh \
  setup/omp-unity-update.sh setup/omp-unity-wsl-setup.sh; do
  if [[ -f "$OVERLAY_DIR/$f" && ! -f "$AGENT_DIR/$f" ]]; then
    run cp "$OVERLAY_DIR/$f" "$AGENT_DIR/$f"
  fi
done
run chmod +x "$AGENT_DIR/launchers/omp-unity-macos.sh" "$AGENT_DIR/launchers/omp-unity-wsl.sh" \
  "$AGENT_DIR/setup/omp-unity-bootstrap.sh" "$AGENT_DIR/setup/omp-unity-update.sh" \
  "$AGENT_DIR/setup/omp-unity-wsl-setup.sh"

if (( ! DRY )) && [[ -d "$AGENT_DIR/.git" ]]; then
  mkdir -p "$AGENT_DIR/.git/info"
  for f in launchers/omp-unity-wsl.sh setup/omp-unity-wsl-setup.sh; do
    grep -qxF "$f" "$AGENT_DIR/.git/info/exclude" 2>/dev/null || \
      printf '%s\n' "$f" >> "$AGENT_DIR/.git/info/exclude"
  done
fi

if [[ -n "$VAULT" ]]; then
  if [[ -d "$VAULT/.git" ]] && (( ! DRY )); then
    git config --global --add safe.directory "$VAULT" >/dev/null 2>&1 || true
  fi
  if [[ -f "$AGENT_DIR/lib/unity-cli.mjs" ]] && have node; then
    run node "$AGENT_DIR/lib/unity-cli.mjs" init "$VAULT" || warn "Could not initialize $VAULT/Unity."
    if [[ -n "$SKILL_DIR" ]]; then
      run node "$AGENT_DIR/lib/unity-cli.mjs" registry-skill "$VAULT" "$(basename "$SKILL_DIR")" "$SKILL_DIR" \
        || warn "Could not register $SKILL_DIR."
    fi
  fi
fi

if (( ! DRY )); then
  if [[ -d "$AGENT_DIR" && ! -f "$AGENT_DIR/config.local.yml" ]]; then
    printf '# Machine-local settings overlay (not synced).\nshellPath: %s\n' "$SHELL_PATH" \
      > "$AGENT_DIR/config.local.yml"
    info "Created $AGENT_DIR/config.local.yml"
  fi
  if [[ -d "$AGENT_DIR" && ! -f "$AGENT_DIR/AGENTS.local.md" ]]; then
    win_user="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r' | tail -1 || true)"
    [[ -n "$win_user" ]] || win_user="${USER:-user}"
    {
      printf '# Machine-local context (not synced)\n\n'
      printf '## Machine\n\n'
      printf -- '- %s (%s)\n' "${WSL_DISTRO_NAME:-WSL2}" "$(uname -m)"
      printf -- '- Windows tools via interop: cmd.exe, powershell.exe\n'
      printf -- '- Native paths for native tools; POSIX paths in the shell.\n'
      printf '\n## Notes\n\n'
      [[ -n "$VAULT" ]] && printf -- '- Vault: %s\n' "$VAULT"
      printf -- '- Shell: %s\n' "$SHELL_PATH"
      [[ -d "/mnt/c/Users/$win_user/Downloads" ]] && printf -- '- Downloads: /mnt/c/Users/%s/Downloads\n' "$win_user"
    } > "$AGENT_DIR/AGENTS.local.md"
    info "Created $AGENT_DIR/AGENTS.local.md"
  fi

  mkdir -p "$HOME/.omp"
  if [[ ! -f "$HOME/.omp/env" ]]; then
    umask 077
    printf '# omp environment (not synced).\n# export DEEPSEEK_API_KEY=...\n' > "$HOME/.omp/env"
    chmod 600 "$HOME/.omp/env"
    info "Created $HOME/.omp/env (mode 600)"
  fi
  if [[ -n "$API_KEY" ]] && ! grep -qF 'DEEPSEEK_API_KEY' "$HOME/.omp/env" 2>/dev/null; then
    umask 077
    printf 'export DEEPSEEK_API_KEY=%q\n' "$API_KEY" >> "$HOME/.omp/env"
    chmod 600 "$HOME/.omp/env"
  fi

  touch "$ZSHENV"
  if ! grep -qF '.local/bin' "$ZSHENV" 2>/dev/null; then
    printf '\n# omp local bin\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$ZSHENV"
    info "Added ~/.local/bin to PATH"
  fi
  if have omp && ! grep -qF 'omp shell completion' "$ZSHENV" 2>/dev/null; then
    printf '\n# omp shell completion\neval "$(command omp completions zsh 2>/dev/null)"\n' >> "$ZSHENV"
    info "Added omp completions"
  fi
  if ! grep -qF '.omp/env' "$ZSHENV" 2>/dev/null; then
    printf '\n[ -f "$HOME/.omp/env" ] && source "$HOME/.omp/env"\n' >> "$ZSHENV"
    info "Added ~/.omp/env sourcing"
  fi
  if [[ -f "$AGENT_DIR/config.local.yml" ]] && ! grep -qF 'omp machine-local overlay' "$ZSHENV" 2>/dev/null; then
    printf '\n# omp machine-local overlay\nexport PI_CONFIG_FILES="$HOME/.omp/agent/config.local.yml"\n' >> "$ZSHENV"
    info "Added the machine-local overlay"
  fi
  if (( WITH_WORKSPACE )) && ! grep -qF 'omp unity wsl wrapper' "$ZSHENV" 2>/dev/null; then
    cat >> "$ZSHENV" <<'EOF'

# omp unity wsl wrapper
omp() {
  if [[ -n "${OMP_COCKPIT_DIR:-}" ]]; then command omp "$@"; return; fi
  if [[ $# -eq 0 ]]; then zsh "$HOME/.omp/agent/launchers/omp-unity-wsl.sh"; else command omp "$@"; fi
}
EOF
    info "Added the bare-omp WSL workspace wrapper"
  fi
fi

if (( ! DRY )); then
  info "Checking"
  if have omp; then omp --version; fi
  if have tmux; then tmux -V; fi
  if have node; then
    for f in launchers/unity-board.mjs launchers/cockpit-viewer.mjs lib/unity-store.mjs lib/unity-cli.mjs; do
      [[ -f "$AGENT_DIR/$f" ]] && node --check "$AGENT_DIR/$f"
    done
  fi
  for f in launchers/omp-unity-macos.sh launchers/omp-unity-wsl.sh setup/omp-unity-update.sh; do
    [[ -f "$AGENT_DIR/$f" ]] && zsh -n "$AGENT_DIR/$f"
  done
fi

cat <<EOF

$( (( DRY )) && echo 'Dry run complete. No changes were made.' || echo 'Done.' )

Next:
  1. Open a new WSL shell: source ~/.zshrc
  2. Start the workspace: omp
  3. From Windows, run: windows\\omp-unity.cmd
     or add a Windows Terminal profile:
       wsl.exe -- zsh -lic "exec ~/.omp/agent/launchers/omp-unity-wsl.sh"
  4. Re-run this setup:
       bash ~/.omp/agent/setup/omp-unity-wsl-setup.sh

Vault:  ${VAULT:-<none>}
Agent:  ${AGENT_DIR}
EOF
