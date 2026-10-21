# external-orchestration Specification

## Purpose
Defines the contract that lets an orchestrator that is not a pi session, such as Claude Code, run pi subagents in tmux panes. It covers the packaged skill, how it launches children, how they report and close, and how they resume.

## Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged or failed.

#### Scenario: Install from GitHub
- **WHEN** a user runs `npx skills add slatkin/pmux -g -a claude-code`
- **THEN** the `pmux` skill, with `launch.ts`, is installed for Claude Code

#### Scenario: Copied install still launches
- **WHEN** the skill directory is a copy outside any checkout and the extension is installed through pi's git install
- **THEN** `node <skill-dir>/launch.ts start ...` finds the extension and launches the child

#### Scenario: Pi does not load the skill
- **WHEN** the package is installed into pi with `pi install`
- **THEN** pi's skill list does not include `pmux`

### Requirement: Child extension lookup
The skill launcher SHALL find the package root, meaning a directory that holds `pi-extension/pmux/cli.ts` and `pmux-done.ts`, in this order: the `PI_PMUX_DIR` directory, then the checkout containing the launcher's resolved real path, then pi's git install of this package under the pi agent directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `git/github.com/slatkin/pmux`). Paths SHALL be built with the platform's path rules. The child SHALL be launched with `-e` on that root's `pmux-done.ts`. When no candidate holds the files, the launcher MUST exit non-zero, print an error naming the `pi install` command and the candidates searched, and create no pane.

#### Scenario: Dev override
- **WHEN** `PI_PMUX_DIR` points at a checkout containing `pi-extension/pmux/pmux-done.ts`
- **THEN** the child is launched with `-e` on that file

#### Scenario: Extension not installed
- **WHEN** no candidate location holds the extension
- **THEN** the launcher exits non-zero with an error naming `pi install`, and no pane is split

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

