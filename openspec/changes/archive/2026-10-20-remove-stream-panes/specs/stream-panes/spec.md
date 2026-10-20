# Spec Delta

## REMOVED Requirements

### Requirement: Stream command

**Reason**: pmux exists to run subagents in tmux panes. The `/stream` command
opens a second set of panes that mirror the parent's own model output, which is
not part of that job.

**Migration**: None. Follow the subagent panes instead. A user who wants the
model output in a pane can run pi in that pane.

### Requirement: Follower pane placement

**Reason**: The follower panes existed only to host a stream tailer, so their
placement rules go with the tailer.

**Migration**: None.

### Requirement: Stream content

**Reason**: The thinking and tools streams mirrored pi events into the socket
hub, which is deleted with the rest of the feature.

**Migration**: None. The transcript keeps showing thinking blocks and tool
rows.

### Requirement: Replay of the current turn

**Reason**: The replay ring lived in the session hub, which is deleted with the
rest of the feature.

**Migration**: None.

### Requirement: Transcript omits attached content

**Reason**: The transcript rewriting existed only to leave room for a stream
pane. Without streams the transcript always renders pi's normal output.

**Migration**: None.

### Requirement: Detach restores the transcript

**Reason**: There is nothing to detach, so the transcript never needs
restoring.

**Migration**: None.

### Requirement: Unrecognised transcript layout fails open

**Reason**: pmux no longer touches the rendered transcript, so it can no longer
mismatch pi's transcript layout.

**Migration**: None.

### Requirement: Streams require a tmux pane

**Reason**: The rule guarded the stream panes, which no longer exist.

**Migration**: None.
