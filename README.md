# omp-unity

An Obsidian-backed workspace for omp: focus, items, projects, and a cockpit in
one tmux tab. Every tab is a workspace; every item can carry its own omp session.

## Install (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/karikaalan0207/omp-unity/main/setup/omp-unity-setup.sh -o /tmp/omp-unity-setup.sh
zsh /tmp/omp-unity-setup.sh
```

Run it as yourself, never with `sudo`. It asks, in order:

1. GitHub login (only if `gh` is not authenticated) so context repos can be cloned.
2. Vault/notes directory. Obsidian is optional; a plain folder works.
3. Context repo: `omp-unity` (default), a git URL, `none`, or `new`.
   `new` clones the template, drops its history, initializes `~/.omp/agent`, and
   prints the `gh repo create` command for publishing it.
4. Obsidian (optional cask), extra skills directory, cockpit wrapper, devtools,
   packages, API key.

Every choice has a flag; see `--help`. `--yes` uses defaults.

The installer overlays the Unity runtime into the context repo, so a
context-only repo still gets the launcher, viewer, board, extension, and
bootstrap.

## Layout

One tmux window per workspace tab:

```text
┌───────────────────────┬───────────────────────┐
│                       │  cockpit viewer       │
│  omp chat             │                       │
│                       ├───────────────────────┤
│                       │  Unity board          │
└───────────────────────┴───────────────────────┘
```

## Navigation

Board (`unity-board.mjs`):

| Key | Action |
|---|---|
| `j` / `k`, arrows | move |
| `space` / `s` | cycle status: todo → active → done → blocked |
| `enter` | open the item in a new tab, resuming its session if one exists |
| `f` | set the focused item |
| `n` / `p` | new item / new project (type, then Enter) |
| `[` / `]` | previous / next workspace tab |
| `q` | quit the board |

Viewer: `n` new tab, `f` fork the session, `q` quit.
tmux: `prefix + l` returns to the previous tab, `prefix + n/p` cycles tabs.

## Obsidian schema

The vault gets a `Unity/` directory. Create it by hand or let the bootstrap do it:

```text
<vault>/Unity/
  board.md              # focus: <item-id>
  items/<id>.md
  projects/<id>.md
  sessions/<id>.md      # optional notes
  registry.yml          # skills and repos
```

Item frontmatter:

```yaml
---
id: fix-navigation
title: Fix navigation
status: active          # todo | active | blocked | done
project: omp-unity
session: /Users/me/.omp/agent/sessions/....jsonl
created: 2026-10-20T08:00:00.000Z
updated: 2026-10-20T08:05:00.000Z
---
```

Opening an item writes `status: active` and, once omp starts, the live session
file. The next `enter` resumes it with `omp --resume`.

`registry.yml`:

```yaml
skills:
  - name: my-skill
    path: /absolute/path/to/skill
repos:
  - name: my-vault
    url: https://github.com/me/my-vault.git
```

The bootstrap links each `skills[].path` into `~/.omp/agent/skills/<name>`.

## Re-run the bootstrap

```bash
zsh ~/.omp/agent/setup/omp-unity-bootstrap.sh
```

It is idempotent and writes `AGENTS.local.md`, `config.local.yml`, `~/.omp/env`,
the zsh wiring, the Unity directories, the board, and the skill links.

## Repo split

- `omp-unity` (this repo): generic installer, bootstrap, cockpit, board, store.
- Your context repo (private): `AGENTS.md`, `CONTEXT.md`, rules, commands, skills.

Pass `--context-repo URL` to use a personal repo, or `--context-repo new` to
start one from this template.
