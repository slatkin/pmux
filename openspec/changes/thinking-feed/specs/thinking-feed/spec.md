# Spec Delta

## Purpose

Defines the thinking feed: the file in which the pmux pi extension records the thinking of its session, so that the pmux-explorer sidebar can show the session's last thought.

## ADDED Requirements

### Requirement: the feed has one file per session

The extension SHALL write the feed of a session to `<dir>/<session id>.jsonl`, where `<dir>` is `$XDG_RUNTIME_DIR/pmux-thinking`, or `/tmp/pmux-thinking-<uid>` when `XDG_RUNTIME_DIR` is unset or empty. A new session id SHALL get its own file. A resumed session SHALL append to the file of its id.

#### Scenario: the runtime directory is set
- **WHEN** `XDG_RUNTIME_DIR` is `/run/user/1000` and the session id is `abc`
- **THEN** the feed is `/run/user/1000/pmux-thinking/abc.jsonl`

#### Scenario: the runtime directory is unset
- **WHEN** `XDG_RUNTIME_DIR` is unset, the uid is 1000, and the session id is `abc`
- **THEN** the feed is `/tmp/pmux-thinking-1000/abc.jsonl`

#### Scenario: a new session in the same process
- **WHEN** the user starts a new session with id `def` in the same pi process
- **THEN** later thinking is written to `def.jsonl` and `abc.jsonl` gets no more records

### Requirement: the feed is private

The extension SHALL create the feed directory with mode 0700 and the feed file with mode 0600, and SHALL set those modes again when the directory or file already exists with another mode.

#### Scenario: a fresh directory
- **WHEN** the session starts and the feed directory does not exist
- **THEN** the directory exists with mode 0700 and the empty feed file exists with mode 0600

### Requirement: one record per thinking phase

Each line SHALL be one JSON object `{kind, ts, producer, text?}`. `kind` SHALL be `start` when a thinking block begins, `delta` for streamed text, and `end` when the block completes. `ts` SHALL be the ISO 8601 time the phase was seen. `producer` SHALL be one random token per producer. A `start` SHALL carry no `text`. An `end` SHALL carry the final content as `text` only when that content is not empty.

#### Scenario: a block
- **WHEN** pi streams a thinking start, deltas "a" and "b" within 50 ms of each other, and a thinking end with content "ab"
- **THEN** the feed holds a `start` record, a `delta` record with text "ab", and an `end` record with text "ab"

#### Scenario: an empty end
- **WHEN** pi ends a thinking block with empty content
- **THEN** the `end` record has no `text` field

### Requirement: deltas are coalesced

The extension SHALL append the deltas that arrive within 50 ms as one `delta` record, stamped with the time of the first of them. The pending deltas SHALL be appended before a `start`, before an `end`, and when the session shuts down. An empty delta SHALL write nothing.

#### Scenario: many small deltas
- **WHEN** 20 deltas arrive within 50 ms
- **THEN** the feed gets one `delta` record holding their text in order

#### Scenario: shutdown with pending text
- **WHEN** the session shuts down 10 ms after a delta
- **THEN** that delta's text is in the feed

### Requirement: the feed follows the sidebar guards

The extension SHALL write the feed when the session runs in a tmux pane (`$TMUX_PANE` is set) and the sidebar switch is on (`PMUX_EXPLORER` is not `0`), and SHALL NOT gate the feed on the pmux-explorer binary.

#### Scenario: outside tmux
- **WHEN** pi runs with no `$TMUX_PANE`
- **THEN** no feed directory or file is created

#### Scenario: the sidebar is switched off
- **WHEN** `PMUX_EXPLORER` is `0`
- **THEN** no feed directory or file is created

#### Scenario: no sidebar binary
- **WHEN** pmux-explorer is not installed
- **THEN** the feed is written the same

### Requirement: a feed failure never disturbs the session

A failure to create, chmod or append to the feed SHALL be swallowed. It SHALL NOT raise an error into pi, delay a turn, or show a message.

#### Scenario: an unwritable directory
- **WHEN** the feed directory cannot be created
- **THEN** the session runs as normal and thinking is not recorded
