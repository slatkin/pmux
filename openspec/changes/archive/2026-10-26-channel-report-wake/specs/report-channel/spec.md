# Spec Delta

## Purpose

The pmux side of the channel report transport: how a marked report pointer finds the parent's channel endpoint, what it sends, how it reads the reply, and when it falls back to the verified tmux input.

## ADDED Requirements

### Requirement: Channel endpoint path
pmux SHALL derive the endpoint of a parent pane from the tmux socket path (the first comma field of `TMUX`) and the target pane id. The directory is `$XDG_RUNTIME_DIR/pmux-channel`, or `/tmp/pmux-channel-<uid>` when `XDG_RUNTIME_DIR` is unset or empty. The file name is `<h>-<n>.sock`, where `<h>` is the 16-digit lowercase hex FNV-1a 64-bit hash of the socket path bytes and `<n>` is the pane id without its `%`.

#### Scenario: Shared test vector
- **WHEN** `TMUX` is `/tmp/tmux-1000/default,1,0`, the target pane is `%12` and `XDG_RUNTIME_DIR` is `/run/user/1000`
- **THEN** the endpoint path is `/run/user/1000/pmux-channel/79301cf9592f327a-12.sock`

#### Scenario: No runtime dir
- **WHEN** `XDG_RUNTIME_DIR` is unset and the uid is 1000
- **THEN** the directory is `/tmp/pmux-channel-1000`

#### Scenario: The target pane, not the caller's pane
- **WHEN** a child in pane `%30` sends to parent `%12`
- **THEN** the path names `12`, not `30`

#### Scenario: No tmux socket
- **WHEN** `TMUX` is unset or empty
- **THEN** no endpoint path exists, the channel result is `unavailable` with reason `no-endpoint`, and no connection is attempted

### Requirement: Channel endpoint request
pmux SHALL connect to the endpoint, write one JSON line `{"v":1,"kind":"report","id":<32hex>,"text":<pointer>,"bytes":<n>,"token":<32hex>}` and read one JSON reply line. `text` is the one-line pointer that the verified input would type, with the same visibility token. `bytes` is the UTF-8 length of the report text, the same value as the `notification` record's `bytes`. The connect, the write and the reply together SHALL take at most 2 seconds.

#### Scenario: One request line
- **WHEN** a marked report with ID `<id>` is submitted to a live endpoint
- **THEN** the endpoint receives exactly one line, its `id` and `bytes` match the report, and its `text` and `token` match the pointer

#### Scenario: Slow endpoint
- **WHEN** the endpoint accepts the connection and sends no reply within 2 seconds
- **THEN** pmux closes the connection and the result is `unavailable` with reason `timeout`

### Requirement: Channel result classes
A reply `{"ok":true,"emitted":true}` SHALL be the only `emitted` result. Every other outcome SHALL be `unavailable` with a reason: `no-endpoint` (no path, or the file does not exist), `refused` (the connection is refused), `timeout`, `unarmed`, `write-failed` and `invalid` (the endpoint's own reasons), and `bad-reply` (a reply that is not one of these). `emitted` MUST NOT count as a read receipt.

#### Scenario: Emitted
- **WHEN** the endpoint replies `{"ok":true,"emitted":true}`
- **THEN** the result is `emitted`, and the report has no `ack` until the parent runs `ack`

#### Scenario: Not armed
- **WHEN** the endpoint replies `{"ok":false,"reason":"unarmed"}`
- **THEN** the result is `unavailable` with reason `unarmed`

#### Scenario: Stale socket file
- **WHEN** the endpoint file exists and no process listens on it
- **THEN** the result is `unavailable` with reason `refused`

#### Scenario: Garbage reply
- **WHEN** the endpoint replies with a line that is not JSON
- **THEN** the result is `unavailable` with reason `bad-reply`

### Requirement: Report transport selection
Each marked pointer submission (by `send` and by the wrapper's re-delivery) SHALL try the channel first. On `emitted`, pmux MUST NOT type into the parent pane. On `unavailable`, pmux SHALL submit the same pointer through the verified report input. A missing or late `ack` MUST NOT cause a fallback or a second submission. Each attempt SHALL mint a fresh visibility token. Unmarked sends MUST NOT use the channel.

#### Scenario: Channel delivers
- **WHEN** the channel result is `emitted`
- **THEN** no tmux `send-keys` call is made for that attempt

#### Scenario: Fallback on an unavailable channel
- **WHEN** the channel result is `unavailable` with reason `no-endpoint`
- **THEN** the pointer is submitted once through the verified report input

#### Scenario: No fallback on a busy parent
- **WHEN** the channel result is `emitted` and no `ack` arrives within `--ack-timeout`
- **THEN** no pointer is typed into the pane, and `send` exits 0 with `acknowledged:false`

#### Scenario: Re-delivery tries the channel again
- **WHEN** the wrapper re-delivers an unacknowledged report at child exit
- **THEN** the re-delivery tries the channel first with a fresh token and the same report ID

#### Scenario: Legacy send
- **WHEN** an unmarked child runs `send`
- **THEN** no endpoint connection is attempted
