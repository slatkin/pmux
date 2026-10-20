# Spec Delta

## Purpose

The title is the tmux pane title. The Luvus history row has no equivalent.

## REMOVED Requirements

### Requirement: Resumable pi sessions show the project folder

**Reason**: It described a Luvus AGENTS history row. tmux has no such list.

**Migration**: None. A finished session is resumed with `pmux_resume` and its session file.

## MODIFIED Requirements

### Requirement: Unnamed pi panes show their first prompt
For a non-subagent pi session that has no session name, the extension SHALL set the pane OSC title to `π - <prompt> - <cwd basename>`. `<prompt>` is the first non-empty line of the first user prompt, cut to 48 characters. Before the first prompt, pi's own title stays.

#### Scenario: First prompt in an unnamed session
- **WHEN** you send the prompt "Fix the login redirect" in an unnamed pi session in `/work/app`
- **THEN** the pane title is `π - Fix the login redirect - app`

#### Scenario: Session reload
- **WHEN** the extension reloads in a session that already has a first prompt
- **THEN** the pane title is set again from that first prompt

### Requirement: Session names take precedence
When a pi session has a name, the extension SHALL NOT set the OSC title. pi's own title `π - <name> - <cwd basename>` shows instead.

#### Scenario: Name set after the first prompt
- **WHEN** you name a session after its first prompt
- **THEN** the pane title changes to pi's named title and the extension does not overwrite it
