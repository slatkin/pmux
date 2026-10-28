# Proposal

## Why

A subagent spawned with the `tab` placement gets a tmux window that pmux
never names. `createSurface` runs `new-window` without `-n`, so the window
name falls to tmux's `automatic-rename`, which shows the running command —
`zsh` at split time, then `node` once the wrapper starts. Every pmux tab
therefore reads `node` (or a shell) in the window list, and a session with
several tabs cannot be told apart. The pane inside the window *is* titled
(`select-pane -T <name>`), but a pane title only shows on the pane border —
and a single-pane window typically shows no border title at all. The name
the user gave the subagent is invisible exactly where they look for it.

## What Changes

- **Changed: `tab` creation names the window.** The `new-window` call in
  `createSurface` gains `-n <name>`, the same display name that becomes the
  pane title. tmux keeps the name: a window named explicitly at creation
  has `automatic-rename` disabled for that window, so the child's boot —
  shell start, wrapper start, the OSC title the run wrapper writes — cannot
  overwrite it.
- **All launch paths inherit it.** `pmux_spawn` (supervisor), `cli.ts
  start` and `cli.ts resume` all reach the window through `createSurface`;
  `--name` on `resume` renames the window alongside the pane.

Not in scope: naming windows for `pane` or `float` placements (the caller's
window is the user's own and must keep its name), renaming existing unnamed
tabs, a config or role switch (naming is cosmetic and always on, like
`namePane`), and window-name formats beyond the plain display name.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `tmux-backend`: a new "Named tab windows" requirement — a `tab`-placement
  surface's window carries the subagent's name and keeps it for the
  window's life.

## Impact

- `pi-extension/pmux/tmux.ts`: one line in the `tab` branch of
  `createSurface` (`-n <name>` when the name is non-empty), plus a comment.
- Tests: `test/tmux.test.ts` gains a case asserting the `new-window` argv;
  the existing `cli.test.ts` tab case asserts the name in the recorded
  command.
- `README.md`/`docs/guide.md`: a sentence where they describe the `tab`
  placement, if the wording invites it.
- No change to `pmux-done.ts`, the `PI_PMUX_*` variables or the `.exit`
  format, so the `external-orchestration` contract is untouched.
