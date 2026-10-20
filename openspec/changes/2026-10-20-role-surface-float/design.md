# Design

## Context

This change builds on `2026-10-20-dwindle-pane-placement`. After that change:

- `SurfacePlacement` is `"pane" | "tab"`.
- `createSurface(name, placement, caller)` in `tmux.ts` makes one `list-panes -t <caller>` call to choose the split target, and it sets `@pmux_parent` on each new tiled pane.

Today the placement is resolved before the role is known:

- pi parent: `index.ts` calls `resolveSurfacePlacement(params.surface)` before `supervisor.spawn` loads the role with `loadAgentDefaults(params.agent)`. The same happens for `resume`.
- CLI: `cli.ts` resolves `--surface` or `config.json` before `startCommand` loads the role.

The launch record (`launch-record.ts`) and the launch spec (`launch.ts`) are validated into explicit objects, so a reader drops any key it does not know.

On tmux 3.8, I measured these facts on a throwaway server with a private socket:

- `new-pane -d -t <pane> -x W -y H -X X -Y Y` makes a float in that pane's window and keeps the focus on the caller. `-d` is not in the man page, but it works.
- `-x/-y/-X/-Y` describe the outer box, border included. With the default border, `pane_left`/`pane_top` are 1 more than `-X`/`-Y`, and `pane_width`/`pane_height` are 2 less than `-x`/`-y`. With `-B none` the content is the outer box.
- `list-panes` lists floats with `#{pane_floating_flag}` = 1.
- A tiled split does not move or resize a float.
- tmux does not clamp a float to the window. pmux must keep the float in the window itself.

## Goals / Non-Goals

**Goals:**
- One rule for the precedence (call > role > default), used by all four launch sites: spawn, resume, `start`, `resume`.
- The float position comes from the same single `list-panes` call that dwindle already makes. No extra tmux round trip before the create.

**Non-Goals:**
- Role keys for the float size or position.
- Re-layout of floats when one closes or the window resizes.
- Floats on tmux older than 3.8.

## Decisions

### 1. Two parsers: per-call and role values versus defaults

- `SurfacePlacement` becomes `"pane" | "tab" | "float"`.
- A new type `SurfaceDefault = "pane" | "tab"` covers the default.
- `parseSurfacePlacement` (per-call values, the role key, `--surface`, the recorded surface) accepts all three values and the legacy `right` and `down`.
- A new `parseSurfaceDefault` (`config.json`, `/pmux-surface`, `writeSurfaceConfig`) rejects `float`.

This makes "float is never a default" a rule that the type system checks. A single parser with a check at each default site was rejected, because a new default site could forget that check.

### 2. Resolve the placement after the role is loaded

One helper in `placement.ts` does the resolution: `resolvePlacement(call, role, fallback) = call ?? role ?? fallback`.

- **pi parent:** `index.ts` stops resolving the placement. It passes the parsed per-call value (possibly `undefined`) and `getSurfaceDefault()` to the supervisor.
- **Supervisor `spawn`:** it uses `agentDefs?.surface` as the role value.
- **Supervisor `resume`:** it uses the stored record's `surface` as the role value.
- **CLI `start`:** it resolves the placement after `loadAgentDefaults`.
- **CLI `resume`:** it uses `spec.surface` as the role value.

A missing or invalid `--surface` still fails before any pane is created, as today.

The alternative was to load the role in `index.ts` a second time, just for the placement. It was rejected because it reads the role file twice and duplicates the role lookup.

### 3. The role key and the recorded value

`agent-defs.ts` reads `surface:` with `parseSurfacePlacement`. An invalid value gives `undefined`, which follows the `session-mode` pattern.

`LaunchRecord` and `LaunchSpec` each get an optional `surface`. The value written is the role's value only, never the per-call value, so a one-off ad-hoc float does not stick to the child.

The readers parse the stored value with `parseSurfacePlacement`. An unknown value is dropped and does not make the file invalid, which matches how the role key is treated. No version bump is needed:

- an older package drops the new key when it reads a new file;
- a newer package reads an older file as "no role surface".

### 4. Float geometry and cascade in `createSurface`

The dwindle `list-panes` format is extended with: `pane_floating_flag`, `pane_left`, `pane_top`, `window_width`, `window_height`, and the border option `#{pane-border-lines}`.

**Dwindle:** rows with `pane_floating_flag` = 1 are no longer split candidates. The caller's own row stays the fallback target, even when it is floating.

**Float branch:**

1. Compute the outer size: `w = floor(W/2)`, `h = floor(H/2)`.
2. Compute the anchor: `X0 = W - w - 2`, `Y0 = 1`.
3. Choose the **newest pmux float**: the row with the highest numeric pane id where `pane_floating_flag` is 1 and `@pmux_parent` is not empty. The caller is not part of the test, so floats from all callers count.
4. Take the border width `b`: 0 when that row's `pane-border-lines` is `none`, else 1. That float's outer corner is then `(pane_left - b, pane_top - b)`.
5. The next position is `X = corner_x - 2`, `Y = corner_y + 1`. If `X < 0` or `Y + h > H`, use `(X0, Y0)` instead. With no pmux float, use `(X0, Y0)` too.
6. Run `new-pane -d -t <caller> -x w -y h -X X -Y Y -P -F '#{pane_id}'`. Then set `@pmux_parent` and name the pane, as for a tiled pane.

`@pmux_parent` is the tag that makes a float a pmux float. With the floating flag, dwindle ignores it.

**Alternatives considered:**

- Store the requested position in a pane option. Rejected: the spec follows the float's current position after the user moves it.
- Count the floats and offset by the count. Rejected: after a close, the count no longer matches the stack.

### 5. Tool schema and CLI text

- The `surface` union of `pmux_spawn` and `pmux_resume` adds `Type.Literal("float")`. The description says that `float` opens a floating pane at the top right, and that the role's `surface:` applies when the parameter is absent.
- The CLI usage becomes `[--surface pane|tab|float]`, and the error says `(expected pane, tab or float)`.
- `/pmux-surface` text stays `pane, tab`.

## Risks / Trade-offs

- [`new-pane -d` is not in the man page and a later tmux could drop it] -> a unit test checks the argv, and the user's live check confirms that the focus stays on the caller.
- [The user resizes the newest float to a size other than `w x h`] -> the next float keeps the standard size and only uses the old float's corner. If it does not fit, it goes back to the anchor.
- [A pane border style other than `none` with a width other than 1] -> tmux border styles all draw one cell, so `b` is 0 or 1.
- [Small windows: `W/2` or `H/2` is smaller than tmux allows] -> `new-pane` fails, and `createSurface` throws, as a too-small split does today.
- [A float hides the tiled panes below it] -> this is what a float is for. The user can move it, and the default never floats.
- [This change and dwindle modify the same requirements] -> this change's MODIFIED blocks contain the dwindle text plus the float additions. It must be archived after dwindle, or the dwindle text is lost.

## Migration Plan

There is no data migration. Old records and specs have no `surface` and behave as today. A `config.json` with `"surface": "float"` (written by hand) is read as `pane`. To roll back, revert the change. An older package drops the new `surface` key when it reads a record or spec.
