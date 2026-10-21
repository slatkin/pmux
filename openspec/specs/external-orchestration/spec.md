# external-orchestration Specification

## Purpose
Defines the contract that lets an orchestrator that is not a pi session, such as Claude Code, run pi subagents in tmux panes. It covers the packaged skill, how it launches children, how they report and close, and how they resume.

## Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged or failed. The statement that there is no channel from the child back to the orchestrator, and the bullet that the report is the child's last assistant message, SHALL be scoped to the default `last` mode and SHALL point at the new section, so that neither reads as false in `send` mode. The shared recipes that assume a last-mode child SHALL say that they apply to `last` mode only: the idle-child nudge text in `SKILL.md`, the `wait` paragraph in `docs/guide.md`, and the external-orchestrator paragraph in `README.md`. `SKILL.md` SHALL have a section named "External orchestrators (Claude Code)" that documents the `send` mode: start with `--report send` and `--parent "$TMUX_PANE"`; the report arrives as text typed into the orchestrator's pane; wait with `--signal sidecar`; leave the sidecar in place, because the wrapper reads it after the child exits, `start` and `resume` clear it on relaunch, and `prune` reclaims it; and `resume --launch <spec> --prompt <file>` appends the footer again. The skill's frontmatter description SHALL say that the skill serves external orchestrators such as Claude Code.

#### Scenario: Install from GitHub
- **WHEN** a user runs `npx skills add slatkin/pmux -g -a claude-code`
- **THEN** the `pmux` skill, with `launch.ts`, is installed for Claude Code

#### Scenario: Copied install still launches
- **WHEN** the skill directory is a copy outside any checkout and the extension is installed through pi's git install
- **THEN** `node <skill-dir>/launch.ts start ...` finds the extension and launches the child

#### Scenario: Pi does not load the skill
- **WHEN** the package is installed into pi with `pi install`
- **THEN** pi's skill list does not include `pmux`

#### Scenario: The skill teaches send mode
- **WHEN** an external orchestrator follows the "External orchestrators (Claude Code)" section
- **THEN** it starts the child with `--report send --parent "$TMUX_PANE"`, ends its turn, waits with `--signal sidecar` when it is woken, and does not delete the sidecar

#### Scenario: The last-mode claims are scoped
- **WHEN** a reader reads the skill's intro, the "The report" bullet, or the idle-child nudge recipe
- **THEN** each says that it describes the default `last` mode, and the intro points at the "External orchestrators (Claude Code)" section

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
- **WHEN** the resolved role's frontmatter has `surface: float`
- **THEN** the child opens as a float by the tmux-backend float rule

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

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief. In `last` mode the footer SHALL give the parent's name and pane, tell the child that its last assistant message is the report the parent reads and that it SHALL then call `pmux_done`, and tell the child not to use `caller_ping` or `pmux_message` to reach the parent; its text SHALL be the same bytes as before the `--report` flag existed. In `send` mode the footer SHALL name the parent's pane, and SHALL teach `node <cli> send --to <parent pane> --text '<report>'`, where `<cli>` is the absolute path of the package's `cli.ts`, as the report step, followed by a call to `pmux_done`. It SHALL tell a blocked child to send its question with the same command and stop. It SHALL tell the child to ignore a reminder's claim that its last message was already delivered, and to send its report first. It SHALL NOT say that a missing report leaves the parent unaware of the exit, because the send-mode wake-up reports the exit state. Its statement about the session closing when a turn ends SHALL be conditional, because a role without `auto-exit: true` keeps its session open and gets the completion nudge. The `send` footer MUST NOT say that the last assistant message is delivered or read as the report.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12` in `last` mode
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

#### Scenario: Send footer teaches the command
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the prompt ends with a footer that holds `node <cli> send --to %12 --text`, names `pmux_done`, tells a blocked child to send its question and stop, and does not say that the last assistant message is the report

#### Scenario: Send footer overrides the nudge
- **WHEN** a send-mode child reads its footer
- **THEN** the footer tells it to ignore a reminder's claim that its last message was already delivered, and to send its report before it calls `pmux_done`

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done` or `handoff`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. In `last` mode the wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane; the orchestrator's wake is the `wait` command, which polls the status file, and the report is the child's last assistant message, read with `last-message`. In `send` mode the wrapper SHALL contact the parent only by the send-mode wake-up, and SHALL NOT address any pane by title.

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
- **WHEN** a last-mode skill-launched child exits and the wrapper prints `__SUBAGENT_DONE_<code>__`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

