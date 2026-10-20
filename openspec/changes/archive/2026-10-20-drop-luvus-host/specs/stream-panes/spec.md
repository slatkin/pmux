# Spec Delta

## Purpose

Streams need a tmux pane.

## REMOVED Requirements

### Requirement: Streams require a Luvus pane

**Reason**: The host is tmux. The replacement is "Streams require a tmux pane".

**Migration**: The pane id comes from `TMUX_PANE`.

## ADDED Requirements

### Requirement: Streams require a tmux pane

The command SHALL refuse to open a stream when the pi process does not know the id of a tmux pane. It SHALL report that a tmux pane is required and SHALL leave stream state unchanged.

#### Scenario: pi running outside tmux
- **WHEN** the user runs `/stream thinking` in a pi process with no pane id in its environment
- **THEN** the command reports that a tmux pane is required and nothing is opened or attached
