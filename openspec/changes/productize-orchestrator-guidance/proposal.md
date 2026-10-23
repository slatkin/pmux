# Proposal

## Why

The two orchestrator prompts that drive pmux campaigns (`~/.pi/agent/prompts/orchestrator.md` and `~/.claude/commands/pi-orchestrator.md`) carry long passages that document or work around pmux mechanics. Those passages drift: both prompts still tell the orchestrator to end every brief with "call the `luvus_done` tool" (the tool is `pmux_done`), and the Claude prompt warns about an omitted `--role` even though `cli.ts start` already requires it. One passage exists only because pmux is silent: `pmux_spawn` without an `agent`, or with a misspelled one, quietly launches the default agent — a real campaign incident (2026-10-23) that the prompt now spends a paragraph policing. Guidance that pmux can enforce or surface in code should live in code, so the prompts can shrink to campaign doctrine.

## What Changes

- **Strict role resolution on the pi path.** `pmux_spawn` with an `agent` value that resolves to no role definition returns an error result and splits no pane — the same strictness `cli.ts start` already applies. **BREAKING**: a previously accepted (silently misrouted) input is now rejected.
- **Surface the effective role.** A `pmux_spawn` acknowledgement names the role the child actually runs with; when `agent` was omitted, the acknowledgement says the child runs as the default agent, so a routing defect is visible in the launch result instead of in a user correction. Omitting `agent` stays allowed.
- **Self-describing sidecar wait.** The `wait --signal sidecar` JSON gains a `hint` field that names the next action for the reported reason (answer a ping with `resume`, start a new child on a `handoff`, read the report on `done`), so the orchestrator follows the output instead of memorized prose.
- **`nudge` and `close` CLI commands.** `nudge --pane <id> --text <text>` types a line into a child's pane; `close --pane <id>` kills a pane the orchestrator is done with. These replace the raw `tmux send-keys` / `tmux kill-pane` recipes in `SKILL.md`, removing the last documented reasons for an orchestrator to drive tmux itself.
- **Automatic orchestrator pane title.** When a launch creates a child pane, pmux titles the orchestrator's own pane once (`<window-name>-orchestrator`, marked with a pane option so it is never clobbered or reapplied), on both the pi-parent and the external path. The manual `tmux select-pane -T` step leaves the prompts.
- `SKILL.md` is updated for the new commands and the `hint` field.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `subagent-supervision`: strict role resolution for `pmux_spawn`, the effective role in the spawn acknowledgement, and the once-only orchestrator pane title on the pi-parent path.
- `external-orchestration`: the `hint` field in the sidecar-wait JSON, the `nudge` and `close` commands, the once-only orchestrator pane title on `start`, and the `SKILL.md` recipe updates.

## Impact

- `pi-extension/pmux/supervisor.ts`, `launch-build.ts`: strict resolution on the pi path (`strict` on an `agent` that was given), effective-role plumbing into the spawn result.
- `pi-extension/pmux/index.ts`: spawn acknowledgement text and details name the effective role.
- `pi-extension/pmux/cli.ts`: `wait` hint field; new `nudge` and `close` commands; orchestrator pane titling on `start`.
- `pi-extension/pmux/tmux.ts` (or placement/surface helpers): read the caller's window name, set the caller pane's title once, mark it with a pane option.
- `skills/pmux/SKILL.md`: nudge/close/wait-hint recipes replace the tmux recipes.
- Tests beside each touched module.
- Out of scope (recorded assumptions, open to revisit): the two orchestrator prompt files live outside this repo — slimming them is a follow-up the user performs after this lands; generating host-specific prompts from a pmux-owned template is deferred to its own change; extracting the shared campaign doctrine into one document lives outside pmux.
