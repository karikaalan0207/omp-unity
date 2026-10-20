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

The main tab is the workspace:

```text
┌───────────────────────┬───────────────────────┐
│                       │  cockpit viewer       │
│  omp chat             │                       │
│                       ├───────────────────────┤
│                       │  Unity board          │
└───────────────────────┴───────────────────────┘
```

Opening an item creates a **chat-only tab** for that item. The board stays in
the main tab; quitting the item chat closes its tab. `Ctrl-b l` returns to the
main tab; `[` `]` switch tabs from the board.

## Getting in and out

Run `omp` from a normal Terminal to attach to the `unity` session; if it does
not exist, the workspace is created. Do not run it from inside an omp pane
(`OMP_COCKPIT_DIR` set) — that starts a nested omp instead.

- Quitting the chat (`/quit` or Ctrl-D) closes its whole tab
- Closing the terminal (detach) closes the workspace by default
- Keep it across detach: `UNITY_KEEP=1 omp`; then `omp` reattaches
- Re-enter: `omp`
- Close the current tab: `x` in the board, then `y`
- Back to the previous tab: `Ctrl-b l`
- Kill the workspace: `tmux kill-session -t unity`

The workspace opens with focus on the board. `Tab` cycles board → omp → viewer;
`Ctrl-b` + arrows also moves panes; clicking a pane focuses it. The selected
row is highlighted and marked `▶`.

## Navigation

Board (`unity-board.mjs`):

| Key | Action |
|---|---|
| `j` / `k`, arrows | move |
| `space` / `s` | toggle focus ↔ stash |
| `enter` | open the item; resumes its saved session or seeds one |
| `R` | start a fresh session for the item, with context |
| `n` / `p` | new item / new project (type, then Enter) |
| `[` / `]` | previous / next workspace tab |
| `q` | quit the board |
| `prefix + arrow` | move focus between omp, viewer, and board |
| `prefix + z` | zoom the focused pane |

Viewer: `n` new tab, `f` fork the session, `q` quit.
tmux: `prefix + l` returns to the previous tab, `prefix + n/p` cycles tabs.

## Adding, editing, deleting

Everything happens in the board pane:

- `n` new item (inherits the selected item's project; otherwise inbox)
- `p` new project
- `v` switch between items and projects; `enter` on a project starts a new item there
- `r` rename selected item/project
- `m` move selected item to another project (`inbox` clears it)
- `d` delete selected item/project (asks `y/n`); deleting a project moves its items to inbox
- `space` toggle focus/stash, `enter` open

From Obsidian you can still create `Unity/items/<id>.md` with the frontmatter
below; the board picks it up on the next refresh.

## Updates

```bash
zsh ~/.omp/agent/setup/omp-unity-update.sh --check
zsh ~/.omp/agent/setup/omp-unity-update.sh
```

`u` in the board runs the same update in a tmux popup. It refreshes the Unity
runtime (launcher, board, viewer, store, extension, bootstrap, updater) from
the public repo. Your context repo, AGENTS.local.md, skills, and vault are
never touched. Restart the workspace afterwards.

## Sessions

Opening an item:

- no session: starts omp with an item context pack (title, project, status,
  file, item notes, sibling items);
- session: resumes it with `omp --resume <file>`.

`R` in the board starts a **fresh** session instead. It feeds the same context
pack plus a brief of the previous session (last user/assistant messages), so
you can iterate without inheriting the old thread.

The live session path is stored in the item's `session:` field by the
extension on `session_start`. The board marks resumable items with `↻`. If the
file is gone, the link is cleared and a fresh seeded session starts.

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
status: focus           # focus | stash
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
