---
name: pmux-roles
description: "Open the pmux role editor in a tmux popup over the user's pane and change a subagent role's model, model-fallback or thinking. Only runs when the user types /pmux-roles; never invoke it yourself."
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" roles)'
---

# pmux role editor

!`node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" roles`

The command opens the role editor in a tmux popup over your pane. The user
picks a role, a key (`model`, `model-fallback` or `thinking`) and a value; a
built-in role's first edit writes a user copy under
`~/.pi/agent/agents/`. The command can report `dialog still open; it finishes
in the popup` when the user is still choosing — the edit still lands when the
user finishes, so nothing is lost.

Requires the `pmux` skill installed beside this one: the command runs
`../pmux/launch.ts`. It also requires tmux; outside tmux it exits non-zero
and its refusal reaches you as the command output.

Answer with the command's printed result line and do nothing else.
