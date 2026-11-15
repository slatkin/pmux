---
name: pmux-roles
description: "Open the pmux role editor in a tmux popup over the user's pane and change subagent roles' model, model-fallback and thinking. Only runs when the user types /pmux-roles; never invoke it yourself."
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" roles)'
---

# pmux role editor

!`node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" roles`

The command opens the role editor in a tmux popup over your pane. The user
picks a role and gets a panel with its `model`, `model-fallback` and
`thinking` rows: edits stay staged until `s` saves them in one write, Escape
discards them, Left and Right cycle `thinking`, `d` stages a removal, and
Enter on a model row opens a picker that shows pi's `enabledModels` first and
every model on Tab. The editor stays open after a save, so one open can edit
several roles; Escape in the role list closes it. A built-in role's first
save writes a user copy under `~/.pi/agent/agents/` with the edits already in
it.

The printed result line names every save of the open — each role, its changed
keys and the file — or says that no role file changed. It can name more than
one save, because the editor stays open. The command can also report
`dialog still open; it finishes in the popup` when the user is still
choosing — the save still lands when the user finishes, so nothing is lost.

Requires the `pmux` skill installed beside this one: the command runs
`../pmux/launch.ts`. It also requires tmux; outside tmux it exits non-zero
and its refusal reaches you as the command output.

Answer with the command's printed result line and do nothing else.
