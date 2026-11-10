# Spec Delta

## MODIFIED Requirements

### Requirement: publishing never disturbs the session

The extension SHALL NOT await the sidebar call, SHALL NOT run a synchronous
tmux call on the session's own thread, SHALL ignore the child's output, and
SHALL swallow any failure to start it. A missing, broken or slow sidebar
SHALL NOT delay a turn, SHALL NOT raise an extension error, and SHALL NOT
write to the session's output. A busy or wedged tmux server SHALL NOT delay
the session's startup or its input.

#### Scenario: The binary is missing
- **WHEN** no sidebar binary can be found
- **THEN** the extension publishes nothing and the session runs as before

#### Scenario: The binary cannot be started
- **WHEN** the spawn of the sidebar binary fails
- **THEN** the extension ignores the failure and the session runs as before

#### Scenario: The binary is slow
- **WHEN** the sidebar binary takes a long time to answer
- **THEN** the pi turn continues without waiting for it

#### Scenario: The tmux server is slow
- **WHEN** a tmux call the extension needs for a payload takes seconds to answer
- **THEN** the payload is loaded in the background, the session's startup and input are not delayed, and the event applies when the answer arrives

### Requirement: the worktree is published when the pane has one

The extension SHALL read the sidebar's worktree markers from its own pane's
window and SHALL send them with the session-start payload, so that a pi pane
that works in a worktree shows the worktree and its branch. The read SHALL
run in the background, inside the publisher's queue, and the session-start
handler SHALL return before it starts. The event's place in the queue SHALL be
reserved when the handler runs, so a later publish cannot apply before it. A
read that fails SHALL still publish the session-start payload, without a
worktree.

#### Scenario: The pane is in a worktree
- **WHEN** the pane's window carries the sidebar's worktree and branch options
- **THEN** the session-start payload carries that worktree and that branch

#### Scenario: The pane is not in a worktree
- **WHEN** the pane's window carries no worktree option
- **THEN** the session-start payload carries no worktree

#### Scenario: The read is still outstanding
- **WHEN** the session-start handler returns while the worktree read is outstanding
- **THEN** nothing is spawned yet, and the payload applies ahead of any event published in the meantime

#### Scenario: The read fails
- **WHEN** the worktree markers cannot be read
- **THEN** the session-start payload carries no worktree, and the session runs as before
