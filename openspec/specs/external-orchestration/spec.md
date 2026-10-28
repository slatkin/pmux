# external-orchestration Specification

## Purpose
Defines the contract that lets an orchestrator that is not a pi session, such as Claude Code, run pi subagents in tmux panes. It covers the packaged skill, how it launches children, how they report and close, and how they resume.

## Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged, failed or was cancelled by the user. It SHALL say that a `cancelled` sidecar means the user stopped the child with Escape: the child has exited, its pane closes, no report is coming, and no wake-up is sent. It SHALL say that a `wait --signal status` returns `done` on a cancel, and that the orchestrator must not resume or replace a cancelled child unless the user asks. The statement that there is no channel from the child back to the orchestrator, and the bullet that the report is the child's last assistant message, SHALL be scoped to the default `last` mode and SHALL point at the new section, so that neither reads as false in `send` mode. The shared recipes that assume a last-mode child SHALL say that they apply to `last` mode only: the idle-child nudge text in `SKILL.md`, the `wait` paragraph in `docs/guide.md`, and the external-orchestrator paragraph in `README.md`. `SKILL.md` SHALL have a section named "External orchestrators (Claude Code)" that documents the `send` mode: start with `--report send` and `--parent "$TMUX_PANE"`; the report is written to a durable file and a short pointer naming the file and its `ack` command is typed into the orchestrator's pane; the orchestrator reads the named file, runs the `ack` command in the pointer, and deduplicates repeated pointers by report ID; wait with `--signal sidecar`; leave the sidecar in place, because the wrapper reads it after the child exits, `start` and `resume` clear it on relaunch, and `prune` reclaims it; and `resume --launch <spec> --prompt <file>` appends the footer again. The section SHALL say that the run wrapper re-delivers each unacknowledged report of the run at the child's exit with the same report ID, that an acknowledgement means the report file was read, and that the orchestrator SHALL NOT edit or delete report files, `.sent` files or inbox entries. The section SHALL have a subsection named "Inbox monitor" that tells a Claude Code orchestrator to run `node <skill-dir>/launch.ts inbox --follow` once per session as a `Monitor` with `timeout_ms` 1800000 before it starts its first send-mode child, and again after a `--resume` or a `/clear` and whenever the `Monitor` reports that it expired; that each line the monitor prints is a report pointer to act on exactly as a typed pointer (read, `ack`, dedup by report ID, and a repeated line with a higher `delivery` count is the same report); that while the monitor runs no pointer is typed into the pane and no channel is used; and that without a running monitor the typed-pointer and channel fallbacks apply as before. The subsection SHALL show the `Monitor` call with `timeout_ms` 1800000 and SHALL say that a second `inbox --follow` on the same pane exits 1 because one is already running. The "Channel wake-up" subsection SHALL be retitled "Channel wake-up (legacy fallback)", SHALL open by saying that the inbox monitor supersedes it and that new setups SHALL NOT pass `--dangerously-load-development-channels` for pmux, and SHALL otherwise keep its content. The skill's frontmatter description SHALL say that the skill serves external orchestrators such as Claude Code. A recipe SHALL be stated once in `SKILL.md`: the follow-up `resume` recipe lives in "While it runs / after", and the "External orchestrators (Claude Code)" section points at it, keeping only the send-mode fact that `resume` re-appends the send footer.

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
- **THEN** it starts the child with `--report send --parent "$TMUX_PANE"`, ends its turn, and waits with `--signal sidecar` when it is woken

#### Scenario: The skill teaches the pointer workflow
- **WHEN** an external orchestrator reads the "External orchestrators (Claude Code)" section
- **THEN** it is told to read the report file the pointer names, to run the `ack` command the pointer carries after reading, to deduplicate repeated pointers by report ID, and not to edit or delete report files or `.sent` files

#### Scenario: The skill explains re-delivery
- **WHEN** an external orchestrator reads how the wrapper ends a send-mode run
- **THEN** the text says that every unacknowledged report of the run is re-delivered at exit with the same report ID, so a second pointer for an already-read report can be ignored

#### Scenario: The skill teaches the inbox monitor
- **WHEN** a Claude Code orchestrator reads the "Inbox monitor" subsection
- **THEN** it is told to run `node <skill-dir>/launch.ts inbox --follow` as a `Monitor` (`timeout_ms` 1800000, re-armed when it expires) before its first send-mode child and after a `--resume` or `/clear`, that each printed line is a pointer to read and `ack`, that a higher `delivery` count on a repeated line is the same report, and that the typed-pointer and channel fallbacks apply only when no monitor runs

#### Scenario: The channel is demoted
- **WHEN** a reader reads the channel subsection
- **THEN** its title says "legacy fallback", its first paragraph says the inbox monitor supersedes it, and it tells new setups not to pass `--dangerously-load-development-channels` for pmux

#### Scenario: The last-mode claims are scoped
- **WHEN** a reader reads the skill's intro, the "The report" bullet, or the idle-child nudge recipe
- **THEN** each says that it describes the default `last` mode, and the intro points at the "External orchestrators (Claude Code)" section

