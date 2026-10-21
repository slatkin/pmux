# Proposal

## Why

Two packages run the same engine. pmux runs pi children in tmux panes for two kinds of parent: a pi parent that uses the extension's tools, and an external orchestrator (Claude Code) that uses the packaged `pmux` skill. foreman is a separate Claude skill package that forked pmux's launch machinery (`cli.ts`, `run.ts`, `exit-sidecar.ts`, `prune.ts`, the launch spec, the role lookup) to add one thing: a report channel that wakes the orchestrator.

pmux's skill path has no such channel. The child's report is its last assistant message, and the orchestrator must block in `wait` to learn that the child finished. A Claude Code orchestrator that ends its turn cannot poll, so it never wakes. foreman solved this: the child runs `node <cli> send --to <parent pane> --text '<report>'`, which types the report into the orchestrator's pane as a new turn. When the child exits without that report, the pane-side wrapper wakes the parent itself.

Two copies of the engine drift. Every pmux fix (placement, close-on-done, crash sidecars, prune) must be ported by hand to foreman, and foreman's fixes back. One engine with two report modes removes the fork: pmux gains the `send` channel, and foreman retires.

## What Changes

- `start` gains `--report last|send`. `last` (the default) is today's behavior, unchanged byte for byte. An invalid value exits 2 with a message on stderr and creates nothing. In `send` mode the `--parent` value is the orchestrator's tmux pane id, and the child's tools gain `bash` and lose any denial of it, because the report is a bash command. The launch spec stores the mode, so `resume` and the pane-side wrapper use it; `resume` rejects a `--report` flag rather than silently ignoring it.
- In `send` mode the parent-contact footer is foreman's footer, adapted to `pmux_done` and pmux's CLI path. It teaches the `send` command as the report step, then `pmux_done`. A blocked child sends its question with the same command and stops. It never says that the last message was already delivered.
- A new `send` subcommand: `node cli.ts send --to <pane> --text <text>` types the text literally into the pane and presses Enter. Inside a child (`PI_PMUX_SESSION` set) it appends one best-effort JSON receipt line to `<session>.sent`.
- The pane-side wrapper, in `send` mode only, counts receipts addressed to the parent. A child that exits with no new parent-addressed receipt wakes the parent with one message: the ping question for a ping sidecar, else the exit state and the `last-message` command. In `last` mode the wrapper still contacts nobody.
- `wait` gains `--signal status|sidecar`. `status` (the default) is unchanged. `sidecar` polls `<session>.exit` read-only and prints the interpreted sidecar plus its absolute path.
- `prune` reclaims `.sent` receipts.
- `pmux_message` to `parent` from an externally launched child no longer claims that the report is the last assistant message. It tells the child to report the way its brief's footer says, so the error is true in both modes.
- `skills/pmux/SKILL.md` gains an "External orchestrators (Claude Code)" section for the `send` protocol, and its description covers external orchestrators. The existing text describes `last` mode, so the two claims that would be false in `send` mode (the intro's "no channel from the child back to you" and the "report = last assistant message" bullet) and the shared last-mode recipes (the idle-child nudge, the guide's `wait` paragraph, the README paragraph) are scoped to the default mode; the rest stays unchanged.
- The test suite gains ports of foreman's coverage for every new behavior.

## Non-goals

- No `pmux_send` (or `foreman_send`) tool in v1. The bash `send` command is the channel.
- No `foreman_` names anywhere. pmux keeps `pmux_done`, `caller_ping` and `PI_PMUX_*`.
- No change to the pi-parent path, the `.exit` format, `pmux-done.ts` or the `PI_PMUX_*` env contract.
- Retiring the foreman repository itself is outside this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: report mode selection, the `send` command and its receipts, the send-mode wake-up, `wait --signal sidecar`, the footer variants, the close-on-done "contacts nobody" rule scoped to `last` mode, resume re-appending the mode's footer, and the skill documentation.
- `luvus-messaging`: the external-parent error of `pmux_message` names the brief's footer, not the last assistant message.

## Impact

- `pi-extension/pmux/cli.ts`: `--report`, `--signal`, `send`, the second footer, the usage text.
- `pi-extension/pmux/launch.ts`: the optional `report` field of `LaunchSpec`, read and validated.
- `pi-extension/pmux/run.ts`: `countReports` and the send-mode wake-up.
- `pi-extension/pmux/prune.ts`: `.sent` in `isManagedScratchFile`.
- `pi-extension/pmux/index.ts`: the external-parent error text of `pmux_message`.
- `pi-extension/pmux/agent-defs.ts`: the tool allowlist gains an optional extra list, so `start` can keep `bash` in `send` mode.
- `skills/pmux/SKILL.md`: the new section and the description.
- `docs/guide.md`: the skill usage lines (`--report`, `send`, `--signal`) and the external-parent paragraph of `pmux_message`.
- Tests: `test/cli.test.ts`, `test/cli-wait.test.ts`, `test/prune.test.ts`, and the `pmux_message` target test in `test/test.ts`.
