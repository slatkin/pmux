# Spec Delta

## MODIFIED Requirements

### Requirement: Launch record at spawn
When `pmux_spawn` starts a pi or Claude Code child, the extension SHALL write a launch record to `<session>.launch.json`, where `<session>` is the child session file. The record SHALL hold the backend, display name, agent name, working directory, model, tool allowlist, role prompt, denied tools, auto-exit and interactive values that the spawn resolved. When the role has a valid `surface:`, the record SHALL also hold that value. A per-call `surface` SHALL NOT be recorded.

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
- **WHEN** `pmux_spawn` starts an agent with no `surface:` and the call has `surface: "float"`
- **THEN** the launch record holds no surface

### Requirement: Resume restores the role configuration
When `pmux_resume` is called with a session file that has a launch record, the extension SHALL start the child with the record's backend, agent name, working directory, model, tool allowlist, role prompt and denied tools. The resumed child SHALL show the record's display name. The surface SHALL be the call's `surface` when given, else the record's surface, else the configured default.

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
- **WHEN** `pmux_resume` resumes a session whose record holds the surface `float`, without a `surface` parameter
- **THEN** the resumed child opens as a float

#### Scenario: Record without a surface
- **WHEN** `pmux_resume` resumes a session whose record holds no surface, without a `surface` parameter
- **THEN** the configured default applies