#### Scenario: The follow-up recipe is stated once
- **WHEN** a reader reads the "External orchestrators (Claude Code)" section and then "While it runs / after"
- **THEN** the `resume` command, the `<spec>` field and the "no launch record" rule appear once, in "While it runs / after", and the external-orchestrator section points at it and says that `resume` re-appends the send footer

#### Scenario: The skill explains a cancel
- **WHEN** a reader reads how to interpret `<session>.exit` after a wait
- **THEN** the text says that `{"type":"cancelled"}` means the user stopped the child, that the child has exited and its pane closes, that no wake-up is sent, and that the orchestrator must not resume or replace the child unless the user asks

### Requirement: Child extension lookup
The skill launcher SHALL find the package root, meaning a directory that holds `pi-extension/pmux/cli.ts` and `pmux-done.ts`, in this order: the `PI_PMUX_DIR` directory, then the checkout containing the launcher's resolved real path, then pi's git install of this package under the pi agent directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `git/github.com/slatkin/pmux`). Paths SHALL be built with the platform's path rules. The child SHALL be launched with `-e` on that root's `pmux-done.ts`. When no candidate holds the files, the launcher MUST exit non-zero, print an error naming the `pi install` command and the candidates searched, and create no pane.

#### Scenario: Dev override
- **WHEN** `PI_PMUX_DIR` points at a checkout containing `pi-extension/pmux/pmux-done.ts`
- **THEN** the child is launched with `-e` on that file

#### Scenario: Extension not installed
- **WHEN** no candidate location holds the extension
- **THEN** the launcher exits non-zero with an error naming `pi install`, and no pane is split

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