#### Scenario: Send mode wakes before it closes
- **WHEN** a send-mode child exits with a `done` sidecar and no receipt to its parent
- **THEN** the wrapper sends the wake-up to the parent's pane, and then closes its own pane after the grace

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
`SKILL.md` SHALL tell the orchestrator to wait for a child with the CLI `wait` command, run through the launcher. For the `last` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --status done,blocked --timeout <seconds>`, tell the orchestrator to read the report with `last-message --session <file>`, and to read `<session>.exit` when the wait ends. For the `send` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --signal sidecar [--timeout <seconds>]` and tell the orchestrator to act on the printed reason without deleting the sidecar. It SHALL NOT document a multiplexer command for the wait or for reading a report.

#### Scenario: The orchestrator waits for a child
- **WHEN** the orchestrator follows `SKILL.md` and waits for a last-mode child
- **THEN** it runs the CLI `wait` command with the child's session file and the `done,blocked` statuses, and reads the sidecar when the wait ends

#### Scenario: The orchestrator reads the report
- **WHEN** the wait returns `done` for a last-mode child
- **THEN** the skill tells the orchestrator to run `last-message --session <file>` for the report

#### Scenario: The orchestrator waits on the sidecar
- **WHEN** the orchestrator follows the send-mode section and is woken by a report
- **THEN** it runs `wait --session <file> --signal sidecar`, reads the printed reason, and leaves the sidecar in place

### Requirement: No surface flag
`start` and `resume` SHALL NOT accept a `--surface` flag. An invocation that carries the flag MUST fail before a pane is created. A launch's surface SHALL come from the role's `surface:` frontmatter when it names `pane`, `tab` or `float`, and from the configured default otherwise.

#### Scenario: Flag is rejected
- **WHEN** `start` runs with `--surface float`
- **THEN** it exits non-zero with an unknown-argument error, and no pane is created

#### Scenario: Role decides without a flag
- **WHEN** `start` runs for a role with no `surface:` and the `config.json` default is `tab`
- **THEN** the child opens in its own tmux window

### Requirement: Report mode selection
`start` SHALL accept `--report last|send`, with `last` as the default. In `last` mode the report is the child's last assistant message, as before. In `send` mode the child types its report into the parent's pane with `send`, and `--parent` SHALL be the orchestrator's tmux pane id. Any other value MUST make `start` exit 2 with a stderr message naming the value, before any file is written or any pane is split.

#### Scenario: Default mode
- **WHEN** `start` runs without `--report`
- **THEN** the prompt ends with the `last` footer

#### Scenario: Invalid mode
- **WHEN** `start` runs with `--report email`
- **THEN** it exits 2 with a message on stderr naming `email`, writes no scratch file, and splits no pane

### Requirement: Send-mode child keeps the bash tool
In `send` mode `start` SHALL put `bash` into the child's tool allowlist and SHALL NOT put it in the child's denied tools, because the report is a bash command and the denied set wins over the allowlist. In `last` mode `start` SHALL leave the allowlist and the denied tools as they are without this change.

#### Scenario: Send mode keeps bash
- **WHEN** `start --report send` runs for a role whose `tools` list omits `bash`, or whose `deny-tools` names `bash`
- **THEN** the child's tool allowlist holds `bash` and its denied tools do not

#### Scenario: Last mode does not force bash
- **WHEN** `start` runs without `--report` for a role whose `tools` list omits `bash`
- **THEN** the child's tool allowlist holds no `bash`

### Requirement: Resume keeps the stored report mode
`resume` SHALL take the report mode from the launch spec. A `--report` flag given to `resume` MUST be a usage error: a message on stderr, nothing on stdout, exit 1, and the stored mode unchanged.

#### Scenario: Resume takes the stored mode
- **WHEN** `resume --launch <spec> --prompt <file> --report send` runs on a spec that holds no `report` field
- **THEN** it exits 1 with a message on stderr, stdout is empty, and the spec is unchanged

### Requirement: Report mode in the launch spec
In `send` mode the launch spec SHALL hold `report` with the value `send`. In `last` mode the spec SHALL hold no `report` field. A spec with no `report` field SHALL be read as `last`. A spec whose `report` field is present and is neither `last` nor `send` SHALL be invalid.

#### Scenario: Last mode writes no field
- **WHEN** `start` runs without `--report`
- **THEN** the launch spec holds no `report` field

