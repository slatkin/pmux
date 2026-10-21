## MODIFIED Requirements

### Requirement: Launch contract
`start` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, without taking focus, and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `pmux-done.ts` reads (with `PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. It SHALL remove `<session>.status` before it runs that spec, and then run the spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr. Because every `start` is an external-orchestrator launch, it SHALL set `PI_PMUX_EXTERNAL_PARENT=1` in the launch spec env; a pi-parent launch does not set that key. A `resume` rebuilds the launch spec from the launch record with the same external parent, so the resumed child carries the marker too.

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

### Requirement: Resume in a new pane
`resume --launch <spec> --prompt <file> [--name <child>]` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, name it (after `--name`, or the child name stored in the spec), and run the child there with the new prompt, so that pi resumes the same session with its context. `resume` SHALL rebuild the launch spec from the launch record beside the spec's session file. The rebuilt spec SHALL keep the `parent`, the report mode and the close grace of the old spec. `resume` SHALL write it back to the `--launch` path. When the spec holds a `parent`, the prompt sent to the child SHALL be the given prompt followed by the parent-contact footer of the spec's report mode, built from the spec's `parent`. Resume MUST NOT need the child's previous pane to exist. The surface SHALL be the role surface stored in the record, else the `config.json` default. On success it SHALL print JSON with `pane` and `launch`.

#### Scenario: Resume after close-on-done
- **WHEN** a child's pane closed on done and the orchestrator resumes it with a follow-up prompt
- **THEN** a new pane runs pi on the same session file, and the child keeps its earlier context

#### Scenario: Resume keeps the role's float
- **WHEN** a child of a role with `surface: float` was started with `start`, and it is resumed with `resume`
- **THEN** the resumed child opens as a float

#### Scenario: Spec without a role surface
- **WHEN** a child is resumed from a launch spec that holds no role surface
- **THEN** the `config.json` default applies

#### Scenario: Resume keeps the send footer
- **WHEN** a child started with `--report send --parent %12` is resumed with a follow-up prompt
- **THEN** the prompt the resumed child receives ends with the `send` footer naming pane `%12`

#### Scenario: Resume keeps the last footer
- **WHEN** a child started without `--report` is resumed with a follow-up prompt
- **THEN** the prompt the resumed child receives ends with the `last` footer

#### Scenario: Resume keeps the close grace
- **WHEN** a child started with `--close-grace-ms 0` is resumed
- **THEN** the rebuilt launch spec holds `closeOnDone` with `graceMs` 0

### Requirement: Per-child launch spec
`start` SHALL write a per-child launch spec under the scratch directory. It holds everything needed to start the child except its pane and prompt. When the resolved role has a valid `surface:`, the spec SHALL hold that value. `start` SHALL also write the launch record beside the session file, at `<session>.launch.json`, in the same format that `pmux_spawn` writes. The run wrapper SHALL set `PI_PMUX_SURFACE` from `TMUX_PANE` at runtime, so that the spec can run in any later pane. An invalid spec SHALL make the wrapper exit non-zero, naming the file, without starting a child.

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
- **WHEN** `start` runs for a role with no `surface:` (there is no `--surface` flag)
- **THEN** the launch spec holds no surface

#### Scenario: Start writes the launch record
- **WHEN** `start` succeeds with role `worker`
- **THEN** `<session>.launch.json` exists, holds backend `pi`, agent `worker` and the role's model, and is valid as a launch record

## ADDED Requirements

### Requirement: Task prompt location
`start` SHALL write the prompt the child receives to `<scratch>/artifacts/<id>/context/<name>-<timestamp>.md`, where `<id>` is the parent session id and `<timestamp>` has 19 characters. `resume` SHALL write it to `<scratch>/artifacts/<id>/pmux-resume/<name>-<timestamp>.md`. The child SHALL receive that path as `@<path>`. The pi-parent path SHALL use the same folder and file names under its own artifact directory.

#### Scenario: Start prompt path
- **WHEN** `start` runs with name `w2` and the parent session id is `abc`
- **THEN** pi receives `@<scratch>/artifacts/abc/context/w2-<timestamp>.md`, and that file holds the brief followed by the footer

#### Scenario: Resume prompt path
- **WHEN** that child is resumed
- **THEN** pi receives `@<scratch>/artifacts/abc/pmux-resume/w2-<timestamp>.md`

### Requirement: Parent session id
`start` SHALL read the parent session id from the `@pane_session_id` option of the caller's pane (`TMUX_PANE`), not from `--parent`. If the option is empty or the read fails, `start` SHALL use the caller's pane id as the id and continue the launch. `resume` SHALL reuse the id that `start` used.

#### Scenario: Caller pane has a session id
- **WHEN** the caller pane `%5` has `@pane_session_id` set to `abc`
- **THEN** the prompt path holds `artifacts/abc/`

#### Scenario: Caller pane has no session id
- **WHEN** the caller pane `%5` has no `@pane_session_id`
- **THEN** the launch succeeds and the prompt path holds `artifacts/%5/`

### Requirement: Resume needs a launch record
If no valid launch record exists beside the spec's session file, `resume` SHALL refuse the launch spec. It SHALL print a message on stderr that tells the caller to run `start` again, print nothing on stdout, exit 1 and split no pane.

#### Scenario: Spec from an older version
- **WHEN** `resume` is given a launch spec whose session file has no `.launch.json`
- **THEN** it exits 1 with a message that names `start`, and no pane is created