### Requirement: Launch contract
`start` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, without taking focus, and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `pmux-done.ts` reads (with `PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. It SHALL remove `<session>.status` before it runs that spec, and then run the spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr. Because every `start` is an external-orchestrator launch, it SHALL set `PI_PMUX_EXTERNAL_PARENT=1` in the launch spec env; a pi-parent launch does not set that key. A `resume` rebuilds the launch spec from the launch record with the same external parent, so the resumed child carries the marker too. A `send`-mode spec SHALL also carry `PI_PMUX_REPORT_PROTOCOL` with the value `file-ack-v1`, which selects the file, pointer and acknowledgement protocol in `send` and in the run wrapper; a `last`-mode spec and a pi-parent launch SHALL NOT set it.

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

#### Scenario: The launch spec carries the report protocol marker
- **WHEN** `start` runs with `--report send` and the orchestrator reads the launch spec it wrote
- **THEN** the spec env holds `PI_PMUX_REPORT_PROTOCOL` with the value `file-ack-v1`

#### Scenario: A last-mode spec carries no protocol marker
- **WHEN** `start` runs without `--report`
- **THEN** the spec env has no `PI_PMUX_REPORT_PROTOCOL`

#### Scenario: A resume keeps the marker
- **WHEN** a child started with `start` is resumed with `resume --launch <spec>`
- **THEN** the resumed child's environment also carries `PI_PMUX_EXTERNAL_PARENT=1`

#### Scenario: A pi-parent child does not carry the marker
- **WHEN** a pi parent spawns a child with `pmux_spawn`
- **THEN** the child's env has no `PI_PMUX_EXTERNAL_PARENT`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief. In `last` mode the footer SHALL give the parent's name and pane, tell the child that its last assistant message is the report the parent reads and that it SHALL then call `pmux_done`, and tell the child not to use `caller_ping` or `pmux_message` to reach the parent. In `send` mode the footer SHALL name the parent's pane, and SHALL teach `node <cli> send --to <parent pane> --text '<report>'`, where `<cli>` is the absolute path of the package's `cli.ts`, as the report step, followed by a call to `pmux_done`. The send footer SHALL say that `send` writes the report to a durable file and types only a pointer naming it, that the confirmation line's `sent:true` means the pointer was submitted to the parent's pane and `acknowledged:true` means the parent read the report file, and that the line is not a delivery receipt. It SHALL tell the child that `acknowledged:false` means the parent is busy, that the child SHALL NOT resend the report or send anything else to check, because the run wrapper re-delivers an unacknowledged report at exit, and that on `sent:false` it SHALL call `pmux_done` without improvising retries. It SHALL tell a blocked child to send its question with the same command and stop. It SHALL tell the child to ignore a reminder's claim that its last message was already delivered, and to send its report first. It SHALL NOT say that a missing report leaves the parent unaware of the exit, because the send-mode wake-up reports the exit state. Its statement about the session closing when a turn ends SHALL be conditional, because a role without `auto-exit: true` keeps its session open and gets the completion nudge. The `send` footer MUST NOT say that the last assistant message is delivered or read as the report. Both footers SHALL give the same report shape: at most 15 lines; the verdict first, then the commit SHA; one line for each verification check, PASS or FAIL, without command output; one line for each deviation and each open question. Both footers MUST NOT ask for the list of changed files, and SHALL say that the parent gets the changed files from the commit SHA. Both footers SHALL tell the child that it MAY put longer details in a file and name that file's path in the report, and that a report format in the brief overrides the footer's report shape and line limit. Each footer SHALL carry every rule it needs exactly once: a rule the footer states SHALL NOT be stated again in the same footer, and a rule the child's tool schema already states MAY be left out of it.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12` in `last` mode
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

#### Scenario: Send footer teaches the command
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the prompt ends with a footer that holds `node <cli> send --to %12 --text`, names `pmux_done`, tells a blocked child to send its question and stop, and does not say that the last assistant message is the report

#### Scenario: Send footer names the confirmation
- **WHEN** a send-mode child reads its footer
- **THEN** the footer names the confirmation line the `send` command prints, says `sent:true` means the pointer was submitted and `acknowledged:true` means the parent read the report file, says the line is not a delivery receipt, and tells the child not to send anything else to the parent to check

#### Scenario: Send footer forbids retrying
- **WHEN** a send-mode child reads its footer
- **THEN** the footer says `acknowledged:false` means the parent is busy, forbids resending or sending a check message, says the wrapper re-delivers at exit, and says `sent:false` means call `pmux_done`

#### Scenario: Send footer overrides the nudge
- **WHEN** a send-mode child reads its footer
- **THEN** the footer tells it to ignore a reminder's claim that its last message was already delivered, and to send its report before it calls `pmux_done`

#### Scenario: The footer states each rule once
- **WHEN** a reader reads either footer
- **THEN** the rule about the report, the rule about `pmux_done`, the rule about a blocked child, the rule about the reminder and the report-shape rule each appear once in it

#### Scenario: Both footers bound the report
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer sets a limit of 15 lines, puts the verdict first and the commit SHA next, and asks for one PASS or FAIL line for each verification check, without command output, and one line for each deviation and each open question

#### Scenario: Footers do not ask for changed files
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer does not ask for the files changed, and says that the parent gets them from the commit SHA

#### Scenario: Details go in a named file
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer says that the child may put longer details in a file and name that file's path in the report

#### Scenario: The brief's report format wins
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer says that a report format in the brief overrides the footer's report shape and line limit

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done`, `handoff` or `cancelled`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. In `last` mode the wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane; the orchestrator's wake is the `wait` command, which polls the status file, and the report is the child's last assistant message, read with `last-message`. In `send` mode the wrapper SHALL contact the parent only through the send-mode report re-delivery and the send-mode wake-up, and SHALL NOT address any pane by title.

#### Scenario: Clean completion
- **WHEN** the child calls `pmux_done` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"done"}`

#### Scenario: Handoff completion
- **WHEN** the child calls `pmux_done` with a `handoff` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds the `handoff` sidecar

#### Scenario: External wait observes done before close
- **WHEN** an orchestrator is blocked in `wait --session <file> --status done,blocked` and the child completes with `pmux_done` under the default grace period
- **THEN** the wait exits 0 before the pane closes

#### Scenario: User cancel
- **WHEN** the user presses Escape in the child's pane and pi exits after writing the `cancelled` sidecar
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"cancelled"}`

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
- **WHEN** `<session>.exit` holds text that is not JSON, or JSON whose `type` is not `done`, `handoff` or `cancelled`
- **THEN** the pane stays open

#### Scenario: The wrapper contacts nobody
- **WHEN** a last-mode skill-launched child exits and the wrapper prints `__SUBAGENT_DONE_<code>__`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

#### Scenario: Send mode wakes before it closes
- **WHEN** a send-mode child exits with a `done` sidecar and nothing was delivered to its parent
- **THEN** the wrapper sends the send-mode parent contact to the parent's pane, and then closes its own pane after the grace

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
`SKILL.md` SHALL tell the orchestrator that a child can end with `{"type":"handoff","message":...}` in `<session>.exit`, which `wait --signal sidecar` reports with the reason `handoff` and the handoff message. It SHALL say that the task is not complete, that the handoff text is in the sidecar, that the pane closes itself after the close grace as for `done`, and that the orchestrator continues the task with a new child through `start`, with the handoff text in the brief.

#### Scenario: Orchestrator reads a handoff
- **WHEN** an orchestrator follows `SKILL.md` and finds a `handoff` sidecar
- **THEN** the skill tells it to start a new child with the handoff text in its brief, not to resume the old session

#### Scenario: Pane gone after the grace
- **WHEN** the wait on a child's status ends and no pane is left after the close grace
- **THEN** the skill tells the orchestrator to run `wait --session <file> --signal sidecar`, where `done` means finished and `handoff` means continue with a new child

### Requirement: tmux is required for launch

`start` and `resume` SHALL refuse to run unless `TMUX` and `TMUX_PANE` are both set. They SHALL call tmux only through the `tmux` binary, with the caller's pane id taken from `TMUX_PANE`.

#### Scenario: Run outside tmux
- **WHEN** `start` runs with `TMUX_PANE` unset
- **THEN** it exits non-zero with an error saying it must run inside a tmux pane, and creates nothing

### Requirement: The skill waits through the CLI
`SKILL.md` SHALL tell the orchestrator to wait for a child with the CLI `wait` command, run through the launcher. For the `last` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --status done,blocked --timeout <seconds>`, then `node <skill-dir>/launch.ts wait --session <file> --signal sidecar` to read the exit, and tell the orchestrator to read the report with `last-message --session <file>`. For the `send` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --signal sidecar [--timeout <seconds>]` and tell the orchestrator to act on the printed reason. In both modes the orchestrator SHALL read the exit only through `wait --signal sidecar`: `SKILL.md` SHALL NOT tell it to read `<session>.exit` directly, or to delete, move or write that file. It SHALL NOT document a multiplexer command for the wait or for reading a report.

#### Scenario: The orchestrator waits for a child
- **WHEN** the orchestrator follows `SKILL.md` and waits for a last-mode child
- **THEN** it runs the CLI `wait` command with the child's session file and the `done,blocked` statuses, and then runs `wait --signal sidecar` to read the exit

#### Scenario: The orchestrator reads the report
- **WHEN** the wait returns `done` for a last-mode child
- **THEN** the skill tells the orchestrator to run `last-message --session <file>` for the report

#### Scenario: The orchestrator waits on the sidecar
- **WHEN** the orchestrator follows the send-mode section and is woken by a report
- **THEN** it runs `wait --session <file> --signal sidecar`, reads the printed reason, and leaves the sidecar in place

#### Scenario: No recipe touches the sidecar file
- **WHEN** a reader reads every recipe in `SKILL.md` that handles a child's exit
- **THEN** no recipe reads `<session>.exit` directly, and none tells the orchestrator to `rm` it

### Requirement: No surface flag
`start` and `resume` SHALL NOT accept a `--surface` flag. An invocation that carries the flag MUST fail before a pane is created. A launch's surface SHALL come from the role's `surface:` frontmatter when it names `pane`, `tab` or `float`, and from the configured default otherwise.

#### Scenario: Flag is rejected
- **WHEN** `start` runs with `--surface float`
- **THEN** it exits non-zero with an unknown-argument error, and no pane is created

#### Scenario: Role decides without a flag
- **WHEN** `start` runs for a role with no `surface:` and the `config.json` default is `tab`
- **THEN** the child opens in its own tmux window

### Requirement: Report mode selection
`start` SHALL accept `--report last|send`, with `last` as the default. In `last` mode the report is the child's last assistant message, as before. In `send` mode the child reports through the `file-ack-v1` protocol: the report goes to a durable file and a pointer is typed into the parent's pane by `send`, and `--parent` SHALL be the orchestrator's tmux pane id. Any other value MUST make `start` exit 2 with a stderr message naming the value, before any file is written or any pane is split.

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
The CLI SHALL provide `send --to <pane> --text <text> [--ack-timeout <seconds>]`. Its behaviour is selected by `PI_PMUX_REPORT_PROTOCOL` in the environment.

When the variable is absent or holds a value other than `file-ack-v1`, `send` SHALL keep the legacy behaviour: it types the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell, and prints `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path or null>}`.

When the variable holds `file-ack-v1`, `PI_PMUX_SESSION` SHALL be required: a marked invocation without it is a configuration error, not a legacy fallback. `send` SHALL then, in order:

1. Mint a fresh report ID of 32 lowercase hex characters, write the received text unchanged to `<session>.<id>.report.md` through an atomic temporary-file-and-rename write, and append the `report` registration record to `<session>.sent`. A failure here refuses the send before any inbox entry, before any pane input and before any channel request.
2. Build the one-line pointer `pmux report <id>. Read <shell-quoted-report-path>, then run: node <shell-quoted-cli> ack --session <shell-quoted-session> --id <id>. Acknowledge only after reading. [pmux-eom-<token>]` with a fresh 32-hex visibility token, and submit it through the report transport (`report-channel`): the parent's report inbox first (`report-inbox`: an entry write, when the inbox has a live monitor), then, when the inbox is unavailable, the parent's channel endpoint, then, when the channel is unavailable, the tmux backend's verified report-input primitive. A refusal or a failed submission on the final fallback SHALL exit 2 with the structured failure line.
3. On submission by any transport, append the `notification` record (best effort) and poll the event log every 250 ms for an `ack` of the same ID, for `--ack-timeout` seconds (default 15; `0` checks once without waiting; the flag is invalid in legacy mode).
4. Print the result line and exit 0: `{"sent":true,"notification":"submitted","via":"inbox"|"channel"|"tmux","acknowledged":<bool>,"id":<id>,"to":<pane>,"bytes":<n>,"report":<abs path>,"receipt":<abs path or null>,"notificationRecorded":<bool>}`, plus `"inboxError":<reason>` when `via` is not `inbox`, and `"channelError":<reason>` when `via` is `tmux`. `acknowledged:false` after the timeout is not a failure and MUST NOT be presented as one.

A pane refusal or verification failure on the final fallback SHALL exit 2, print an operational error on stderr, and print the structured line `{"sent":false,"notification":"not-submitted"|"unknown","acknowledged":false,"id":<id>,"to":<pane>,"bytes":<n>,"report":<abs path>,"receipt":<abs path or null>,"notificationRecorded":false,"error":<reason>,"enterAttempted":<bool>,"inboxError":<reason>,"channelError":<reason>}` on stdout. A missing `--to` or `--text` MUST be a usage error: a message on stderr naming the flag, nothing on stdout, exit 1, and nothing is sent and no file is written.

In both modes the typed text SHALL be encoded so that it holds no line terminator and no tab, by the same encoding rules as before.

#### Scenario: Report delivered
- **WHEN** a child without `PI_PMUX_REPORT_PROTOCOL` runs `send --to %12 --text 'PASS abc123'`
- **THEN** tmux receives `send-keys -t %12 -l 'PASS abc123'` and then `send-keys -t %12 Enter`, and stdout is the legacy line

#### Scenario: Artifact before pane input
- **WHEN** a marked child runs `send --to %12 --text 'PASS abc123'`, the inbox of `%12` is unmonitored and `%12` has no channel endpoint
- **THEN** `<session>.<id>.report.md` holding `PASS abc123` and its `report` record exist before any tmux call, and the typed input is the pointer line ending in `pmux-eom-<token>`

#### Scenario: Artifact before the inbox entry
- **WHEN** a marked child runs `send` and the inbox of `%12` has a live monitor
- **THEN** the report file and its `report` record exist before the inbox entry is written

#### Scenario: Artifact before the channel request
- **WHEN** a marked child runs `send`, the inbox of `%12` is unmonitored and `%12` has an armed channel endpoint
- **THEN** the report file and its `report` record exist before the endpoint receives the request

#### Scenario: Report delivered by the inbox
- **WHEN** a marked child runs `send --to %12` and the inbox of `%12` has a live monitor
- **THEN** the inbox gains `<id>.json`, no endpoint connection is attempted, tmux receives no `send-keys` call, and the result line has `sent:true`, `notification:"submitted"` and `via:"inbox"`, and no `inboxError` and no `channelError`

#### Scenario: Report delivered by the channel
- **WHEN** a marked child runs `send --to %12`, the inbox of `%12` is unmonitored and the endpoint of `%12` replies `emitted`
- **THEN** tmux receives no `send-keys` call, and the result line has `sent:true`, `notification:"submitted"`, `via:"channel"` and `inboxError:"unmonitored"`, and no `channelError`

#### Scenario: Report delivered by the fallback
- **WHEN** a marked child runs `send --to %12`, the inbox of `%12` is unmonitored, the endpoint replies `unarmed`, and the verified input submits the pointer
- **THEN** the result line has `via:"tmux"`, `inboxError:"unmonitored"` and `channelError:"unarmed"`, and the exit code is 0

#### Scenario: Acknowledged report
- **WHEN** a marked child runs `send` and `ack` runs for its ID within the timeout
- **THEN** the result line has `sent:true`, `notification:"submitted"` and `acknowledged:true`, and the exit code is 0

#### Scenario: Unacknowledged timeout
- **WHEN** a marked child runs `send` and no ack arrives within `--ack-timeout`
- **THEN** the result line has `sent:true` and `acknowledged:false`, stderr is empty, and the exit code is 0

#### Scenario: Ack timeout zero
- **WHEN** a marked child runs `send --ack-timeout 0` with no ack present
- **THEN** it checks the log once, does not sleep, and exits 0 with `acknowledged:false`

#### Scenario: Submission refused
- **WHEN** the inbox and the channel are unavailable and the parent pane refuses the verified input when a marked child runs `send`
- **THEN** no keys are typed, the exit code is 2, and the stdout line has `sent:false`, `notification:"not-submitted"`, `enterAttempted:false`, an `inboxError`, a `channelError`, and a `report` path that exists

#### Scenario: Enter failed
- **WHEN** the inbox and the channel are unavailable and the Enter call throws after the token was verified
- **THEN** the exit code is 2 and the stdout line has `notification:"unknown"` and `enterAttempted:true`

#### Scenario: Marked without a session
- **WHEN** `send` runs with `PI_PMUX_REPORT_PROTOCOL=file-ack-v1` and no `PI_PMUX_SESSION`
- **THEN** it exits 1 with a message on stderr naming `PI_PMUX_SESSION`, sends nothing, writes no inbox entry, makes no channel request and writes no `.report.md` file

#### Scenario: Multiline report
- **WHEN** the text holds several lines
- **THEN** the report file holds them unchanged, and the pointer, typed, sent to the channel or printed by the inbox follower, remains one line

#### Scenario: Control characters
- **WHEN** an unmarked `send` text holds a tab or another control character
- **THEN** the typed text holds `\t` or `\xNN` in its place, and no tab and no control byte is typed

#### Scenario: Missing flag
- **WHEN** `send` runs without `--text`
- **THEN** it exits 1 with an error naming `--text` on stderr, stdout is empty, and tmux receives no call

#### Scenario: Legacy timeout flag rejected
- **WHEN** an unmarked invocation carries `--ack-timeout`
- **THEN** it is a usage error: exit 1, stderr message, no pane input

#### Scenario: The command answers
- **WHEN** `send --to %12 --text 'PASS abc123'` delivers under `file-ack-v1`
- **THEN** stdout holds one JSON line whose `sent` is `true`, whose `to`, `bytes`, `id`, `via`, `report` and `receipt` are set

#### Scenario: The confirmation names the receipt
- **WHEN** an unmarked `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl` and the receipt is written
- **THEN** the printed line's `receipt` is the absolute path of `/s/w.jsonl.sent`

#### Scenario: No receipt to name
- **WHEN** an unmarked `send --to %12 --text hi` runs without `PI_PMUX_SESSION`, or the receipt cannot be written
- **THEN** the printed line's `receipt` is null, and the command still exits 0

### Requirement: Report receipts
When `send` runs under `file-ack-v1`, `<PI_PMUX_SESSION>.sent` SHALL be an append-only JSON-lines event log. `send` SHALL append a `report` record `{"at":<ISO>,"kind":"report","id":<32hex>,"to":<pane>,"bytes":<n>,"report":<path>}` before transport — a failed registration refuses the send — and a `notification` record `{"at":<ISO>,"kind":"notification","id":<32hex>,"token":<32hex>,"to":<pane>,"bytes":<n>,"report":<path>,"via":"inbox"|"channel"|"tmux"}` after a submission, plus `"inboxError":<reason>` when `via` is not `inbox` and `"channelError":<reason>` when `via` is `tmux` — a failed notification write MUST NOT fail the send. `ack` SHALL append `{"at":<ISO>,"kind":"ack","id":<32hex>}`; a failed append MUST NOT produce a success result. Readers SHALL skip malformed lines and unknown kinds, SHALL treat a `notification` record without `via` as `via:"tmux"`, SHALL treat a kindless line with a string `to` as a legacy notification with no ID and no ack semantics, and an `ack` record carries no `to`. `<bytes>` is the UTF-8 length of the text `send` received. When `send` runs unmarked it SHALL keep appending the kindless receipt line `{"at":<ISO>,"to":<to>,"bytes":<n>}`. `prune` SHALL treat `.sent` and `.report.md` files as launcher files, so it deletes them past the retention and keeps them within it; an abandoned atomic temporary file also ends in `.report.md` and is reclaimed by the same rule.

#### Scenario: Receipt inside a child
- **WHEN** an unmarked `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains one kindless line whose JSON has `to` equal to `%12`, `bytes` equal to `2` UTF-8 bytes and an ISO `at`

