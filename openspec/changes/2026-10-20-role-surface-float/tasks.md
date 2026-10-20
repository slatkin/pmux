# Tasks

Precondition: `2026-10-20-dwindle-pane-placement` is applied. Start each group from a tree where `SurfacePlacement` is `"pane" | "tab"`, and where `createSurface` has the dwindle `list-panes` target search.

## 1. Placement values and resolution helper

- [ ] 1.1 In `pi-extension/pmux/placement.ts`, add `"float"` to `SurfacePlacement`. Make `parseSurfacePlacement` accept `float`. Add `SurfaceDefault = "pane" | "tab"`, `parseSurfaceDefault` (which rejects `float`), and `resolvePlacement(call, role, fallback)` (design decisions 1 and 2). Switch `parseSurfaceConfig`, `loadSurfaceConfig` and `writeSurfaceConfig` in `status.ts` to `SurfaceDefault`. Verify with `pnpm run typecheck`.
- [ ] 1.2 In `test/test.ts`, add surface-config cases:
  - `"float"` in `config.json` loads as `pane`;
  - `parseSurfacePlacement("float")` gives `float`;
  - `parseSurfaceDefault("float")` gives `undefined`;
  - `resolvePlacement` gives call > role > fallback, with each value absent in turn.

  Verify with `node --test test/test.ts`.

## 2. Role frontmatter key

- [ ] 2.1 In `pi-extension/pmux/agent-defs.ts`, add `surface?: SurfacePlacement` to `AgentDefaults`, and read `surface:` with `parseSurfacePlacement` (an invalid value gives `undefined`). Verify with `pnpm run typecheck`.
- [ ] 2.2 Add `parseAgentDefinition` tests: `surface: float`, `surface: tab`, `surface: window` (undefined), no key (undefined), and a CRLF file with `surface: float`. Verify with `node --test test/test.ts`.
- [ ] 2.3 In `docs/guide.md`, add `surface` to the frontmatter table and a short `### surface` section. The section says: `pane`, `tab` or `float`; it is used when the call gives no `surface`; it is kept on resume; `float` is never a default. Check by hand that the text matches the `luvus-surface` delta.

## 3. Float placement and cascade in the tmux backend

- [ ] 3.1 In `pi-extension/pmux/tmux.ts` `createSurface`, do these four things (design decision 4):
  - extend the dwindle `list-panes` format with `pane_floating_flag`, `pane_left`, `pane_top`, `window_width`, `window_height` and `pane-border-lines`;
  - skip floating rows as dwindle candidates;
  - add the `float` branch: anchor, newest pmux float, border width, cascade step, wrap to the anchor, then `new-pane -d -t <caller> -x -y -X -Y -P -F '#{pane_id}'`;
  - set `@pmux_parent` and the pane name, as for a tiled pane.

  Update the doc comment. Verify with `pnpm run typecheck`.
- [ ] 3.2 Update `test/tmux-fakes.ts` so that the placement `list-panes` fake can return rows with the new fields. The default is one tiled caller row in a 200x50 window. Verify that `node --test test/cli.test.ts test/supervisor.test.ts` still passes.
- [ ] 3.3 In `test/tmux.test.ts`, add one test for each tmux-backend delta scenario:
  - a floating child is not a split target;
  - the first float on 200x50 gives `-x 100 -y 25 -X 98 -Y 1` and `-d`;
  - the second float gives `-X 96 -Y 2`;
  - the newest float is closed (absent from the listing), so the next float uses the remaining newest float;
  - a moved float at `pane_left 41`, `pane_top 11` (bordered) gives `-X 38 -Y 11`;
  - a borderless newest float (`pane-border-lines none`) uses `pane_left`/`pane_top` directly;
  - no room (a bottom past the last row, or `X < 0`) wraps to the anchor;
  - a user float (no `@pmux_parent`) is ignored;
  - a float of another caller counts;
  - `@pmux_parent` is set on the float;
  - a floating caller with the `pane` placement runs `split-window` on the caller;
  - no `select-layout`, `swap-pane` or `resize-pane` call is made.

  Verify with `node --test test/tmux.test.ts`.

## 4. pi parent: precedence, record and resume

