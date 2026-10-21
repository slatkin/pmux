# Tasks

## 1. Placement values

- [x] 1.1 In `pi-extension/pmux/placement.ts`, change `SurfacePlacement` to `"pane" | "tab"`, set `DEFAULT_SURFACE_PLACEMENT` to `"pane"`, and make `parseSurfacePlacement` map `pane`, `right` and `down` to `pane` (design decision 3). Update the doc comments. Verify with `pnpm run typecheck`, which lists every call site that still uses `"right"` or `"down"`.
- [x] 1.2 Update the surface-config tests in `test/test.ts` (the "resolves the surface placement default" and "loads the surface placement" cases): `right`, `down` and `pane` give `pane`, `tab` gives `tab`, and junk or absent gives `pane`. Add a case where `writeSurfaceConfig` persists `"pane"`. Verify with `node --test test/test.ts`.

## 2. Dwindle split in the tmux backend

- [x] 2.1 In `pi-extension/pmux/tmux.ts` `createSurface`, for `pane`: list the caller's window panes with id, width, height and `@pmux_parent`, choose the target (the highest numeric pane id among rows whose `@pmux_parent` is the caller, else the caller), choose the axis (`width >= 2 * height` -> `-h`, else `-v`), split the target with `-d`, then set `@pmux_parent` on the new pane and catch a failure the same way as the naming failure (design decisions 1 and 2). Keep `tab` unchanged and keep `splitPane` unchanged.
- [x] 2.2 Update `test/tmux-fakes.ts` so that `useTmuxPaneFake` answers the placement `list-panes` format separately from the orchestrator listing, and returns a caller row by default. Verify that `node --test test/cli.test.ts test/supervisor.test.ts` still passes with no other test changes.
- [x] 2.3 Replace the split tests in `test/tmux.test.ts` ("splits the caller's own pane", "stacks the split when the placement is down") with tests for each tmux-backend scenario: the first child splits the caller; a later child splits the newest child; ordering is numeric (`%10` is newer than `%9`); a closed or moved child is absent from the listing, so the next newest is used; a grandchild row (other `@pmux_parent`) is ignored; wide 200x50 -> `-h`, tall 49x50 -> `-v`, exact 100x50 -> `-h`; `@pmux_parent` is set on the new pane; a failed `set-option` still returns the pane; no `select-layout`, `swap-pane` or `resize-pane` call is made. Verify with `node --test test/tmux.test.ts`.

## 3. pi parent surface (tools and slash command)

- [x] 3.1 In `pi-extension/pmux/index.ts`, change the `surface` schema of `pmux_spawn` and `pmux_resume` to `pane | tab` with the new description, remove "Set placement with the surface parameter." from both tool descriptions and the placement wording from both promptSnippets, update the `surfaceDefault` comment, and change `/pmux-surface` to show `[pane|tab]` and `accepted: pane, tab` (design decision 4). Verify with `pnpm run typecheck`.
- [x] 3.2 Add or update tests for the luvus-surface scenarios: `resolveSurfacePlacement` gives `pane` for `right`, `down` and junk; `/pmux-surface down` sets and persists `pane` and the confirmation names `pane`; `/pmux-surface window` reports the accepted values `pane` and `tab`; the `pmux_spawn` and `pmux_resume` schemas offer only `pane` and `tab`, and their descriptions contain no `right` or `down` choice. Verify with `node --test test/test.ts test/supervisor.test.ts`.

## 4. External orchestrator CLI

- [x] 4.1 In `pi-extension/pmux/cli.ts`, change the usage lines to `[--surface pane|tab]` and the invalid-value error to `(expected pane or tab)`. Verify with `pnpm run typecheck`.
- [x] 4.2 Update `test/cli.test.ts`: the sandbox config and the "defaults --surface to the config.json value" test use the new values, `--surface down` is accepted and splits by the rule, the invalid-value test expects the message to name `pane` and `tab`, and a new test runs `start` twice from the same caller pane and checks that the second split targets the first child's pane. Verify with `node --test test/cli.test.ts`.
- [x] 4.3 Update `skills/pmux/SKILL.md`: the `--surface` text for `start` and `resume` describes `pane` (the default, automatic dwindle placement) and `tab`. Check by hand that no `right` or `down` choice is left in the file (`grep -n "right\|down" skills/pmux/SKILL.md`).

## 5. Docs and integration

- [x] 5.1 Update `README.md`: the placement mention becomes automatic dwindle placement in the caller's window, or a tab. Check by hand that the text matches the specs.
- [x] 5.2 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`, in that order. All four must pass (`no-explicit-any` warnings are expected).
- [x] 5.3 Run `openspec validate 2026-10-20-dwindle-pane-placement --strict` and verify that it passes.

## Workflow follow-up

- The user runs the live tmux check: spawn four children from one pi parent on a wide window and confirm the spiral, close one child pane and spawn again, and spawn from a child to confirm the grandchild stays in the child's region.
- Archive the change after review, so the deltas merge into `tmux-backend`, `luvus-surface` and `external-orchestration`.