#### Scenario: Registration before notification
- **WHEN** a marked child runs `send` with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains a `report` line for the ID before the pointer is submitted, and a `notification` line with a `token` and a `via` after submission

#### Scenario: Inbox notification record
- **WHEN** the inbox entry is written for the pointer
- **THEN** the `notification` line has `via:"inbox"`, no `inboxError` and no `channelError`

#### Scenario: Channel notification record
- **WHEN** the inbox result is `unavailable` with reason `unmonitored` and the channel emits the pointer
- **THEN** the `notification` line has `via:"channel"` and `inboxError:"unmonitored"`, and no `channelError`

#### Scenario: Fallback notification record
- **WHEN** the inbox result is `unavailable` with reason `unmonitored`, the channel result is `unavailable` with reason `refused` and the verified input submits the pointer
- **THEN** the `notification` line has `via:"tmux"`, `inboxError:"unmonitored"` and `channelError:"refused"`

#### Scenario: Old notification record
- **WHEN** the event log holds a `notification` record written before this change, with no `via`
- **THEN** readers see it as a notification with `via:"tmux"`

#### Scenario: Ack record
- **WHEN** `ack --session /s/w.jsonl --id <id>` runs for a registered report
- **THEN** `/s/w.jsonl.sent` gains an `ack` line naming the ID and no `to`

