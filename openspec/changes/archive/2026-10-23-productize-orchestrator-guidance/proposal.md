# Proposal

## Why

The orchestrator prompt is now one file (`~/Dev/agents/prompts/orchestrator.md`, linked from pi and Claude Code), and most of its pmux mechanics are gone. One pmux paragraph stays because pmux does not enforce the rule: `pmux_spawn` without an `agent`, or with a misspelled one, quietly launches the default agent. That happened in a real campaign (2026-10-23), and the prompt spends a paragraph to prevent it.

`SKILL.md` has a second paragraph of this type: "LEAVE the sidecar in place". It exists because the skill's own `last`-mode recipe tells the orchestrator to read `<session>.exit` directly after a status wait and to `rm` it. A delete before the run wrapper reads the file stops the pane from closing and loses the ping wake-up. The direct read can also find no file, because the child writes `status: done` before it writes `.exit`.

## What Changes

- **BREAKING: `pmux_spawn` requires `agent`.** A call without `agent` fails schema validation. A call whose `agent` resolves to no role definition returns an error result that names the role and the searched paths, and creates no pane, no launch record and no child. pmux checks only that the role exists: a role with no `model:` still launches with pi's default model, as it does today.
- **The skill reads a child's exit only through `wait --signal sidecar`, in both modes.** The `last`-mode recipe runs the sidecar wait after the status wait, and no recipe reads `<session>.exit` directly or deletes it. The long "LEAVE the sidecar" paragraph becomes one sentence.
- Removed from the earlier draft of this change: the `hint` field, the `nudge` and `close` commands, automatic orchestrator pane titles, and the effective role in the spawn acknowledgement.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `subagent-supervision`: `pmux_spawn` requires a role that resolves.
- `external-orchestration`: the skill's wait recipe reads the exit through `wait --signal sidecar` in both modes, and the handoff recipe follows it.

## Impact

- `pi-extension/pmux/supervisor.ts`: the `agent` parameter becomes required; the spawn rejects a role that does not resolve.
- `pi-extension/pmux/launch-build.ts`: `resolveLaunchRecord` gets a check for role existence only, separate from `strict`.
- `pi-extension/pmux/index.ts`: `pmux_spawn` returns the rejection as an error result.
- `skills/pmux/SKILL.md`: the `last`-mode wait and exit recipe, and the send-mode sidecar paragraph.
- Tests beside each touched module.
- Not in scope: the orchestrator prompt lives outside this repo. After release, the user deletes its role-omission paragraph.
