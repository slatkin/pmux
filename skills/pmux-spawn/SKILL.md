---
name: pmux-spawn
description: "Open the pmux spawn dialog in a tmux popup over the user's pane and start a subagent with a role and a brief. Only runs when the user types /pmux-spawn; never invoke it yourself."
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" spawn-dialog --args ''$ARGUMENTS'')'
---

# pmux spawn dialog

!`node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" spawn-dialog --args '$ARGUMENTS'`

The command opens the spawn dialog in a tmux popup over your pane. With no
argument the user picks a role from the list; with one argument — a role
name — the dialog opens at the brief step for that role. The user writes
the brief in their editor; the child then starts in your cwd with the role,
in send mode, and reports to your pane. The command refuses any text after
the role — the task goes in the brief step. It can report `dialog still
open; it finishes in the popup` when the user is still working — the child
still starts when the user finishes, so nothing is lost.

Requires the `pmux` skill installed beside this one: the command runs
`../pmux/launch.ts`. It also requires tmux; outside tmux it exits non-zero
and its refusal reaches you as the command output.

Answer with the command's printed result line and do nothing else.
