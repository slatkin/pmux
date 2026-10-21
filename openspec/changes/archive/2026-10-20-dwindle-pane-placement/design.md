# Design

## Context

`createSurface(name, placement, caller)` in `pi-extension/pmux/tmux.ts` is the one place where both launch paths make a pane. The supervisor (pi parent) and `cli.ts start/resume` (external orchestrator) both call it with the caller's pane id. Today it always splits `caller` with `-h` or `-v`, and the direction comes from `SurfacePlacement = "right" | "down" | "tab"` in `placement.ts`. See proposal.md for the motivation, and the spec deltas for the required behaviour.

The external orchestrator runs one short `cli.ts` process per launch, so it keeps no memory between launches. Any "newest child" state must therefore survive outside the process.

## Goals / Non-Goals

**Goals:**
- One implementation of the target and axis rule, inside `createSurface`, used by all four call sites (spawn, resume, `start`, `resume`).
- No pmux-owned state file and no in-memory pane bookkeeping for placement.

**Non-Goals:**
- `floating` placement.
- Placement for `tab`: it keeps today's behaviour (a new window in the caller's session, focus restored).
- Rebalancing when a pane closes. tmux decides where the freed space goes.

## Decisions

### 1. Record parentage on the pane itself (tmux pane user option)

After each `pane` split, pmux sets the pane user option `@pmux_parent` on the new pane to the caller's pane id (`set-option -p -t <new> @pmux_parent <caller>`). To find the target, pmux lists the panes of the caller's window with one call:

```
list-panes -t <caller> -F '#{pane_id} #{pane_width} #{pane_height} #{@pmux_parent}'
```

The candidates are the rows where `@pmux_parent` equals the caller. The newest candidate is the one with the highest numeric pane id: tmux gives pane ids from one counter per server, so a higher id means a newer pane. With no candidate, the target is the caller's own row. The same row gives the width and height for the axis rule, so the placement costs one extra tmux call before the split and one after it.

This gives the spec behaviour with no extra logic:
- A closed pane is not in the list.
- A pane moved to another window is not in the list (`list-panes -t <caller>` lists the caller's window only).
- A grandchild has `@pmux_parent` set to its own parent, so it never matches the grandparent.

Alternatives considered:
- *In-memory `runningSubagents` order (pi path) plus a per-window state file (CLI path).* This needs two implementations, a file format, liveness checks with `paneExists`, and cleanup of stale files. Rejected.
- *Pane titles as markers.* Titles are the agent names and the user can change them. Rejected.
- *Read `#{window_layout}` and walk the tree.* This finds geometry but not parentage. Rejected.

The pane option is set only for `pane` splits, not for `tab`. A `tab` child is in another window, so it can never be a target anyway.

### 2. Axis rule: `width >= 2 * height` -> side by side, else stacked

The axis is computed from the target row just before the split. The factor 2 is a fixed approximation of the terminal cell's height-to-width ratio. pmux does not measure the font. An exact tie goes side by side, which matches today's default `right`. This is the dynamic rule of Hyprland's dwindle. A fixed alternation was rejected because it needs the depth, which a nested agent does not know, and because it breaks after the user closes a pane: tmux gives the freed space to a neighbour, so the counter no longer matches the target's shape.

Example on a 200x50 window: split `%0` right -> `%1` 100x50, split `%1` down -> `%2` 100x25, split `%2` right -> `%3` 50x25, and so on, which is the spiral.

### 3. Placement type and parsing

`SurfacePlacement` becomes `"pane" | "tab"` and `DEFAULT_SURFACE_PLACEMENT` becomes `"pane"`. `parseSurfacePlacement` maps `"pane"`, `"right"` and `"down"` to `"pane"`, maps `"tab"` to `"tab"`, and returns `undefined` for anything else. Every reader (`parseSurfaceConfig`, `resolveSurfacePlacement`, `/pmux-surface`, the CLI `--surface` check) already goes through this function, so the legacy mapping is in one place. `writeSurfaceConfig` writes only the parsed value, so a legacy config is rewritten as `"pane"` the next time the user sets it.

`SplitDirection` and `splitPane(caller, direction)` stay. `splitPane` is a separate bare-split helper and is not part of the placement path.

### 4. Tool schema and text

The `surface` parameter of `pmux_spawn` and `pmux_resume` becomes `Type.Union([Type.Literal("pane"), Type.Literal("tab")])`. The sentence "Set placement with the surface parameter." is removed from both tool descriptions, and the promptSnippets no longer mention placement. The parameter description says that `pane` (the default) places the pane automatically and `tab` opens a window.

## Risks / Trade-offs

- [The pane-id order assumption is wrong on some tmux version] -> tmux has given ids from a monotonic per-server counter for a long time, and pmux uses it only to order panes in one window. The tests cover the ordering with ids that sort differently as strings and as numbers (`%9` vs `%10`).
- [Pane user options need tmux 3.0 or later] -> the backend is tested on tmux 3.8. If `set-option -p` fails, the split has already happened, so the error is caught like the naming error. The new pane is then not a candidate for later spawns, which split an older child or the caller instead. The child still runs.
- [Deep spirals make the newest pane too small to split] -> tmux refuses the split ("no space for new pane"), and `createSurface` throws as it does today when the caller's pane is too small. No fallback to another target: the spec names one target, and a silent change of target would break the spawn order.
- [The 2:1 cell ratio is wrong for some fonts] -> the error only moves the break-even point. The result is still a valid split with no lost panes. Accepted.
- [A user who relied on `down` to always stack loses that] -> this is the intended breaking change. `tab` stays available.
- [`list-panes` output contains a pane whose `@pmux_parent` is unset] -> the format prints an empty field, and that row is never a candidate.

## Migration Plan

No data migration. Old `config.json` values `right` and `down` are read as `pane`. Rollback is a revert of the change. Old configs keep working, because the old code reads `"pane"` as `right`.
