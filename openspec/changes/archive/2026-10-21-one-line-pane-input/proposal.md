# Proposal

## Why

Text typed into a tmux pane is one input: the text is typed, then one Enter keypress submits it. A newline inside that text is a line terminator in the target, so the rest of the text arrives as separate input.

The `send` report channel is built on that primitive. A child that writes a report spanning several lines — the normal shape of a report — therefore splits it: a shell-shaped parent pane runs the tail as commands, a TUI receives several submissions, and the parent reads a truncated report with the remainder landing wherever the UI happens to be. The `send` footer currently asks the child to keep the report on one line, which pushes the fix onto every child instead of fixing the channel.

The same primitive carries every other pane input pmux sends: `pmux_message` to a child or a sibling, the send-mode wake-up, the idle-watchdog nudge. A multi-line message is split there too, so the child receives fragments of one message as separate turns.

The send-mode wake-up has the same shape: it quotes the child's own ping question, so a question that spans lines would arrive as several inputs.

One encoding rule at the pane-input boundary closes all of it: the text is encoded so that it holds no line terminator and no tab, and the target receives the whole text as one input.

## What Changes

- A new host-independent module `pane-input.ts` owns the encoding: a newline becomes the two characters `\n`, a carriage return `\r`, a tab `\t`, and any other C0 control character or DEL `\xNN` with lowercase hex. Every other character, a backslash included, is left as it is.
- The tmux backend's pane-input primitive (`agentPrompt`) encodes the text before typing it. Every pane input pmux sends is therefore one input, whatever the target pane runs.
- The `send` report channel is unchanged in shape: one `send-keys -l` call, one Enter. A report that spans lines now arrives whole, with the line breaks visible as `\n`.
- The send-mode wake-up is encoded the same way, so a ping question that spans lines reaches the parent as one input.
- The receipt's `bytes` field keeps counting the text `send` received, before the encoding, so the receipt still describes what the child wrote.
- The send footer stops telling the child to keep the report on one line. It says the report may span lines and that a newline arrives as `\n`.
- The `pmux_message` contract says the text is encoded, not "typed as it is".

## Non-goals

- No change to the launch contract, the report mode, the wake-up, the sidecars, the receipts' file, or the pi-parent message-file delivery. Only what is typed into a pane changes.
- No bracketed-paste delivery. tmux can paste a buffer with bracketed paste markers, but the targets disagree about what a paste means: pi's editor strips the newlines out of a bracketed paste and glues the lines together, while a shell keeps them as a multi-line command line. The encoding is the same in every target, which is what the channel needs.
- No escaping of a backslash. A report that already holds the two characters `\n` reads the same as an encoded newline; the text stays as close to what the child wrote as a one-line delivery allows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: the `send` command delivers one encoded line, the send-mode wake-up encodes the ping question it quotes, and the receipt's `bytes` counts the text as received.
- `luvus-messaging`: a message to a child or a sibling is typed as one encoded input, not "as it is".

## Impact

- `pi-extension/pmux/pane-input.ts`: new, host independent, holds the encoding.
- `pi-extension/pmux/tmux.ts`: `agentPrompt` encodes the text it types.
- `pi-extension/pmux/cli.ts`: the send footer text.
- `pi-extension/pmux/run.ts`: the send-mode wake-up encodes the text it types.
- `AGENTS.md`: the pane-input contract, next to the other completion and env contracts.
- Tests: a new `test/pane-input.test.ts` for the encoding, the multi-line `send` case in `test/cli.test.ts`, the `agentPrompt` case in `test/tmux.test.ts`.
