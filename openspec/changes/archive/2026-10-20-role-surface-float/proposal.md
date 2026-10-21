# Proposal

## Why

Some roles fit a surface better than the global default. For example, a short reviewer is easier to watch in a float than in a tiled pane. Today a role file cannot ask for a surface, and pmux cannot open a floating pane. tmux 3.8 has real floating panes (`new-pane`), so pmux can add a `float` surface. That surface must not become a default for all agents, because many floats on top of the tiled panes are messy.

## What Changes

- New role frontmatter key `surface:` with the values `pane`, `tab` or `float`. An invalid value is ignored, and the role then has no surface preference.
- New surface value `float`. A float is a tmux floating pane in the caller's window: half the window width and half the window height, at the top right, with 1 row of padding at the top and 2 columns at the right. The caller keeps the focus.
- Cascade: each new pmux float opens 1 row lower and 2 columns further left than the newest living pmux float in the window. If it does not fit in the window, it opens at the top-right anchor again. Floats that the user opens are ignored.
- `float` is accepted per call (the tool `surface` parameter and `--surface`) and in a role file. It is NOT accepted as a default: `config.json` and `/pmux-surface` keep `pane | tab`, and `/pmux-surface float` is rejected.
- Precedence: per-call value, then the role's `surface:`, then the `config.json` default.
- Resume keeps the role's surface: the value is stored in the launch record (pi parent) and in the launch spec (external orchestrator) when the child starts. A record or spec without it falls back to the config default.
- The dwindle split target search skips floating panes.
- A `pane` child of a floating caller becomes an adjacent float, because tmux splits a floating target that way. This is documented, not changed.
- tmux 3.8 or later is assumed. There is no fallback for older tmux.

This change builds on `2026-10-20-dwindle-pane-placement` (the `pane | tab` values, the `@pmux_parent` tag and the one `list-panes` call). It must be applied and archived after that change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tmux-backend`: the split target search skips floating panes; new requirements for float placement and the cascade.
- `luvus-surface`: `float` as a per-call and role value but not a default; the role `surface:` key and the precedence order.
- `external-orchestration`: role resolution reads `surface:`; `--surface float`; resume uses the surface stored in the launch spec.
- `subagent-supervision`: the launch record stores the role's surface, and `pmux_resume` uses it.

## Impact

- `pi-extension/pmux/placement.ts`: the `float` value, and a separate parser for defaults that rejects it.
- `pi-extension/pmux/agent-defs.ts`: the `surface` frontmatter key.
- `pi-extension/pmux/tmux.ts` `createSurface`: the float branch, the cascade, and the floating-row filter for dwindle.
- `pi-extension/pmux/index.ts`, `supervisor.ts`: placement resolved after the role is loaded; the tool schema adds `float`; `/pmux-surface` rejects `float`.
- `pi-extension/pmux/cli.ts`, `launch.ts`: `--surface float`; the role surface stored in the launch spec and used by `resume`.
- `pi-extension/pmux/launch-record.ts`: the optional `surface` field.
- `skills/pmux/SKILL.md`, `README.md`, `agents/*.md` docs: the new key and value.
- Tests: `test/tmux.test.ts`, `test/tmux-fakes.ts`, `test/test.ts`, `test/cli.test.ts`, `test/supervisor.test.ts`.