#### Scenario: Send mode is recorded
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the launch spec holds `report` with the value `send` and `parent` with the value `%12`

#### Scenario: Unknown stored mode
- **WHEN** `run` is given a launch spec whose `report` is `email`
- **THEN** it exits non-zero naming the file, and no child starts

### Requirement: Send command
The CLI SHALL provide `send --to <pane> --text <text>`. It SHALL type the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell. Before it is typed, the text SHALL be encoded so that it holds no line terminator and no tab: a newline (U+000A) SHALL become the two characters `\n`, a carriage return (U+000D) the two characters `\r`, a tab (U+0009) the two characters `\t`, and any other C0 control character or DEL (U+007F) the four characters `\xNN` with two lowercase hex digits. Every other character, a backslash included, SHALL be typed as it is. The report therefore reaches the parent as one input, whatever the parent pane runs. A missing `--to` or `--text` MUST be a usage error: a message on stderr naming the flag, nothing on stdout, exit 1, and nothing is sent.

#### Scenario: Report delivered
- **WHEN** a child runs `send --to %12 --text 'PASS abc123'`
- **THEN** tmux receives `send-keys -t %12 -l 'PASS abc123'` and then `send-keys -t %12 Enter`

#### Scenario: Multiline report
- **WHEN** the text holds several lines
- **THEN** tmux receives one `send-keys -t %12 -l` call whose text holds the lines joined by the two characters `\n`, and then `send-keys -t %12 Enter`

#### Scenario: Control characters
- **WHEN** the text holds a tab or another control character
- **THEN** the typed text holds `\t` or `\xNN` in its place, and no tab and no control byte is typed

#### Scenario: Missing flag
- **WHEN** `send` runs without `--text`
- **THEN** it exits 1 with an error naming `--text` on stderr, stdout is empty, and tmux receives no call

### Requirement: Report receipts
When `send` runs with `PI_PMUX_SESSION` set, it SHALL append, after the delivery, one JSON line `{"at":<ISO time>,"to":<to>,"bytes":<text length in bytes>}` to `<PI_PMUX_SESSION>.sent`, where `<text length in bytes>` is the length in bytes of the text `send` received, before the pane-input encoding. When `PI_PMUX_SESSION` is not set, it SHALL write no receipt. A failed receipt write MUST NOT fail the send. `prune` SHALL treat `.sent` files as launcher files, so it deletes them past the retention and keeps them within it.

