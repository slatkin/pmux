# Spec Delta

## MODIFIED Requirements

### Requirement: Launch record at spawn
When `pmux_spawn` starts a pi or Claude Code child, the extension SHALL write a launch record to `<session>.launch.json`, where `<session>` is the child session file. The record SHALL hold the backend, display name, agent name, working directory, model, tool allowlist, role prompt, denied tools, auto-exit and interactive values that the spawn resolved. When the role has a valid `surface:`, the record SHALL also hold that value.

#### Scenario: Pi child spawned with an agent
- **WHEN** `pmux_spawn` starts agent `scout` with `cwd` `/repo` and the agent frontmatter sets `spawning: false`
- **THEN** `<session>.launch.json` exists and records backend `pi`, agent `scout`, cwd `/repo`, and the spawning tools in its denied tools

#### Scenario: Claude Code child spawned
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets `cli: claude`
- **THEN** `<session>.launch.json` exists and records backend `claude`

#### Scenario: Role surface recorded
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets `surface: float`
- **THEN** the launch record holds the surface `float`

#### Scenario: Per-call surface not recorded
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets no `surface:` (a call carries no surface value)
- **THEN** the launch record holds no surface

### Requirement: Resume restores the role configuration
When `pmux_resume` is called with a session file that has a launch record, the extension SHALL start the child with the record's backend, agent name, working directory, model, tool allowlist, role prompt and denied tools. The resumed child SHALL show the record's display name. The surface SHALL be the record's surface when the record holds one, else the configured default.

#### Scenario: Resumed scout keeps its deny list
- **WHEN** `pmux_resume` resumes a session whose record denies `pmux_spawn`
- **THEN** the resumed child does not have the `pmux_spawn` tool

#### Scenario: Resumed child keeps its working directory
- **WHEN** `pmux_resume` resumes a session whose record has cwd `/repo`, from a parent whose cwd is `/other`
- **THEN** the resumed child runs in `/repo`

#### Scenario: Resumed child keeps its name and agent
- **WHEN** `pmux_resume` resumes a session whose record has name `Worker` and agent `worker`
- **THEN** the pane is named `Worker` and the child runs as agent `worker`

#### Scenario: Resumed child keeps its role surface
- **WHEN** `pmux_resume` resumes a session whose record holds the surface `float`
- **THEN** the resumed child opens as a float

#### Scenario: Record without a surface
- **WHEN** `pmux_resume` resumes a session whose record holds no surface
- **THEN** the configured default applies

### Requirement: Resume parameters
`pmux_resume` SHALL accept exactly `sessionPath` (required), `message` and `autoExit`. When `autoExit` is absent, the record's auto-exit value SHALL apply, and the record's interactive value SHALL apply. When `autoExit` is present, it SHALL override the record, and the run SHALL be interactive exactly when `autoExit` is false.

#### Scenario: Auto-exit from the record
- **WHEN** `pmux_resume` resumes a session whose record has auto-exit on, and `autoExit` is not given
- **THEN** the resumed child runs with auto-exit on

#### Scenario: Caller turns auto-exit off
- **WHEN** `pmux_resume` is called with `autoExit: false`
- **THEN** the resumed child runs without auto-exit, and its stalled and recovered transitions do not wake the parent