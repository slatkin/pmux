# Proposal

## Why

Today every subagent pane is a split of the caller's own pane, and the launching agent picks `right` or `down` with the `surface` parameter. Repeated splits of the same pane give uneven slivers in reverse spawn order, and the agent has to think about a layout choice it cannot see. The user wants a mechanical layout like the dwindle mode of tiling window managers: panes open in spawn order along a spiral, and pmux, not the agent, chooses where each one goes.

## What Changes

- New placement rule for a split (`pane`): the split target is the caller's newest living child pane in the caller's window, or the caller's own pane when it has none. The split axis comes from the target's shape: side by side when `pane_width >= 2 * pane_height`, else stacked. The 2 is the height-to-width ratio of a terminal cell.
- Each agent applies the rule to its own children only, so a grandchild lands inside its parent's region. Nested agents need no extra env keys.
- The rule reads the live pane state each time, so it stays correct after the user closes a pane.
- No re-tiling: pmux never runs `select-layout` or `swap-pane`, and never moves the user's own panes.
- **BREAKING**: the placement values become `pane` (the dwindle split, default) and `tab` (own window). `right` and `down` are no longer choices. In `config.json`, in the tool `surface` parameter and in `--surface`, the old values `right` and `down` are read as `pane`.
- The `pmux_spawn` and `pmux_resume` tool descriptions stop telling the agent to choose a placement. `/pmux-surface` accepts `pane` and `tab`.
- The `start` and `resume` commands of the external orchestrator follow the same rule.
- Out of scope: a `floating` placement (a later change).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `tmux-backend`: the requirement "Subagent panes are split from the caller's own pane" changes to the dwindle target and axis rule. It stays anchored on `TMUX_PANE`.
- `luvus-surface`: the values are `pane | tab`. Old `right` and `down` are read as `pane`. `/pmux-surface` and the per-call override use the new values.
- `external-orchestration`: the launch contract and resume requirements place the new pane by the tmux-backend placement rule, and do not always split next to the caller's pane.

## Impact

- Code: `pi-extension/pmux/placement.ts`, `pi-extension/pmux/tmux.ts` (`createSurface`), `pi-extension/pmux/index.ts` (tool schemas and descriptions, `/pmux-surface`), `pi-extension/pmux/status.ts` (surface config parse), `pi-extension/pmux/cli.ts` (`--surface` parse and usage text), `pi-extension/pmux/supervisor.ts` (types only, if any).
- Docs: `skills/pmux/SKILL.md` (`--surface` text), `README.md` (placement mention).
- Tests: `test/tmux.test.ts`, `test/tmux-fakes.ts`, `test/test.ts` (placement resolution), `test/cli.test.ts`, `test/supervisor.test.ts`.
- tmux: the backend uses pane user options (`set-option -p`). tmux 3.8 supports them.
- No change to `pmux-done.ts`, the `PI_PMUX_*` env keys or the `.exit` format.