#### Scenario: Receipt counts the text as received
- **WHEN** an unmarked `send --to %12 --text 'line one\nline two'` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** the receipt's `bytes` counts the newline in the text, not the encoded form that was typed

#### Scenario: No receipt outside a child
- **WHEN** an unmarked `send` runs without `PI_PMUX_SESSION`
- **THEN** no `.sent` file is written

#### Scenario: Malformed lines are skipped
- **WHEN** the event log holds a line that is not JSON and a JSON line with an unknown `kind`
- **THEN** readers ignore both and still see the valid records

#### Scenario: Registration failure refuses the send
- **WHEN** the `report` record cannot be appended under `file-ack-v1`
- **THEN** `send` exits without a channel request and without typing into the pane

#### Scenario: Receipt write fails
- **WHEN** `<session>.sent` cannot be appended under the legacy protocol
- **THEN** `send` still delivers the text and exits 0

#### Scenario: Notification write fails
- **WHEN** the `notification` record cannot be appended after a submission
- **THEN** `send` still exits 0 with `notificationRecorded:false`

#### Scenario: Prune reclaims receipts
- **WHEN** `prune` runs on a scratch directory holding `.sent`, `.report.md` and abandoned `.tmp-*.report.md` files older than the retention and within it
- **THEN** the old ones are deleted and the fresh ones are kept