#### Scenario: Receipt inside a child
- **WHEN** `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains one line whose JSON has `to` equal to `%12`, `bytes` equal to `2` UTF-8 bytes and an ISO `at`

#### Scenario: Receipt counts the text as received
- **WHEN** `send --to %12 --text 'line one\nline two'` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** the receipt's `bytes` counts the newline in the text, not the encoded form that was typed

#### Scenario: No receipt outside a child
- **WHEN** `send` runs without `PI_PMUX_SESSION`
- **THEN** no `.sent` file is written

#### Scenario: Receipt write fails
- **WHEN** `<session>.sent` cannot be written
- **THEN** `send` still delivers the text and exits 0

#### Scenario: Prune reclaims receipts
- **WHEN** `prune` runs on a scratch directory holding a `.sent` file older than the retention and one within it
- **THEN** the old one is deleted and the fresh one is kept

### Requirement: Send-mode report count
For a send-mode spec with a `parent`, the run wrapper SHALL count the `<session>.sent` lines that parse as JSON and whose `to` equals `parent`, once before the child starts and once after the sentinel. A missing file counts as zero; an unparseable line is skipped. When the count did not grow, the wrapper SHALL send the send-mode wake-up. In `last` mode the wrapper SHALL NOT count and SHALL NOT wake anyone.

#### Scenario: Count grows
- **WHEN** a send-mode child with parent `%12` runs `send --to %12` once and exits
- **THEN** the second count is one more than the first, and no wake-up is sent

### Requirement: Send-mode wake-up
The send-mode wake-up SHALL be one message typed into the parent's pane through the pane-input primitive of `send`, before the close-on-done step. Its text SHALL be encoded the way the `send` command encodes its text, so a ping question that spans lines reaches the parent as one input. For a `ping` sidecar with a string `message` it SHALL be `<name> pinged: <message>`. Otherwise it SHALL be `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`. A failed wake-up SHALL go to stderr only.

#### Scenario: Exit without a report
- **WHEN** a send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

#### Scenario: Failed wake-up
- **WHEN** the wake-up cannot be delivered to the parent's pane
- **THEN** the wrapper writes an error naming the parent to stderr, and its exit code is the child's code

#### Scenario: Ping is quoted
- **WHEN** a send-mode child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no receipt
- **THEN** the parent receives `<name> pinged: Which DB?`

#### Scenario: A ping question that spans lines
- **WHEN** a send-mode child exits with a ping sidecar whose message holds a line break, and no receipt
- **THEN** the parent receives one message, with the line break written as the two characters `\n`

#### Scenario: The name is the launch spec's name
- **WHEN** a send-mode child launched as `worker-a` exits and its own sidecar names `w`
- **THEN** the wake-up text names `worker-a`

#### Scenario: Crash without a report
- **WHEN** a send-mode child exits with code 2, wrote no sidecar, left no terminal status, and wrote no receipt
- **THEN** the wrapper writes its `error` sidecar, and the parent receives a message with the state `error` and the `last-message` command

#### Scenario: Crash after a terminal status
- **WHEN** a send-mode child exits with code 2, wrote no sidecar, left a `done` status, and wrote no receipt
- **THEN** the wrapper writes no `error` sidecar, and the parent receives a message with the state `crashed (code 2)` and the `last-message` command

#### Scenario: Report suppresses the wake-up
- **WHEN** a send-mode child sends its report to its parent and exits
- **THEN** the parent receives no message from the wrapper

#### Scenario: Report to another pane
- **WHEN** a send-mode child sends only to a pane that is not its parent and exits
- **THEN** the parent is still woken

#### Scenario: Malformed receipt line
- **WHEN** the only new line in `<session>.sent` is not JSON
- **THEN** the parent is still woken

#### Scenario: Earlier runs do not count
- **WHEN** a resumed send-mode child exits without a report, and `<session>.sent` holds receipts to the parent from the earlier run
- **THEN** the parent is woken

#### Scenario: Last mode stays silent
- **WHEN** a last-mode child exits without a report
- **THEN** no text is typed into any pane but the child's own

### Requirement: Wait on the exit sidecar
`wait` SHALL accept `--signal status|sidecar`, with `status` as the default. With `status`, `wait` SHALL behave as before. With `sidecar`, `wait` SHALL poll `<session>.exit` every 500 ms and MUST NOT delete, move or write it. When the file exists, `wait` SHALL print one JSON line, the sidecar decoded by `interpretExitSidecar` plus `sidecar` set to the sidecar's absolute path, and exit 0.

#### Scenario: Sidecar present
- **WHEN** `wait --session <file> --signal sidecar` runs and `<file>.exit` holds `{"type":"done"}`
- **THEN** stdout is one JSON line with `reason` `done` and `sidecar` the absolute sidecar path, the exit code is 0, and the sidecar still exists

#### Scenario: Repeated wait
- **WHEN** the same sidecar wait runs twice
- **THEN** both runs print the same result

#### Scenario: Ping payload
- **WHEN** the sidecar is a `ping`
- **THEN** the printed JSON carries the ping's name and message

#### Scenario: Sidecar appears while polling
- **WHEN** the sidecar is written after the wait starts and before the timeout
- **THEN** the wait prints it and exits 0

#### Scenario: Malformed sidecar
- **WHEN** the sidecar holds text that is not JSON
- **THEN** the wait exits 0 and prints the `done` result, without a crash

### Requirement: Sidecar wait failures
When the timeout of a sidecar wait passes before the sidecar exists, `wait` SHALL print `{"sidecar":null}` on stdout and a timeout message on stderr, and exit 2. A missing `--session`, a bad `--timeout`, an unknown `--signal` value, or a `--status` flag given together with `--signal sidecar` SHALL be a usage error: a message on stderr, nothing on stdout, exit 1. The `--status` check SHALL test flag presence, not its resolved value.

#### Scenario: Timeout
- **WHEN** no sidecar appears before the timeout
- **THEN** stdout is `{"sidecar":null}`, stderr holds a timeout message, and the exit code is 2

#### Scenario: Usage error
- **WHEN** `wait --signal sidecar` runs without `--session`, or with `--signal fast`, or with an explicit `--status done`
- **THEN** the exit code is 1 and stdout is empty

#### Scenario: The default status does not count as given
- **WHEN** `wait --session <file> --signal sidecar` runs without `--status`
- **THEN** it is not a usage error, and it waits on the sidecar

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