### Requirement: Launch contract
`start` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, without taking focus, and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `pmux-done.ts` reads (with `PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. It SHALL remove `<session>.status` before it runs that spec, and then run the spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr. Because every `start` is an external-orchestrator launch, it SHALL set `PI_PMUX_EXTERNAL_PARENT=1` in the launch spec env; a pi-parent launch does not set that key. A `resume` reuses the launch spec unchanged, so the resumed child carries the marker too.

#### Scenario: Successful launch
- **WHEN** `start` is given a child name, a role, a working directory, a brief file and the parent's name
- **THEN** a new named pane runs pi in that directory with that session, and stdout is JSON with `pane`, `session` and `launch`

#### Scenario: Second launch from the same orchestrator
- **WHEN** the orchestrator in pane `%3` ran `start` once, its child pane `%5` is still alive, and it runs `start` again
- **THEN** the new pane is created by splitting `%5`, not `%3`

#### Scenario: Hostile names and paths
- **WHEN** the child name contains `;`, `$(...)` and a single quote, and the scratch directory contains a space
- **THEN** the launch succeeds, pi receives the prompt path as one argument, and no injected command runs

#### Scenario: The launch spec carries the external-parent marker
- **WHEN** `start` succeeds and the orchestrator reads the launch spec it wrote
- **THEN** the spec env holds `PI_PMUX_EXTERNAL_PARENT` with the value `1`

#### Scenario: A resume keeps the marker
- **WHEN** a child started with `start` is resumed with `resume --launch <spec>`
- **THEN** the resumed child's environment also carries `PI_PMUX_EXTERNAL_PARENT=1`

#### Scenario: A pi-parent child does not carry the marker
- **WHEN** a pi parent spawns a child with `pmux_spawn`
- **THEN** the child's env has no `PI_PMUX_EXTERNAL_PARENT`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief that gives the parent's name and pane. The footer SHALL tell the child that its last assistant message is the report the parent reads, and that it SHALL then call `pmux_done`. It SHALL tell the child not to use `caller_ping` or `pmux_message` to reach the parent.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12`
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done` or `handoff`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. The wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane. The orchestrator's wake is the `wait` command, which polls the status file; the report is the child's last assistant message, read with `last-message`.

#### Scenario: Clean completion
- **WHEN** the child calls `pmux_done` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"done"}`

#### Scenario: Handoff completion
- **WHEN** the child calls `pmux_done` with a `handoff` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds the `handoff` sidecar

#### Scenario: External wait observes done before close
- **WHEN** an orchestrator is blocked in `wait --session <file> --status done,blocked` and the child completes with `pmux_done` under the default grace period
- **THEN** the wait exits 0 before the pane closes

#### Scenario: Immediate close
- **WHEN** the child was started with `--close-grace-ms 0` and completes with `done`
- **THEN** the wrapper closes the pane immediately after printing the sentinel

#### Scenario: Provider error
- **WHEN** pi exits after writing an `error` `.exit`
- **THEN** the pane stays open showing `__SUBAGENT_DONE_<code>__`

#### Scenario: Crash
- **WHEN** pi exits without writing an `.exit` file
- **THEN** the wrapper writes an `error` `.exit` sidecar that marks its source as the wrapper, and the pane stays open showing `__SUBAGENT_DONE_<code>__`

#### Scenario: Malformed sidecar
- **WHEN** `<session>.exit` holds text that is not JSON, or JSON whose `type` is not `done` or `handoff`
- **THEN** the pane stays open

#### Scenario: The wrapper contacts nobody
- **WHEN** a skill-launched child exits and the wrapper prints `__SUBAGENT_DONE_<code>__`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

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

### Requirement: Default tool list
A role with no `tools` frontmatter line SHALL run with the default tools `read,bash,edit,write,grep,find,ls` plus `caller_ping`, `pmux_done` and `pmux_message`. This SHALL apply to skill launches and pi-parent launches alike, from a single shared definition. For pi-parent launches this is an intended narrowing: such roles previously received every pi tool.

#### Scenario: Role without tools
- **WHEN** the resolved role has no `tools` line
- **THEN** the child's `--tools` is `read,bash,edit,write,grep,find,ls,caller_ping,pmux_done,pmux_message`

#### Scenario: Pi parent spawns a role without tools
- **WHEN** a pi parent calls `pmux_spawn` with a role that has no `tools` line and no `tools` parameter
- **THEN** the child gets the same default list plus the control tools, not every pi tool

### Requirement: Last assistant message lookup
The CLI SHALL provide `last-message --session <file>`, which prints the text of the session's last assistant message, or `(no assistant message)` when there is none. It uses the extension's own session reader. `SKILL.md` SHALL use this command for the report cross-check instead of an inline script.

#### Scenario: Cross-check a report
- **WHEN** an orchestrator runs `last-message --session <file>` on a finished child's session
- **THEN** stdout is the text blocks of the last assistant message that has non-empty text

### Requirement: Skill documents the handoff sidecar
`SKILL.md` SHALL tell the orchestrator that a child can end with `{"type":"handoff","message":...}` in `<session>.exit`. It SHALL say that the task is not complete, that the handoff text is in the sidecar, that the pane closes itself after the close grace as for `done`, and that the orchestrator continues the task with a new child through `start`, with the handoff text in the brief.

#### Scenario: Orchestrator reads a handoff
- **WHEN** an orchestrator follows `SKILL.md` and finds a `handoff` sidecar
- **THEN** the skill tells it to start a new child with the handoff text in its brief, not to resume the old session

#### Scenario: Pane gone after the grace
- **WHEN** the wait on a child's status ends and no pane is left after the close grace
- **THEN** the skill tells the orchestrator to read `<session>.exit`, where `done` means finished and `handoff` means continue with a new child

### Requirement: tmux is required for launch

`start` and `resume` SHALL refuse to run unless `TMUX` and `TMUX_PANE` are both set. They SHALL call tmux only through the `tmux` binary, with the caller's pane id taken from `TMUX_PANE`.

#### Scenario: Run outside tmux
- **WHEN** `start` runs with `TMUX_PANE` unset
- **THEN** it exits non-zero with an error saying it must run inside a tmux pane, and creates nothing

### Requirement: The skill waits through the CLI

`SKILL.md` SHALL tell the orchestrator to wait for a child with the CLI `wait` command, run through the launcher as `node <skill-dir>/launch.ts wait --session <file> --status done,blocked --timeout <seconds>`. It SHALL tell the orchestrator to read the report with `last-message --session <file>`, and to read `<session>.exit` when the wait ends. It SHALL NOT document a multiplexer command for the wait or for reading a report.

#### Scenario: The orchestrator waits for a child
- **WHEN** the orchestrator follows `SKILL.md` and waits for a child
- **THEN** it runs the CLI `wait` command with the child's session file and the `done,blocked` statuses, and reads the sidecar when the wait ends

#### Scenario: The orchestrator reads the report
- **WHEN** the wait returns `done`
- **THEN** the skill tells the orchestrator to run `last-message --session <file>` for the report

### Requirement: Surface flag values
`start` and `resume` SHALL accept `--surface pane` and `--surface tab`. They SHALL read the legacy values `right` and `down` as `pane`. Any other value MUST fail before a pane is created, with an error that names the accepted values `pane` and `tab`. When the flag is absent, the default comes from the extension's `config.json`.

#### Scenario: Legacy value
- **WHEN** `start` runs with `--surface down`
- **THEN** the pane is placed by the tmux-backend split rule

#### Scenario: Invalid value
- **WHEN** `start` runs with `--surface window`
- **THEN** it exits non-zero with an error naming `pane` and `tab`, and no pane is created

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
