# report-inbox Specification

## Purpose

The per-parent report inbox: a directory an orchestrator pane owns, where pmux drops one durable entry per report it owes that pane, and the `inbox` command that follows it so a Claude Code `Monitor` can wake the orchestrator through the harness instead of through its terminal or an MCP channel.

## Requirements

### Requirement: Inbox path
pmux SHALL derive the inbox of a parent pane from the tmux socket path (the first comma field of `TMUX`) and the target pane id. The directory is `$XDG_RUNTIME_DIR/pmux-inbox/<h>-<n>`, or `/tmp/pmux-inbox-<uid>/<h>-<n>` when `XDG_RUNTIME_DIR` is unset or empty, where `<h>` is the 16-digit lowercase hex FNV-1a 64-bit hash of the socket path bytes and `<n>` is the pane id without its `%`; the same hash the channel endpoint path uses. A writer SHALL create the directory with owner-only permissions when it is missing. When `TMUX` is unset or empty, no inbox exists.

#### Scenario: Shared test vector
- **WHEN** `TMUX` is `/tmp/tmux-1000/default,1,0`, the target pane is `%12` and `XDG_RUNTIME_DIR` is `/run/user/1000`
- **THEN** the inbox is `/run/user/1000/pmux-inbox/79301cf9592f327a-12`

#### Scenario: No runtime dir
- **WHEN** `XDG_RUNTIME_DIR` is unset and the uid is 1000
- **THEN** the inbox is under `/tmp/pmux-inbox-1000`

#### Scenario: The target pane, not the caller's pane
- **WHEN** a child in pane `%30` sends to parent `%12`
- **THEN** the inbox names `12`, not `30`

#### Scenario: No tmux socket
- **WHEN** `TMUX` is unset or empty
- **THEN** no inbox path exists, no entry is written, and the inbox transport is unavailable

### Requirement: Inbox entry
An inbox entry SHALL be one file `<id>.json` named by the report ID (32 lowercase hex characters), written atomically through a temporary-file-and-rename, holding `{"v":1,"id":<id>,"from":<child launch name>,"session":<abs session path>,"report":<abs report path>,"cli":<abs cli path>,"at":<ISO>,"delivery":<n>}`. `delivery` is `1` when the entry is first written and SHALL be incremented by each re-delivery, which rewrites the whole file under the same name. The entry's `report` path SHALL be the same `<session>.<id>.report.md` the `report` registration names, so the entry adds no second copy of the report text.

#### Scenario: Entry names the report
- **WHEN** a marked child `worker-a` with session `/s/w.jsonl` registers report `<id>` to parent `%12`
- **THEN** `<inbox of %12>/<id>.json` exists with `from:"worker-a"`, `report:"/s/w.jsonl.<id>.report.md"`, `delivery:1` and an absolute `cli`

#### Scenario: Re-delivery rewrites the entry
- **WHEN** the run wrapper re-delivers report `<id>` at the child's exit
- **THEN** the entry keeps its name, its `delivery` is `2`, and no second file is created for the same ID

#### Scenario: Atomic write
- **WHEN** a reader lists the inbox while an entry is being written
- **THEN** it sees either no file for that ID or a complete JSON file, never a partial one

### Requirement: Entry lifecycle
`send` and the run wrapper SHALL write an inbox entry only after the `report` registration record exists. `ack` SHALL remove the entry for the acknowledged ID after it has appended the `ack` record; an entry whose ID already has an `ack` record SHALL be treated as retired and removed by the next reader that sees it. A missing entry on `ack` is not an error. `prune` SHALL delete entries past the launcher-file retention and keep entries within it, and SHALL remove an inbox directory that holds no entry and no live marker.

#### Scenario: Registration before the entry
- **WHEN** a marked `send` runs and the `report` record cannot be appended
- **THEN** no inbox entry is written

#### Scenario: Ack retires the entry
- **WHEN** `ack --session /s/w.jsonl --id <id>` succeeds
- **THEN** `/s/w.jsonl.sent` has the `ack` record and `<inbox>/<id>.json` no longer exists

#### Scenario: Ack of a missing entry
- **WHEN** `ack` runs for a report whose entry was never written or already removed
- **THEN** `ack` appends its record and exits 0 as it does today

#### Scenario: Acked entry seen by a reader
- **WHEN** the inbox holds `<id>.json` and `<session>.sent` already holds an `ack` for `<id>`
- **THEN** the reader does not print the entry and removes it

#### Scenario: Prune reclaims entries
- **WHEN** `prune` runs and an inbox holds an entry older than the retention and one within it
- **THEN** the old entry is deleted and the fresh one is kept

### Requirement: Live-monitor marker
An inbox SHALL carry at most one marker file `.monitor` holding `{"v":1,"pid":<n>,"at":<ISO>}`, written by the `inbox --follow` command when it starts and removed when it exits normally. A marker is live when the process it names is alive; a writer SHALL treat a marker whose process is gone, or a malformed marker, as absent. A second `inbox --follow` on the same inbox SHALL replace a dead marker and SHALL refuse to start, exiting 1 with a message naming the live pid, when the marker is live.

