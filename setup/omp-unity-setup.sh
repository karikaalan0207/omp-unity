#!/bin/zsh
# Generic omp installer for macOS (Apple Silicon or Intel).
#
# Installs Homebrew packages and omp, then optionally:
#   - clones an omp agent-config repo (shared settings)
#   - wires zsh: completions, machine-local overlay, bare-omp workspace wrapper
#   - optionally installs Obsidian (cask) and creates a vault directory
#   - bootstraps the environment: AGENTS.local.md, config.local.yml,
#     ~/.omp/env, and the vault's .omp/config.yml
#
# Nothing is pushed. An existing agent config is backed up first. With
# --agent-repo new the template clone becomes your own local context repo.
#
# Usage:
#   zsh omp-macos-setup-generic.sh [options]
#
# Options:
#   --vault PATH          Existing vault/notes directory (blank to skip)
#   --vault-repo URL      Clone the vault from git if PATH does not exist
#   --obsidian            Install Obsidian via Homebrew cask
#   --no-obsidian         Do not install Obsidian (default)
#   --agent-repo URL      Context repo cloned to ~/.omp/agent (default:
#                         https://github.com/karikaalan0207/omp-unity.git;
#                         pass "none" to skip, or "new" to start your own)
#   --context-repo ARG    Alias of --agent-repo; ARG = URL, "none", or "new"
#   --template-repo URL   Source used by "new" (default: the agent repo URL)
#   --shell PATH          omp shellPath (default: $SHELL, usually /bin/zsh)
#   --skip-github         Do not offer GitHub CLI login
#   --no-workspace        Do not add the bare-omp workspace wrapper
#   --devtools            Install pyright + debugpy
#   --no-devtools         Skip devtools (default)
#   --no-packages         Do not install Homebrew packages
#   --skills-dir PATH     Extra skill directory to register (optional)
#   --api-key KEY         DeepSeek API key (optional)
#   --yes                 Accept defaults; never prompt
#   -h, --help            Show this help
#
# Examples:
#   zsh omp-macos-setup-generic.sh                 # interactive, all choices
#   zsh omp-macos-setup-generic.sh --yes           # defaults, no prompts
#   zsh omp-macos-setup-generic.sh --vault ~/notes --no-cockpit
#   zsh omp-macos-setup-generic.sh --obsidian --vault ~/Documents/Obsidian Vault
#   zsh omp-macos-setup-generic.sh --agent-repo none

set -euo pipefail

SCRIPT="${0:A}"
SELF_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"

DEFAULT_AGENT_REPO="https://github.com/karikaalan0207/omp-unity.git"
TEMPLATE_REPO="${TEMPLATE_REPO:-$DEFAULT_AGENT_REPO}"
AGENT_REPO="$DEFAULT_AGENT_REPO"
NEW_CONTEXT=0
AGENT_DIR="$HOME/.omp/agent"
ZSHENV="$HOME/.zshrc"
VAULT_DIR=""
VAULT_REPO=""
SHELL_PATH="${SHELL:-/bin/zsh}"
ASSUME_YES=0
SKIP_GITHUB=0
WITH_WORKSPACE=1
INSTALL_DEVTOOLS=0
INSTALL_PACKAGES=1
INSTALL_OBSIDIAN=0
API_KEY="${DEEPSEEK_API_KEY:-}"
AGENT_REPO_SET=0
SKILL_DIR=""
WORKSPACE_SET=0
DEVTOOLS_SET=0
PACKAGES_SET=0
OBSIDIAN_SET=0

info() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'XX  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

