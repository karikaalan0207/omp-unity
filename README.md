# omp-unity

An Obsidian-backed workspace for omp: focus, items, projects, per-target todos,
and a cockpit in one tmux workspace. Every tab carries its own omp session; the
vault carries the state needed to continue on another machine.

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

## Install (Windows via WSL2)

The Windows port runs the workspace inside WSL2 Ubuntu. Windows Terminal is the
host; tmux inside WSL owns the tabs and panes. omp, the board, and the viewer all
run in Linux. Windows commands and GUI tools still work through WSL interop.

Requirements: Windows 11, WSL2 Ubuntu, Windows Terminal, and optionally
Obsidian on Windows.

From a WSL Ubuntu shell:

```bash
curl -fsSL https://raw.githubusercontent.com/karikaalan0207/omp-unity/main/setup/omp-unity-wsl-setup.sh -o /tmp/omp-unity-wsl-setup.sh
bash /tmp/omp-unity-wsl-setup.sh --vault "C:\Users\<you>\Karikaalan's Vault"
```

`--vault` accepts a Windows path or a WSL path. The installer converts it with
`wslpath` and writes the WSL path into `AGENTS.local.md`.

The default context repo is the public `omp-unity` template. To use a private
context repo:

```bash
gh auth login
bash /tmp/omp-unity-wsl-setup.sh \
  --vault "C:\Users\<you>\Karikaalan's Vault" \
  --context-repo https://github.com/karikaalan0207/omp-config.git
```

The vault stays on the Windows filesystem so Obsidian opens it natively. WSL
sees it through `/mnt/c`; writes are slower than a native Linux filesystem, but
the board only touches small Markdown files.

Start it from WSL:

```bash
omp
```

Or from Windows, with a Windows Terminal profile:

```json
{
  "name": "omp unity",
  "commandline": "wsl.exe -- zsh -lic \"exec ~/.omp/agent/launchers/omp-unity-wsl.sh\""
}
```

A `windows\omp-unity.cmd` entrypoint is included for a Windows checkout. Set
`OMP_WSL_DISTRO` if Ubuntu is not the default distro.

Windows tools remain available from the WSL shell:

```bash
cmd.exe /c ver
powershell.exe -NoProfile -Command "Get-ComputerInfo"
winget.exe install ...
```

## Layout

The parent tab is the global board:

```text
┌───────────────────────┬───────────────────────┐
│                       │  cockpit viewer       │
│  omp chat             │                       │
│                       ├───────────────────────┤
│                       │  Unity board          │
└───────────────────────┴───────────────────────┘
```

An item or project opens its own tab. The tab keeps the chat and viewer, but
the lower-right Unity panel becomes that target's **todos and handoff**:

```text
┌───────────────────────┬───────────────────────┐
│                       │  cockpit viewer       │
│  target omp session   │                       │
│                       ├───────────────────────┤
│                       │  todos · docs · state │
└───────────────────────┴───────────────────────┘
```

`g` in the target panel returns to the parent board. `[` `]` switch tabs,
`Tab` cycles panes, and `Ctrl-b l` returns to the previous tab.

## Getting in and out

Run `omp` from a normal Terminal to attach to the `unity` session; if it does
not exist, the workspace is created. Do not run it from inside an omp pane
(`OMP_COCKPIT_DIR` set) — that starts a nested omp instead.

- Quitting a target chat (`/quit` or Ctrl-D) closes its tab; its session is saved
- Detaching the workspace pauses every running item/project session and closes
  the workspace by default
- Re-enter with `omp`; the board shows each target as paused/running, and
  `enter` resumes it
- Keep the workspace across detach: `UNITY_KEEP=1 omp`; then `omp` reattaches
- Exit and pause everything: `x` or `q` in the parent board, then `y`
- Kill without the UI: `tmux kill-session -t unity`

The workspace opens with focus on the board. `Tab` cycles board → omp → viewer;
`Ctrl-b` + arrows also moves panes. Clicking a pane works: `mouse` is enabled
per workspace session, never globally.

## Navigation

Parent board (`unity-board.mjs`):

