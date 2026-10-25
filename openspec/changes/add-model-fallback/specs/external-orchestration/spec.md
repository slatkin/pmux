## ADDED Requirements

### Requirement: Start on the fallback model
`start` SHALL accept an optional `--fallback` flag that takes no value. With the flag, the child SHALL run on the role's `model-fallback` instead of its `model`, and the launch record SHALL hold that model. Without the flag, `start` SHALL behave as before. All other role values SHALL apply as before.

#### Scenario: Start with the flag
- **WHEN** `start --fallback` runs for a role with `model: hyper/glm-5.3-flash` and `model-fallback: opencode-go/glm-5.3-flash`
- **THEN** the launch spec starts pi with the model `opencode-go/glm-5.3-flash`

#### Scenario: Start without the flag
- **WHEN** `start` runs for the same role without `--fallback`
- **THEN** the launch spec starts pi with the model `hyper/glm-5.3-flash`

### Requirement: Fallback start errors
`start --fallback` MUST exit non-zero with a message on stderr that names the role and `model-fallback`, before any file is written or any pane is split, when the role has no `model-fallback`. The empty-model check SHALL apply to the model that the flag selects: a role with a `model-fallback` and no `model` SHALL start with the flag.

#### Scenario: Role without a fallback
- **WHEN** `start --fallback` runs for a role that sets no `model-fallback`
- **THEN** it exits non-zero naming the role and `model-fallback`, writes no scratch file, and splits no pane

#### Scenario: Fallback without a primary model
- **WHEN** `start --fallback` runs for a role that sets `model-fallback` and no `model`
- **THEN** the child starts on the fallback model

#### Scenario: No fallback and no model
- **WHEN** `start` runs without the flag for a role that sets `model-fallback` and no `model`
- **THEN** it exits non-zero saying the role has an empty model, and splits no pane

### Requirement: Resume takes no fallback flag
`resume` SHALL take the model from the launch record. A `--fallback` flag given to `resume` MUST be a usage error: a message on stderr that points at `start`, nothing on stdout, exit 1, and the stored model unchanged.

#### Scenario: Flag on resume
- **WHEN** `resume --launch <spec> --fallback` runs
- **THEN** it exits 1 with a message on stderr, and no pane is created

#### Scenario: Resume of a fallback child
- **WHEN** `resume` runs for a child that `start --fallback` launched
- **THEN** the resumed child runs on the fallback model that the launch record holds

### Requirement: Skill documents the fallback flag
`SKILL.md` SHALL document `--fallback` in its `start` usage and SHALL say when to use it: the orchestrator's primary model for that role hits API limits or errors, or the user asks for the fallback or alternate model. It SHALL say that the flag fails when the role has no `model-fallback`, that `resume` takes no flag, and that nothing switches models automatically.

#### Scenario: The skill teaches the flag
- **WHEN** an external orchestrator reads the `start` section of `SKILL.md`
- **THEN** it finds `--fallback`, the cases in which to use it, and the failure for a role without `model-fallback`

## MODIFIED Requirements

### Requirement: Role resolution
`start` SHALL resolve a role name with the same lookup the extension uses: the `.pi/agents/` directory of the child's working directory, then the global agents directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `agents/`), then the package's `agents/`. The first file that exists wins. It SHALL use the frontmatter `model`, `thinking`, `tools` and `surface` fields, the `auto-exit` flag, the `spawning` flag and the `deny-tools` list, and the body as the appended system prompt. The child SHALL get the same denied tools that a pi-parent launch of the same role gives. Role files with LF or CRLF line endings SHALL parse the same way. An unknown role MUST fail before a pane is split. A role whose `model` is empty MUST also fail before a pane is split, unless `start` runs with `--fallback`: then the check applies to the role's `model-fallback` instead (see "Fallback start errors").

#### Scenario: Auto-exit role
- **WHEN** the resolved role's frontmatter has `auto-exit: true`
- **THEN** the child runs with `PI_PMUX_AUTO_EXIT=1`

#### Scenario: Control tools always present
- **WHEN** the role's `tools` list omits `pmux_done`
- **THEN** the child's `--tools` still includes `caller_ping`, `pmux_done` and `pmux_message`

#### Scenario: Role denies spawning
- **WHEN** the resolved role's frontmatter has `spawning: false`
- **THEN** the child runs with `PI_DENY_TOOLS` naming `pmux_spawn`, `pmux_interrupt`, `pmux_list` and `pmux_resume`

#### Scenario: Role denies listed tools
- **WHEN** the resolved role's frontmatter has `deny-tools: claude` and no `spawning` line
- **THEN** the child runs with `PI_DENY_TOOLS=claude`

#### Scenario: Role denies nothing
- **WHEN** the resolved role has no `spawning` line and no `deny-tools` line
- **THEN** the child's env has no `PI_DENY_TOOLS`

#### Scenario: Unknown role
- **WHEN** no role file matches the given role name
- **THEN** `start` exits non-zero naming the role and the paths searched, and splits no pane

#### Scenario: Empty model
- **WHEN** `start` runs without `--fallback` and the role's frontmatter has `model:` with no value, followed by other fields
- **THEN** `start` exits non-zero saying the role has an empty model, and splits no pane

#### Scenario: CRLF role file
- **WHEN** the role file uses CRLF line endings
- **THEN** its model, tools, surface, auto-exit flag, spawning flag, deny-tools list and body resolve the same as the LF version

#### Scenario: Floating role
- **WHEN** the resolved role's frontmatter has `surface: float`
- **THEN** the child opens as a float by the tmux-backend float rule
