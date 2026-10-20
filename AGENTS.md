# Agent context

Minimal always-on context. Load details on demand.

## Defaults

- Terse, evidence-first: conclusion first, then evidence. No filler or flattery.
- Stay in scope. No unrequested refactors, files, or docs.
- Reproduce before fixing; verify with a real run before claiming done.
- Never commit, push, or rewrite history unless explicitly asked.
- Keep machine paths in `AGENTS.local.md`, not here.

## Workspace

- Unity state lives in `<vault>/Unity/`: `board.md`, `items/`, `projects/`,
  `sessions/`, `registry.yml`.
- The cockpit extension writes live session state to `OMP_COCKPIT_DIR`.
- Opening an item resumes its recorded omp session; update the item when the
  work moves.