| Key | Action |
|---|---|
| `j` / `k`, arrows | move |
| `space` | toggle this item's focus ↔ stash (multiple items can be focused) |
| `enter` | open the selected item/project; resumes or starts its session |
| `N` | start a fresh session with context |
| `p` | pause the selected session (keeps the transcript) |
| `s` | stop the selected session (clears the link; asks `y/n`) |
| `n` / `P` | new item / new project (type, then Enter) |
| `v` | switch items ↔ projects |
| `d` / `r` / `m` | delete / rename / move |
| `x` / `q` | exit workspace (pauses all sessions; asks `y/n`) |
| `[` / `]` | previous / next tab |
| `Tab` | next pane |
| `u` | update the runtime |
| `?` | help |
| `Ctrl-W` | delete a word while typing |

Item/project Unity panel:

| Key | Action |
|---|---|
| `j` / `k`, arrows | move |
| `space` / `enter` | toggle todo done |
| `a` | add todo |
| `r` / `d` | rename / delete todo (delete asks `y/n`) |
| `o` | open `handoff.md` |
| `g` | back to the parent workspace |
| `x` / `q` | pause this tab and close it (asks `y/n`) |
| `s` | stop this session (clears the link) |
| `[` / `]` / `Tab` | tabs / next pane |
| `?` | help |

Hints are contextual: they change with the selected row, whether a session is
running or paused, the current view, and input/confirm mode. The parent board
shows `●` for running, `⏸` for paused, `☑` todo progress, and `▶` for focus.

Viewer: `n` new tab, `f` fork the session, `q` quit.

## Todos and documentation

Each target owns a markdown file plus a state directory:

```text
<vault>/Unity/
  board.md
  items/<id>.md                  # frontmatter + todos + notes
  items/<id>/
    README.md                    # human-readable documentation
    handoff.md                   # current state / next step / decisions
    state.yml                    # machine-readable progression and session state
    session.jsonl                # portable transcript (when a session exists)
  projects/<id>.md
  projects/<id>/...
  sessions/                      # legacy notes/session copies
  registry.yml                   # skills and repos
```

`items/<id>.md` and `projects/<id>.md` keep the todos as normal Obsidian
checkboxes:

```markdown
## Todos
- [ ] first step
- [x] second step
```

The Unity panel edits those same checkboxes. `state.yml` is maintained by the
store (status, session state, todo counts, next step, updated). `handoff.md` is
maintained by you and the assistant: the assistant is instructed to keep its
current state and next step current. The `<!-- unity:auto -->` marker makes the
Next step line follow the first open todo; remove the marker to freeze it.
`README.md` is freeform project/item documentation.

## Sessions

Opening an item or project:

- no session: starts omp with a context pack (title, project, status, file,
  notes, todos, handoff, sibling items);
- session: restores it with `omp --restore <file>`. `N` in the board starts a
  fresh seeded session instead, including a brief of the previous session.

The extension writes the live session into the target's frontmatter on
`session_start`:

```yaml
session: Unity/items/fix-navigation/session.jsonl   # portable, vault-relative
session_local: /Users/me/.omp/agent/sessions/....jsonl # this machine only
session_state: running                              # running | paused | stopped
```

The transcript is copied into the target directory after turns and on
shutdown/pause. Because the transcript, state, todos, and handoff all live in
the vault, another machine with the same Unity setup can open the item,
resolve the portable session copy, and continue — even though the absolute
local session path does not exist there.

The board marks resumable targets with `●` / `⏸`. If neither the local nor the
portable file exists, the link is cleared and a fresh seeded session starts.

## Updates

```bash
zsh ~/.omp/agent/setup/omp-unity-update.sh --check
zsh ~/.omp/agent/setup/omp-unity-update.sh
```

`u` in the board runs the same update in a tmux popup. It refreshes the Unity
runtime (launcher, board, viewer, store, extension, bootstrap, updater) from
the public repo. Your context repo, AGENTS.local.md, skills, and vault are
never touched. Restart the workspace afterwards.

## Session and tmux hygiene

- All tmux options are set per workspace session: `mouse`, `pane-border-status`,
  `destroy-unattached`, and the status line. No global options, key bindings, or
  mouse bindings are written.
- Per-window cockpit state lives under `$TMPDIR/omp-unity-<session>-<pid>/` and
  is removed with the window; the launcher removes the root on exit, and sweeps
  stale roots whose session is gone on the next launch.
- Detach pauses all running sessions before the workspace is torn down; the
  next launch reconciles any session whose tab disappeared.
- `UNITY_KEEP=1` skips the teardown so the workspace and its sessions survive
  detach.

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
