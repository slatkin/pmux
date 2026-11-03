---
name: pmux-reports
description: "Open the pmux report viewer in a tmux popup over the user's pane and read the reports subagents sent to it. Only runs when the user types /pmux-reports; never invoke it yourself."
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" reports)'
---

# pmux report viewer

!`node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" reports`

The command opens the report viewer in a tmux popup over your pane. It
lists the reports children sent to your pane, newest first, each with its
sender, time and state (`pending`, `acknowledged` or `missing`). Enter
opens the report in the user's pager and Escape closes the viewer; reading
a report never acknowledges it. The command can report `dialog still open;
it finishes in the popup` when the user is still reading — nothing is
lost, since viewing changes no state.

Requires the `pmux` skill installed beside this one: the command runs
`../pmux/launch.ts`. It also requires tmux; outside tmux it exits non-zero
and its refusal reaches you as the command output.

Answer with the command's printed result line and do nothing else.