### Requirement: Send-mode report count
For a send-mode spec with a `parent`, the run wrapper SHALL detect whether the current run produced parent reports. For an unmarked spec it SHALL count the `<session>.sent` kindless lines whose `to` equals `parent`, once before the child starts and once after the sentinel; a missing file counts as zero and an unparseable line is skipped. For a `file-ack-v1` spec it SHALL snapshot the registered report IDs and the kindless-line count before the child starts, and after the sentinel examine only `report` records whose `to` equals `parent` and whose IDs were absent from the baseline, together with their `ack` records. A report with a matching `ack` is consumed; one without is unacknowledged and subject to re-delivery. A new kindless line whose `to` equals `parent` counts as parent contact for the wake decision — an unmarked `send` still ran against the session — but, having no report ID, it is never re-delivered. In `last` mode the wrapper SHALL NOT check and SHALL NOT contact anyone.

#### Scenario: Count grows
- **WHEN** an unmarked send-mode child with parent `%12` runs `send --to %12` once and exits
- **THEN** the second count is one more than the first, and no wake-up is sent

#### Scenario: Acked report is consumed
- **WHEN** a marked child's only new report to the parent has an `ack` record
- **THEN** the wrapper neither re-delivers it nor sends the no-report wake-up

#### Scenario: Unacknowledged report
- **WHEN** a marked child's report to the parent has no `ack` record
- **THEN** the wrapper re-delivers it by the Send-mode wake-up rules

