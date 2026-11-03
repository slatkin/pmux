# Proposal

## Why

The user changes subagent models often, to follow subscription usage windows, and today that means editing role files by hand. The user also has no quick way to start a subagent or to read a child's report without typing to the agent or opening files. tmux `display-popup` draws over the pane, uses no window space and works the same under pi and Claude Code (GitHub issue #22).

## What Changes

- Add a tmux popup dialog, run as `node cli.ts <dialog>` inside `tmux display-popup -E`. pmux does not use `display-popup` today. One implementation serves both hosts, and the slash commands of each host only open it.
- Add a **role editor** (`/pmux-roles` in pi, the `pmux-roles` skill in Claude Code):
  - It lists the roles that resolve for the caller's cwd. A built-in role (the package's `agents/`) shows virtually, and the listing writes nothing.
  - It edits only the frontmatter keys `model`, `model-fallback` and `thinking`. Other lines, their order, the line endings and the body stay byte for byte.
  - A role with a physical file (`<cwd>/.pi/agents/` or `~/.pi/agent/agents/`) is edited in place. The first edit of a built-in role writes a full physical copy to `~/.pi/agent/agents/<role>.md`, then edits the copy.
  - The model choices come from `pi --list-models`.
  - There is no overrides file. Model precedence does not change. A resumed child keeps the model in its launch record.
- Add a **spawn dialog** (`/pmux-spawn` in pi, the `pmux-spawn` skill in Claude Code). It collects a role and a brief, and the command starts the child itself, with the report going to the orchestrator pane through the existing delivery path. The agent is not asked first and gets no note at launch. In Claude Code the skill takes only a role; the task goes in the brief step.
  - **BREAKING**: pi's `/pmux-spawn <agent> [task]` now starts the child directly. Before, it sent a user message that asked the agent to call `pmux_spawn`.
- Add a **report viewer** (`/pmux-reports` in pi, the `pmux-reports` skill in Claude Code). It lists the `file-ack-v1` reports addressed to the caller's pane, newest first, and shows the chosen one in a pager. It reads a new per-pane report history, which `ack` does not remove, so a report stays readable after the agent acknowledged it.
- Out of scope: running a child inside a popup (issue use 4). A popup is not a pane; the existing `float` surface already gives a transient overlay that keeps the pane id, `send-keys`, `@pmux_parent` and death detection. Also out of scope: one-key model swaps, bulk model moves across roles, warnings for unknown frontmatter keys, and showing `last`-mode results in the viewer.

## Capabilities

### New Capabilities

- `role-editor`: listing resolved roles with built-in roles shown virtually, frontmatter-only edits of the model keys, and copy-on-first-edit of built-in roles to `~/.pi/agent/agents/`.
- `spawn-dialog`: the dialog that collects a role and a brief and starts a child that reports to the orchestrator pane, from pi and from Claude Code.
- `report-viewer`: the per-pane report history and the dialog that lists and shows its reports.
- `popup-dialogs`: how a host command opens a dialog in a tmux popup, receives its result, and fails when no popup can open.

### Modified Capabilities

None. The history record is written beside the existing `report` registration and does not change it, the inbox, or `ack`.

## Impact

- `pi-extension/pmux/cli.ts`: the `roles`, `spawn-dialog` and `reports` subcommands, each with an outer (host) side and an inner (popup) side.
- `pi-extension/pmux/tmux.ts`: a `display-popup` call that does not use the 5-second tmux call timeout.
- `pi-extension/pmux/agent-defs.ts`: role listing across the three sources, and a frontmatter writer.
- `pi-extension/pmux/report-delivery.ts`, `run.ts`, `prune.ts`: write and prune history records.
- `pi-extension/pmux/index.ts`: `/pmux-roles`, `/pmux-reports`, and the changed `/pmux-spawn`.
- `skills/`: three new skill directories for Claude Code.
- Writes to `~/.pi/agent/agents/` and to project `.pi/agents/` role files.
- `package.json`: exclude the three new skills from `pi.skills`, so pi does not register them.
- Needs tmux 3.3 or later for the dialogs (`display-popup -T` and `-e`).
