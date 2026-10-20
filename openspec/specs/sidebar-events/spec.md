# sidebar-events Specification

## Purpose
Lets a pi session describe itself to the tmux sidebar, so that a pi pane is
listed with its status, its prompt, its last response, its tool activity and
the fact that it waits for a human.

## Requirements

### Requirement: the extension publishes the session's activity

The extension SHALL publish the activity of the pi session it runs in to the
tmux sidebar, by calling `tmux-agent-sidebar hook pi <event>` with the
payload on stdin, for every event of the protocol that pi can answer.

#### Scenario: A user prompt
- **WHEN** pi receives a user prompt
- **THEN** the extension publishes `user-prompt-submit` with that prompt text

#### Scenario: A tool starts
- **WHEN** pi starts a tool
- **THEN** the extension publishes `activity-log` with the tool name and its arguments

#### Scenario: A tool ends
- **WHEN** a tool ends
- **THEN** the extension publishes `activity-log` with the tool name, its arguments and its result

#### Scenario: The turn ends
- **WHEN** a run settles with the outcome `completed` or `aborted`
- **THEN** the extension publishes `stop` with the text of the run's last assistant message

#### Scenario: The turn fails
- **WHEN** a run settles with the outcome `error`
- **THEN** the extension publishes `stop-failure` with the error text

#### Scenario: The session waits for a human
- **WHEN** pi starts waiting on a blocking user-facing extension prompt
- **THEN** the extension publishes `notification` with a wait reason

#### Scenario: The wait is over
- **WHEN** pi stops waiting on that prompt
- **THEN** the extension publishes `user-prompt-submit` with an empty prompt, and no prompt text of its own

#### Scenario: The session starts
- **WHEN** the pi session starts
- **THEN** the extension publishes `session-start` with the working directory, the session id and the source

#### Scenario: The session ends
- **WHEN** the pi session shuts down
- **THEN** the extension publishes `session-end`

### Requirement: publishing never disturbs the session

The extension SHALL NOT await the sidebar call, SHALL ignore the child's
output, and SHALL swallow any failure to start it. A missing, broken or slow
sidebar SHALL NOT delay a turn, SHALL NOT raise an extension error, and SHALL
NOT write to the session's output.

#### Scenario: The binary is missing
- **WHEN** no sidebar binary can be found
- **THEN** the extension publishes nothing and the session runs as before

#### Scenario: The binary cannot be started
- **WHEN** the spawn of the sidebar binary fails
- **THEN** the extension ignores the failure and the session runs as before

#### Scenario: The binary is slow
- **WHEN** the sidebar binary takes a long time to answer
- **THEN** the pi turn continues without waiting for it

### Requirement: only a session in tmux publishes

The extension SHALL publish only when the session runs in a tmux pane, and
SHALL address that pane by the id in `$TMUX_PANE`.

#### Scenario: A session in a pane
- **WHEN** `$TMUX_PANE` is set
- **THEN** the extension publishes with that pane as the target

#### Scenario: A session outside tmux
- **WHEN** `$TMUX_PANE` is unset
- **THEN** the extension publishes nothing

### Requirement: the worktree is published when the pane has one

The extension SHALL read the sidebar's worktree markers from its own pane's
window and SHALL send them with the session-start payload, so that a pi pane
that works in a worktree shows the worktree and its branch.

#### Scenario: The pane is in a worktree
- **WHEN** the pane's window carries the sidebar's worktree and branch options
- **THEN** the session-start payload carries that worktree and that branch

#### Scenario: The pane is not in a worktree
- **WHEN** the pane's window carries no worktree option
- **THEN** the session-start payload carries no worktree

### Requirement: publishing can be turned off

The extension SHALL publish nothing when the environment asks it not to,
even when the sidebar binary is present.

#### Scenario: Publishing is off
- **WHEN** the environment sets the sidebar switch to `0`
- **THEN** the extension publishes nothing