#### Scenario: Earlier marked runs do not count
- **WHEN** a resumed marked child exits and `.sent` holds report and ack records from the earlier run
- **THEN** only the current run's reports are examined

### Requirement: Send-mode wake-up
For a send-mode spec with a `parent`, the wrapper SHALL contact the parent after the sentinel and before the close-on-done step. For an unmarked spec the legacy behaviour applies: one text message typed through the pane-input primitive, encoded the way `send` encodes its text — `<name> pinged: <message>` for a `ping` sidecar with a string message, else `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`.

For a `file-ack-v1` spec:

- Every current-run report addressed to `parent` that has no `ack` record SHALL be re-delivered in registration order through the report transport (`report-channel`: the parent's inbox first, then the channel endpoint, then the verified report-input primitive): the same report file and ID, a fresh visibility token, and no ack wait. Through the inbox a re-delivery rewrites the existing entry with its `delivery` count incremented. The wrapper SHALL recheck the ack immediately before each retry.
- When there is no current-run parent report at all, the wrapper SHALL write the wake text to its own durable report file, register it with a `report` record as `send` does, and deliver its pointer the same way: the `<name> <state> without sending a report…` text above for a finished or crashed child, and `<name> pinged: <message>` for a `ping` sidecar, with the original multiline text unchanged.
- A `cancelled` sidecar produces no re-delivery and no wake-up.
- A failed re-delivery or wake-up SHALL go to stderr only and MUST NOT change the child's exit code.

#### Scenario: Exit without a report
- **WHEN** an unmarked send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

#### Scenario: Failed wake-up
- **WHEN** a re-delivery or wake-up can be submitted neither to the inbox, nor to the channel, nor to the parent's pane
- **THEN** the wrapper writes an error naming the parent to stderr, and its exit code is the child's code

#### Scenario: Ping is quoted
- **WHEN** an unmarked send-mode child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no receipt
- **THEN** the parent receives `<name> pinged: Which DB?`

#### Scenario: A ping question that spans lines
- **WHEN** an unmarked send-mode child exits with a ping sidecar whose message holds a line break, and no receipt
- **THEN** the parent receives one message, with the line break written as the two characters `\n`

#### Scenario: The name is the launch spec's name
- **WHEN** a send-mode child launched as `worker-a` exits and its own sidecar names `w`
- **THEN** the parent-facing text names `worker-a`

#### Scenario: Crash without a report
- **WHEN** an unmarked send-mode child exits with code 2, wrote no sidecar, left no terminal status, and wrote no receipt
- **THEN** the wrapper writes its `error` sidecar, and the parent receives a message with the state `error` and the `last-message` command

#### Scenario: Crash after a terminal status
- **WHEN** an unmarked send-mode child exits with code 2, wrote no sidecar, left a `done` status, and wrote no receipt
- **THEN** the wrapper writes no `error` sidecar, and the parent receives a message with the state `crashed (code 2)` and the `last-message` command

#### Scenario: Report suppresses the wake-up
- **WHEN** an unmarked send-mode child sends its report to its parent and exits
- **THEN** the parent receives no message from the wrapper

#### Scenario: Report to another pane
- **WHEN** the only current-run reports name a pane that is not the parent
- **THEN** they are neither re-delivered nor counted for this parent, and the no-report wake-up applies

#### Scenario: Malformed receipt line
- **WHEN** the only new line in `<session>.sent` is not JSON
- **THEN** the parent is still woken

#### Scenario: Earlier runs do not count
- **WHEN** a resumed unmarked send-mode child exits without a report, and `<session>.sent` holds receipts to the parent from the earlier run
- **THEN** the parent is woken

#### Scenario: Unacknowledged report is re-delivered
- **WHEN** a marked send-mode child exits with a `done` sidecar, its report to the parent has no ack, and the parent's inbox is unmonitored
- **THEN** the parent's pane receives a new pointer naming the same report ID and file, with a fresh token

#### Scenario: Re-delivery through the inbox
- **WHEN** a marked send-mode child exits with one unacknowledged report and the parent's inbox has a live monitor marker
- **THEN** the report's inbox entry is rewritten with `delivery:2`, no endpoint connection is attempted, and tmux receives no `send-keys` call for it

#### Scenario: Acked report is not re-delivered
- **WHEN** the report has an `ack` record
- **THEN** no pointer is typed for it at exit

#### Scenario: Ack raced the retry
- **WHEN** the ack lands after the sentinel but before a pending retry
- **THEN** the recheck sees it and that report is skipped

#### Scenario: No-report wake is durable
- **WHEN** a marked send-mode child exits with a `done` sidecar and no current-run report
- **THEN** a durable artifact holding the wake text is written and its pointer is delivered to the parent's pane

#### Scenario: No-report wake through the inbox
- **WHEN** a marked send-mode child exits with a `done` sidecar and no current-run report, and the parent's inbox has a live monitor marker
- **THEN** the wake artifact's entry appears in the inbox with the wrapper's report ID, and the parent pane receives no typed input

#### Scenario: Ping is durable
- **WHEN** a marked child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no current-run report
- **THEN** the artifact holds `<launch-name> pinged: Which DB?` and the parent's pane receives its pointer

#### Scenario: Cancelled stays quiet
- **WHEN** a marked child exits with a `cancelled` sidecar and unacknowledged reports
- **THEN** no pointer is typed into the parent's pane

#### Scenario: A cancel sends no wake-up
- **WHEN** a send-mode child with parent `%12` exits with a `cancelled` sidecar and wrote no receipt
- **THEN** `%12` receives nothing

#### Scenario: Last mode stays silent
- **WHEN** a last-mode child exits without a report
- **THEN** no text is typed into any pane but the child's own

#### Scenario: Re-delivery by the channel
- **WHEN** a marked send-mode child with parent `%12` exits with one unacknowledged report, the inbox of `%12` is unmonitored, and the endpoint of `%12` replies `emitted`
- **THEN** the pointer reaches the endpoint with the same report ID and a fresh token, and tmux receives no `send-keys` call for it

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
If no valid launch record exists beside the spec's session file, `resume` SHALL refuse the launch spec. It SHALL print a message on stderr that tells the caller to run `start` again, print nothing on stdout, exit 1 and split no pane. A launch spec that has a valid record but no parent SHALL also be refused: `resume` SHALL print a message on stderr that names `pmux_resume`, print nothing on stdout, exit 1 and split no pane, because the external parent-contact needs a parent and every launch spec `start` writes carries one.

#### Scenario: Spec from an older version
- **WHEN** `resume` is given a launch spec whose session file has no `.launch.json`
- **THEN** it exits 1 with a message that names `start`, and no pane is created

### Requirement: Every command answers on success
Every CLI command SHALL print at least one line on stdout when it succeeds, so an agent that ran it can read the result. A command that succeeds silently MUST NOT be added: an agent that cannot read a result either guesses at it or probes the host with another command. A usage error SHALL print its message on stderr, print nothing on stdout and exit non-zero.

#### Scenario: The commands answer
- **WHEN** `start`, `resume`, `send`, `ack`, `wait`, `prune` or `last-message` succeeds
- **THEN** it printed at least one line on stdout

#### Scenario: A usage error stays on stderr
- **WHEN** any of those commands runs with a missing or unusable flag
- **THEN** it printed a message on stderr, printed nothing on stdout and exited non-zero

### Requirement: Acknowledge a report
The CLI SHALL provide `ack --session <file> --id <report-id>` for the `file-ack-v1` report protocol. The ID SHALL match `^[0-9a-f]{32}$` and its report file `<session>.<id>.report.md` SHALL exist. `ack` SHALL append `{"at":<ISO>,"kind":"ack","id":<id>}` to `<session>.sent`, print `{"acked":true,"alreadyAcknowledged":<bool>,"id":<id>,"session":<abs path>,"receipt":<abs path>}` and exit 0; it MUST NOT claim success when the append fails.

#### Scenario: First ack
- **WHEN** `ack` runs for a registered report with no prior ack
- **THEN** the event log gains the `ack` record and stdout prints `acked:true` with `alreadyAcknowledged:false`

#### Scenario: Repeat ack
- **WHEN** `ack` runs again for the same ID
- **THEN** nothing is appended and stdout prints `acked:true` with `alreadyAcknowledged:true`

#### Scenario: Missing artifact
- **WHEN** the report file for the ID does not exist
- **THEN** `ack` exits 2, appends nothing and prints no `acked:true`

#### Scenario: Malformed ID
- **WHEN** `ack` runs with `--id hello`
- **THEN** it exits 1 with an error naming `--id`, stdout is empty and nothing is appended

#### Scenario: Append failure
- **WHEN** `<session>.sent` cannot be appended
- **THEN** `ack` exits 2 and does not claim success

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