#### Scenario: Live marker
- **WHEN** `inbox --follow` is running with pid 4242 on the inbox of `%12`
- **THEN** `<inbox>/.monitor` names pid 4242 and a sender treats the inbox as monitored

#### Scenario: Dead marker
- **WHEN** `<inbox>/.monitor` names a pid that no longer exists
- **THEN** a sender treats the inbox as unmonitored, and a new `inbox --follow` replaces the marker

#### Scenario: Second follower refused
- **WHEN** `inbox --follow` starts while a live marker exists
- **THEN** it exits 1, prints a message naming the live pid on stderr, and writes nothing

#### Scenario: Marker removed on exit
- **WHEN** a running `inbox --follow` receives SIGTERM or SIGINT
- **THEN** it removes its marker before exiting

### Requirement: Inbox follow command
The CLI SHALL provide `inbox (--follow | --once) [--parent <pane>]`, reachable through the skill shim. The command takes exactly one of `--follow` or `--once`; neither or both is a usage error (exit 1, stderr names both flags, nothing on stdout). `--parent` defaults to `TMUX_PANE`; a missing pane is a usage error (exit 1, stderr names `--parent`, nothing on stdout). The command SHALL print, on stdout, one line per pending entry in `at` order when it starts, then, while it runs, one line per entry that is created or rewritten, and nothing else on stdout; diagnostics go to stderr. A pending entry is one with no `ack` record. The line SHALL be `pmux report <id> from <from> (delivery <n>). Read <shell-quoted-report-path>, then run: node <shell-quoted-cli> ack --session <shell-quoted-session> --id <id>. Acknowledge only after reading.`, one line with no line terminator inside it. With `--once` the command prints the pending entries and exits 0 without writing a marker. Without `--once` it SHALL run until signalled, SHALL keep running when the inbox directory is created after it started, SHALL not depend on filesystem notifications alone (a periodic rescan no slower than every 5 seconds catches a missed notification), and SHALL print an entry at most once per `delivery` value.

#### Scenario: Pending entries printed first
- **WHEN** `inbox --follow` starts on an inbox holding two unacknowledged entries
- **THEN** stdout holds exactly two pointer lines before any new entry arrives, in `at` order

#### Scenario: New entry printed
- **WHEN** a marked child runs `send` to the followed pane
- **THEN** stdout gains one pointer line naming that report ID within 5 seconds

#### Scenario: Re-delivery printed again
- **WHEN** the wrapper rewrites an entry with `delivery:2`
- **THEN** stdout gains one more line for that ID that says `delivery 2`

#### Scenario: Acked entry not printed
- **WHEN** an entry's ID has an `ack` record when the follower sees it
- **THEN** no line is printed for it

#### Scenario: Once
- **WHEN** `inbox --once` runs on an inbox with one pending entry
- **THEN** it prints one line, writes no `.monitor` marker and exits 0

#### Scenario: Neither or both modes
- **WHEN** `inbox` runs with neither `--follow` nor `--once`, or with both
- **THEN** it exits 1 with an error naming `--follow` and `--once` on stderr and prints nothing on stdout

#### Scenario: Default pane
- **WHEN** `inbox --follow` runs without `--parent` and `TMUX_PANE` is `%12`
- **THEN** it follows the inbox of `%12`

#### Scenario: No pane
- **WHEN** `inbox --follow` runs without `--parent` and without `TMUX_PANE`
- **THEN** it exits 1 with an error naming `--parent` on stderr and prints nothing on stdout

#### Scenario: Inbox created later
- **WHEN** `inbox --follow` starts before any child has written to the inbox, and a child writes the first entry later
- **THEN** the follower prints that entry

### Requirement: Inbox transport availability
A marked pointer submission SHALL treat the inbox as the available transport when an inbox path exists and its marker is live. The entry write is the submission: on success the result is `delivered` with `via:"inbox"`, and no channel request and no pane input follow. When no inbox path exists, the marker is absent or dead, or the entry cannot be written, the inbox result is `unavailable` with reason `no-inbox`, `unmonitored` or `write-failed`, and the next transport runs.

#### Scenario: Monitored inbox
- **WHEN** the inbox of `%12` has a live marker and a marked child runs `send --to %12`
- **THEN** the entry is written, tmux receives no `send-keys` call, no endpoint connection is attempted, and the result is `via:"inbox"`

#### Scenario: Unmonitored inbox
- **WHEN** the inbox of `%12` has no marker
- **THEN** the inbox result is `unavailable` with reason `unmonitored`, and the submission continues with the channel

#### Scenario: Entry write fails
- **WHEN** the marker is live and the entry cannot be written
- **THEN** the inbox result is `unavailable` with reason `write-failed`, and the submission continues with the channel
