# Spec Delta

## MODIFIED Requirements

### Requirement: Role resolution
`start` SHALL resolve a role name with the same lookup the extension uses: the `.pi/agents/` directory of the child's working directory, then the global agents directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `agents/`), then the package's `agents/`. The first file that exists wins. It SHALL use the frontmatter `model`, `thinking`, `tools` and `surface` fields, the `auto-exit` flag, the `spawning` flag and the `deny-tools` list, and the body as the appended system prompt. The child SHALL get the same denied tools that a pi-parent launch of the same role gives. Role files with LF or CRLF line endings SHALL parse the same way. An unknown role, or a role whose `model` is empty, MUST fail before a pane is split.

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
- **WHEN** the role's frontmatter has `model:` with no value, followed by other fields
- **THEN** `start` exits non-zero saying the role has an empty model, and splits no pane

#### Scenario: CRLF role file
- **WHEN** the role file uses CRLF line endings
- **THEN** its model, tools, surface, auto-exit flag, spawning flag, deny-tools list and body resolve the same as the LF version

#### Scenario: Floating role
- **WHEN** the resolved role's frontmatter has `surface: float` and `start` runs without `--surface`
- **THEN** the child opens as a float by the tmux-backend float rule

### Requirement: Resume in a new pane
`resume --launch <spec> --prompt <file> [--name <child>]` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, name it (after `--name`, or the child name stored in the spec), and run the existing launch spec there with the new prompt, so that pi resumes the same session with its context. Resume MUST NOT need the child's previous pane to exist. The surface SHALL be `--surface` when given, else the role surface stored in the spec, else the `config.json` default. On success it SHALL print JSON with `pane` and `launch`.

#### Scenario: Resume after close-on-done
- **WHEN** a child's pane closed on done and the orchestrator resumes it with a follow-up prompt
- **THEN** a new pane runs pi on the same session file, and the child keeps its earlier context

#### Scenario: Resume keeps the role's float
- **WHEN** a child of a role with `surface: float` was started with `start`, and it is resumed with `resume` and no `--surface`
- **THEN** the resumed child opens as a float

#### Scenario: Spec without a role surface
- **WHEN** a child is resumed from a launch spec that holds no role surface, and no `--surface` is given
- **THEN** the `config.json` default applies

### Requirement: Per-child launch spec
`start` SHALL write a per-child launch spec under the scratch directory. It holds everything needed to start the child except its pane and prompt. When the resolved role has a valid `surface:`, the spec SHALL hold that value. The run wrapper SHALL set `PI_PMUX_SURFACE` from `TMUX_PANE` at runtime, so that the spec can run in any later pane. An invalid spec SHALL make the wrapper exit non-zero, naming the file, without starting a child.

#### Scenario: Spec is pane-independent
- **WHEN** the launch spec runs in a pane other than the one it was written for
- **THEN** the child reports `PI_PMUX_SURFACE` as that pane's id

#### Scenario: Corrupt spec
- **WHEN** `run` is given a spec file that is not valid JSON or lacks the child command
- **THEN** it exits non-zero naming the file, and no child starts

#### Scenario: Spec records the role surface
- **WHEN** `start` launches a role whose frontmatter has `surface: tab`
- **THEN** the launch spec holds the surface `tab`

#### Scenario: Per-call surface is not recorded
- **WHEN** `start` runs with `--surface float` for a role with no `surface:`
- **THEN** the launch spec holds no surface

## ADDED Requirements

### Requirement: Float surface flag
`start` and `resume` SHALL accept `--surface float` in addition to `pane` and `tab`. The error for an invalid value SHALL name `pane`, `tab` and `float`. For `start`, the surface SHALL be `--surface` when given, else the role's `surface:`, else the `config.json` default.

#### Scenario: Ad-hoc float
- **WHEN** `start` runs with `--surface float` for a role with no `surface:`
- **THEN** the child opens as a float by the tmux-backend float rule

#### Scenario: Flag beats the role
- **WHEN** `start` runs with `--surface pane` for a role with `surface: float`
- **THEN** the child is placed by the tmux-backend split rule

#### Scenario: Invalid value names float
- **WHEN** `start` runs with `--surface window`
- **THEN** it exits non-zero with an error naming `pane`, `tab` and `float`, and no pane is created