prompt() {
  local label="$1" default="$2" reply
  if (( ASSUME_YES )) || [[ ! -t 0 ]]; then
    print -r -- "$default"
    return 0
  fi
  printf '%s' "$label"
  [[ -n "$default" ]] && printf ' [%s]' "$default"
  printf ': '
  read -r reply || reply=""
  print -r -- "${reply:-$default}"
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

usage() {
  awk 'NR > 1 && /^set -euo pipefail/ { exit } NR > 1 && /^#/ { sub(/^# ?/, ""); print }' "$SCRIPT"
  exit 0
}

while (( $# )); do
  case "$1" in
    --vault)        VAULT_DIR="${2:-}"; shift 2 ;;
    --vault=*)      VAULT_DIR="${1#--vault=}"; shift ;;
    --vault-repo)   VAULT_REPO="${2:-}"; shift 2 ;;
    --vault-repo=*) VAULT_REPO="${1#--vault-repo=}"; shift ;;
    --obsidian)     INSTALL_OBSIDIAN=1; OBSIDIAN_SET=1; shift ;;
    --no-obsidian)  INSTALL_OBSIDIAN=0; OBSIDIAN_SET=1; shift ;;
    --agent-repo)   AGENT_REPO="${2:-}"; AGENT_REPO_SET=1; shift 2 ;;
    --agent-repo=*) AGENT_REPO="${1#--agent-repo=}"; AGENT_REPO_SET=1; shift ;;
    --context-repo)   AGENT_REPO="${2:-}"; AGENT_REPO_SET=1; shift 2 ;;
    --context-repo=*) AGENT_REPO="${1#--context-repo=}"; AGENT_REPO_SET=1; shift ;;
    --template-repo)   TEMPLATE_REPO="${2:-}"; shift 2 ;;
    --template-repo=*) TEMPLATE_REPO="${1#--template-repo=}"; shift ;;
    --shell)        SHELL_PATH="${2:-}"; shift 2 ;;
    --shell=*)      SHELL_PATH="${1#--shell=}"; shift ;;
    --skip-github)  SKIP_GITHUB=1; shift ;;
    --no-cockpit|--no-workspace) WITH_WORKSPACE=0; WORKSPACE_SET=1; shift ;;
    --devtools)     INSTALL_DEVTOOLS=1; DEVTOOLS_SET=1; shift ;;
    --no-devtools)  INSTALL_DEVTOOLS=0; DEVTOOLS_SET=1; shift ;;
    --no-packages)  INSTALL_PACKAGES=0; PACKAGES_SET=1; shift ;;
    --skills-dir)   SKILL_DIR="${2:-}"; shift 2 ;;
    --skills-dir=*) SKILL_DIR="${1#--skills-dir=}"; shift ;;
    --api-key)      API_KEY="${2:-}"; shift 2 ;;
    --api-key=*)    API_KEY="${1#--api-key=}"; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
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
[[ "$(uname -m)" == "arm64" ]] || warn "Not arm64; Homebrew paths may differ."
[[ "$SHELL_PATH" == /* ]] || SHELL_PATH="/bin/$SHELL_PATH"

# ---------------------------------------------------------------- interaction
if [[ -z "$VAULT_DIR" ]] && (( ! ASSUME_YES )) && [[ -t 0 ]]; then
  VAULT_DIR="$(prompt 'Vault/notes directory (blank to skip)' '')"
fi
if [[ "$VAULT_DIR" == "~"* ]]; then
  VAULT_DIR="$HOME${VAULT_DIR#\~}"
fi
VAULT_DIR="${VAULT_DIR%/}"

if (( ! ASSUME_YES )) && [[ -t 0 ]]; then
  if (( ! AGENT_REPO_SET )); then
    AGENT_REPO="$(prompt 'Context repo (URL, "none", or "new")' "$AGENT_REPO")"
    [[ "$AGENT_REPO" == "none" ]] && AGENT_REPO=""
  fi
  if (( ! PACKAGES_SET )) && { ! have tmux || ! have node }; then
    confirm 'Install missing Homebrew packages (tmux, node, ...)?' y || INSTALL_PACKAGES=0
  fi
  if (( ! WORKSPACE_SET )); then
    confirm 'Add the bare-omp workspace wrapper?' y || WITH_WORKSPACE=0
  fi
  if (( ! DEVTOOLS_SET )); then
    confirm 'Install pyright and debugpy?' n && INSTALL_DEVTOOLS=1 || INSTALL_DEVTOOLS=0
  fi
  [[ -n "$SKILL_DIR" ]] || SKILL_DIR="$(prompt 'Extra skills directory (blank to skip)' '')"
  if (( ! OBSIDIAN_SET )); then
    confirm 'Install Obsidian (cask)?' n && INSTALL_OBSIDIAN=1 || INSTALL_OBSIDIAN=0
  fi
fi

if (( INSTALL_OBSIDIAN )) && [[ -z "$VAULT_DIR" ]]; then
  VAULT_DIR="$(prompt 'New Obsidian vault directory' "$HOME/Documents/Obsidian Vault")"
fi
if [[ "$VAULT_DIR" == "~"* ]]; then
  VAULT_DIR="$HOME${VAULT_DIR#\~}"
fi
VAULT_DIR="${VAULT_DIR%/}"

if [[ "$AGENT_REPO" == "new" ]]; then
  NEW_CONTEXT=1
  AGENT_REPO="$TEMPLATE_REPO"
fi
[[ "$AGENT_REPO" == "none" ]] && AGENT_REPO=""

# ---------------------------------------------------------------- preflight
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools are missing."
  xcode-select --install || true
  die "Finish the Command Line Tools install, then rerun this script."
fi

# ---------------------------------------------------------------- Homebrew
if ! have brew; then
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi
if ! have brew; then
  if confirm 'Homebrew is missing. Install it?' y; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ -x /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    else
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  else
    warn "Continuing without Homebrew; install tmux/node yourself if you want the cockpit."
  fi
fi

if (( INSTALL_PACKAGES )) && have brew; then
  info "Installing git, gh, node, python, tmux"
  for spec in git:git gh:gh node:node python:python3 tmux:tmux; do
    pkg="${spec%%:*}"
    bin="${spec##*:}"
    if have "$bin"; then
      continue
    fi
    brew install "$pkg" || warn "brew install $pkg failed; continuing."
  done
fi

if (( INSTALL_OBSIDIAN )); then
  if [[ -d "/Applications/Obsidian.app" ]]; then
    info "Obsidian is already installed"
  elif have brew; then
    info "Installing Obsidian"
    brew install --cask obsidian || warn "Obsidian install failed; install it from https://obsidian.md"
  else
    warn "Homebrew is unavailable; install Obsidian from https://obsidian.md"
  fi
fi

# ---------------------------------------------------------------- omp
if ! have omp; then
  info "Installing omp"
  installed=0
  if have brew && confirm 'Install omp with Homebrew?' y; then
    brew install can1357/tap/omp && installed=1 || warn "Homebrew install failed; trying the official installer."
  fi
  if (( ! installed )); then
    curl -fsSL https://omp.sh/install | sh || die "omp install failed."
  fi
fi
[[ -d "$HOME/.local/bin" ]] && PATH="$HOME/.local/bin:$PATH"
have omp || die "omp was not found on PATH; open a new shell and rerun."
omp --version >/dev/null || die "omp is installed but does not run on this Mac."

# ---------------------------------------------------------------- GitHub
if (( ! SKIP_GITHUB )) && have gh; then
  if ! gh auth status >/dev/null 2>&1; then
    if confirm 'Set up GitHub login now? (needed to clone/bootstrap repos)' y; then
      gh auth login --hostname github.com --git-protocol https --web
      gh auth setup-git || warn "Could not configure the git credential helper."
    fi
  fi
fi

# ---------------------------------------------------------------- agent config
if [[ -n "$AGENT_REPO" ]]; then
  info "Context repo: $AGENT_REPO"
  mkdir -p "$HOME/.omp"
  if (( NEW_CONTEXT )) && [[ -e "$AGENT_DIR" ]]; then
    backup="$AGENT_DIR.bak.$(date +%Y%m%d%H%M%S)"
    mv "$AGENT_DIR" "$backup"
    info "Backed up existing agent dir to $backup"
  fi
  if (( ! NEW_CONTEXT )) && [[ -d "$AGENT_DIR/.git" ]]; then
    git -C "$AGENT_DIR" pull --ff-only || warn "Agent config pull failed; keeping the local copy."
  else
    if [[ -e "$AGENT_DIR" ]]; then
      backup="$AGENT_DIR.bak.$(date +%Y%m%d%H%M%S)"
      mv "$AGENT_DIR" "$backup"
      info "Backed up existing agent dir to $backup"
    fi
    if ! git clone "$AGENT_REPO" "$AGENT_DIR"; then
      warn "Context repo clone failed; continuing without shared settings."
      warn "If the repo is private, run 'gh auth login' (and ask the owner to add you as a collaborator), then rerun."
    fi
  fi
  if (( NEW_CONTEXT )) && [[ -d "$AGENT_DIR/.git" ]]; then
    rm -rf "$AGENT_DIR/.git"
    git -C "$AGENT_DIR" init -q
    if git -C "$AGENT_DIR" config user.name >/dev/null 2>&1 && git -C "$AGENT_DIR" config user.email >/dev/null 2>&1; then
      git -C "$AGENT_DIR" add -A
      git -C "$AGENT_DIR" commit -qm "chore: start my omp context"
      info "Initialized your own context repo at $AGENT_DIR"
    else
      warn "Set git user.name and user.email, then commit $AGENT_DIR."
    fi
    info "Publish it with: gh repo create <name> --private --source \"$AGENT_DIR\" --push"
  fi
else
  info "Skipping context repo."
fi

# Keep the cockpit machinery in the context repo even when the repo only
# carries personal context and no launchers or extension.
OVERLAY_DIR="$(cd "$SELF_DIR/.." && pwd)"
if [[ -d "$AGENT_DIR" && -f "$OVERLAY_DIR/launchers/cockpit-viewer.mjs" ]]; then
  mkdir -p "$AGENT_DIR/launchers" "$AGENT_DIR/extensions" "$AGENT_DIR/setup" "$AGENT_DIR/lib"
  for f in VERSION lib/unity-store.mjs lib/unity-cli.mjs launchers/omp-unity-macos.sh launchers/omp-unity-wsl.sh launchers/cockpit-viewer.mjs launchers/unity-board.mjs extensions/cockpit-state.ts setup/omp-unity-bootstrap.sh setup/omp-unity-update.sh setup/omp-unity-wsl-setup.sh; do
    if [[ ! -f "$AGENT_DIR/$f" && -f "$OVERLAY_DIR/$f" ]]; then
      cp "$OVERLAY_DIR/$f" "$AGENT_DIR/$f" && info "Installed $f"
    fi
  done
elif [[ -d "$AGENT_DIR" && ! -f "$AGENT_DIR/launchers/omp-unity-macos.sh" ]]; then
  warn "No cockpit assets in this context repo and none bundled with the installer."
fi

# ---------------------------------------------------------------- vault
if [[ -n "$VAULT_DIR" ]]; then
  info "Vault: $VAULT_DIR"
  if [[ -d "$VAULT_DIR/.git" ]]; then
    if [[ -n "$VAULT_REPO" ]]; then
      git -C "$VAULT_DIR" pull --ff-only || warn "Vault pull failed; keeping the local copy."
    fi
  elif [[ -e "$VAULT_DIR" ]]; then
    if [[ -d "$VAULT_DIR" ]]; then
      warn "$VAULT_DIR exists but is not a git repo; using it as-is."
    else
      warn "$VAULT_DIR is a file, not a directory; skipping vault integration."
      VAULT_DIR=""
    fi
  elif [[ -n "$VAULT_REPO" ]]; then
    git clone "$VAULT_REPO" "$VAULT_DIR" || { warn "Vault clone failed; skipping vault integration."; VAULT_DIR=""; }
  elif mkdir -p "$VAULT_DIR" 2>/dev/null; then
    info "Created $VAULT_DIR"
  else
    warn "Could not create $VAULT_DIR; skipping vault integration."
    VAULT_DIR=""
  fi
fi

# ---------------------------------------------------------------- unity state
if [[ -n "$VAULT_DIR" ]]; then
  UNITY_CLI="$SELF_DIR/../lib/unity-cli.mjs"
  if [[ -f "$UNITY_CLI" ]] && have node; then
    node "$UNITY_CLI" init "$VAULT_DIR" || warn "Could not initialize $VAULT_DIR/Unity."
    if [[ -n "$SKILL_DIR" ]]; then
      node "$UNITY_CLI" registry-skill "$VAULT_DIR" "$(basename "$SKILL_DIR")" "$SKILL_DIR" \
        || warn "Could not register the skill directory."
    fi
  fi
fi

# ---------------------------------------------------------------- context
BOOTSTRAP="$AGENT_DIR/setup/omp-unity-bootstrap.sh"
if [[ ! -f "$BOOTSTRAP" && -f "$SELF_DIR/omp-unity-bootstrap.sh" ]]; then
  BOOTSTRAP="$SELF_DIR/omp-unity-bootstrap.sh"
fi
if [[ -f "$BOOTSTRAP" ]]; then
  info "Bootstrapping the environment context"
  bootstrap_args=(--shell "$SHELL_PATH")
  [[ -n "$VAULT_DIR" ]] && bootstrap_args+=(--vault "$VAULT_DIR")
  (( WITH_WORKSPACE )) || bootstrap_args+=(--no-workspace)
  zsh "$BOOTSTRAP" "${bootstrap_args[@]}" || warn "Context bootstrap failed; rerun: zsh $BOOTSTRAP"
else
  warn "Context bootstrap script not found; skipping AGENTS.local.md/config.local.yml."
fi
if [[ -f "$AGENT_DIR/config.local.yml" ]]; then
  export PI_CONFIG_FILES="$AGENT_DIR/config.local.yml"
fi

if (( INSTALL_DEVTOOLS )); then
  info "Installing pyright and debugpy"
  npm install -g pyright || warn "pyright install failed; LSP will fall back."
  mkdir -p "$HOME/.omp/bin"
  if have python3; then
    ln -sf "$(command -v python3)" "$HOME/.omp/bin/python"
    if ! grep -qF '.omp/bin' "$ZSHENV" 2>/dev/null; then
      printf '\n# omp python adapter\nexport PATH="$HOME/.omp/bin:$PATH"\n' >> "$ZSHENV"
    fi
    export PATH="$HOME/.omp/bin:$PATH"
    python3 -m pip install --user --break-system-packages debugpy \
      || warn "debugpy install failed; run: python3 -m pip install --user --break-system-packages debugpy"
  fi
fi

# ---------------------------------------------------------------- API key
if [[ -z "$API_KEY" ]] && (( ! ASSUME_YES )) && [[ -t 0 ]]; then
  printf 'DeepSeek API key (blank to skip): '
  read -rs API_KEY || API_KEY=""
  printf '\n'
fi
if [[ -n "$API_KEY" ]] && ! grep -qF 'DEEPSEEK_API_KEY' "$HOME/.omp/env" 2>/dev/null; then
  umask 077
  mkdir -p "$HOME/.omp"
  printf 'export DEEPSEEK_API_KEY=%q\n' "$API_KEY" >> "$HOME/.omp/env"
  chmod 600 "$HOME/.omp/env"
fi

# ---------------------------------------------------------------- verify
info "Checking"
omp --version
if [[ -n "$VAULT_DIR" ]]; then
  (cd "$VAULT_DIR" && omp skill list) || warn "Skill discovery failed; check the vault's .omp/config.yml."
fi

cat <<EOF

Done.

Next:
  1. Open a new Terminal, or run: source ~/.zshrc
  2. Start omp:
       cd "${VAULT_DIR:-$HOME}" && omp
  3. If provider auth is missing, use /login inside omp, or put
       export DEEPSEEK_API_KEY=...
     in ~/.omp/env.
  4. Re-run the environment bootstrap any time:
       zsh ~/.omp/agent/setup/omp-unity-bootstrap.sh

Vault:  ${VAULT_DIR:-<none>}
Agent:  ${AGENT_DIR}
EOF

if (( INSTALL_OBSIDIAN )); then
  printf 'Obsidian: open the app, choose "Open folder as vault", and pick %s\n' "${VAULT_DIR:-<none>}"
fi
