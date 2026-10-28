# Spec Delta

## MODIFIED Requirements

### Requirement: Report transport selection
Each marked pointer submission (by `send` and by the wrapper's re-delivery) SHALL try the transports in this order: the parent's report inbox (`report-inbox`), then the channel, then the verified report input. When the inbox result is `delivered`, pmux MUST NOT connect to the channel endpoint and MUST NOT type into the parent pane. When the inbox is `unavailable` (no inbox path, no live monitor marker, or a failed entry write), pmux SHALL try the channel; on `emitted`, pmux MUST NOT type into the parent pane. When the channel is also `unavailable`, pmux SHALL submit the same pointer through the verified report input. A missing or late `ack` MUST NOT cause a fallback or a second submission. Each attempt SHALL mint a fresh visibility token. Unmarked sends MUST NOT use the inbox or the channel.

#### Scenario: Inbox delivers
- **WHEN** the inbox result is `delivered`
- **THEN** no endpoint connection is attempted and no tmux `send-keys` call is made for that attempt

#### Scenario: Channel delivers
- **WHEN** the inbox result is `unavailable` and the channel result is `emitted`
- **THEN** no tmux `send-keys` call is made for that attempt

#### Scenario: Fallback on an unavailable channel
- **WHEN** the inbox result is `unavailable` with reason `unmonitored` and the channel result is `unavailable` with reason `no-endpoint`
- **THEN** the pointer is submitted once through the verified report input

#### Scenario: No fallback on a busy parent
- **WHEN** the inbox result is `delivered` or the channel result is `emitted`, and no `ack` arrives within `--ack-timeout`
- **THEN** no pointer is typed into the pane, and `send` exits 0 with `acknowledged:false`

#### Scenario: Re-delivery tries the channel again
- **WHEN** the wrapper re-delivers an unacknowledged report at child exit
- **THEN** the re-delivery tries the inbox first, then the channel with a fresh token and the same report ID, then the verified input

#### Scenario: Legacy send
- **WHEN** an unmarked child runs `send`
- **THEN** no inbox entry is written and no endpoint connection is attempted