- [ ] 4.1 In `pi-extension/pmux/index.ts`, stop resolving the placement:
  - pass the parsed per-call `surface` (possibly `undefined`) and `getSurfaceDefault()` to `spawn` and `resume`;
  - add `float` to the `surface` union of both tools, with the new description;
  - make `/pmux-surface` parse with `parseSurfaceDefault`, so that `float` is reported as invalid with the accepted values `pane, tab`.

  Update the `surfaceDefault` comment. Verify with `pnpm run typecheck`.
- [ ] 4.2 In `pi-extension/pmux/supervisor.ts`:
  - `spawn` resolves with `resolvePlacement(call, agentDefs?.surface, default)`, and writes `agentDefs?.surface` (never the per-call value) into the launch record;
  - `resume` resolves with `resolvePlacement(call, storedRecord?.surface, default)`.

  In `launch-record.ts`, add the optional `surface`. It is parsed with `parseSurfacePlacement`, and an unknown value is dropped. Verify with `pnpm run typecheck`.
- [ ] 4.3 Add tests for the `luvus-surface` and `subagent-supervision` delta scenarios:
  - a floating role spawns a float;
  - the per-call `pane` beats the role's float;
  - the role's `pane` beats a `tab` default;
  - an invalid role value uses the default;
  - an ad-hoc `surface: "float"` with no role surface gives a float, and the record holds no surface;
  - the record holds the role's `float`;
  - a resume with a record surface `float` gives a float;
  - a resume with a record without a surface uses the default;
  - `/pmux-surface float` leaves the default and `config.json` unchanged;
  - the tool schemas offer exactly `pane`, `tab` and `float`.

  Verify with `node --test test/test.ts test/supervisor.test.ts`.

## 5. External orchestrator CLI

- [ ] 5.1 In `pi-extension/pmux/cli.ts`, make these changes:
  - parse `--surface` with `parseSurfacePlacement`, and keep it as `undefined` when the flag is absent;
  - in `start`, resolve with `resolvePlacement(flag, definition.surface, loadSurfaceConfig())` after `loadAgentDefaults`, and write `definition.surface` into the launch spec;
  - in `resume`, resolve with `resolvePlacement(flag, spec.surface, loadSurfaceConfig())`;
  - change the usage to `[--surface pane|tab|float]` and the error text to `(expected pane, tab or float)`.

  In `launch.ts`, add the optional `surface`. It is parsed with `parseSurfacePlacement`, and an unknown value is dropped. Verify with `pnpm run typecheck`. Also verify that an invalid `--surface` still fails before any tmux call.
- [ ] 5.2 In `test/cli.test.ts`, add tests for the `external-orchestration` delta scenarios:
  - a floating role with no flag gives `new-pane`;
  - `--surface pane` beats the role;
  - `--surface float` with no role surface gives a float, and the spec holds no surface;
  - the role's `tab` is recorded in the spec;
  - `resume` of a spec with the surface `float` gives a float;
  - `resume` of a spec without a surface uses `config.json`;
  - `--surface window` names `pane`, `tab` and `float`, and makes no tmux call;
  - a CRLF role with `surface: float` behaves like the LF role.

  Verify with `node --test test/cli.test.ts`.
- [ ] 5.3 In `skills/pmux/SKILL.md`, describe `--surface pane|tab|float` for `start` and `resume`. The text must say that the role's `surface:` applies when the flag is absent, and that a resume keeps the role's surface. Check by hand with `grep -n "surface" skills/pmux/SKILL.md`.

## 6. Integration

- [ ] 6.1 In `README.md`, mention the float surface and the role `surface:` key next to the placement text. Check by hand that it matches the specs.
- [ ] 6.2 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`, in that order. All four must pass. The `no-explicit-any` warnings are expected.
- [ ] 6.3 Run `openspec validate 2026-10-20-role-surface-float --strict` and verify that it passes.

## Workflow follow-up

- The user runs the live tmux 3.8 check:
  - spawn a role with `surface: float`, and confirm that it opens at the top right and that the caller keeps the focus;
  - spawn two more floats, and confirm the cascade;
  - close the newest float and spawn again;
  - move a float and spawn again;
  - spawn a `pane` child from a float;
  - resume a floating child.
- Archive `2026-10-20-dwindle-pane-placement` first, and then this change, so that these MODIFIED blocks replace the dwindle text.
