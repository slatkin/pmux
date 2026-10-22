# Design

## Context

The `send` command is the only pmux command an agent runs without reading
anything back. It types text into a pane through tmux and returns an exit
code, so the only channel it has to the caller is stdout. It used none.

## Decisions

### D1: The confirmation is one JSON line

`send` prints `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path>}`.

JSON, because every other pmux command answers with one JSON line
(`start`, `resume`, `wait`, `prune`) and a caller that reads one shape
reads all of them the same way. One line, because the child's own pane
shows it and a long report would scroll the evidence away.

`sent` is a constant `true`: the command exits 0 only when the text was
typed, so the line is never printed for a failed delivery. A usage error
keeps the old shape instead — a message on stderr, an empty stdout, exit 1
— so a failure never looks like a success.

### D2: `bytes` is the text as given

The count is the UTF-8 length of the text before the pane-input encoding,
the same unit and the same value the receipt records. A child that reads
the confirmation can compare the number with the receipt line and know they
describe the same text. The encoded form is longer (a newline becomes two
characters), so counting the encoded bytes would report a number no other
part of pmux uses.

### D3: `receipt` is the path, or null

Inside a child the confirmation names the absolute path of the
`<session>.sent` file, so the child can read the receipt and see the
recorded delivery. Outside a child there is no session file, and a failed
receipt write leaves none behind; both report `null`. The path is null
rather than a missing field so the shape never changes, and it is null
rather than a guess because a receipt that was not written must not be
named.

### D4: The footer names the confirmation

The send-mode parent-contact footer gains a sentence: the command prints
one confirmation line, that line is the delivery receipt, and the child
must not send anything else to the parent to check whether the report
arrived. The footer is the only place the child is told how to report, so
the rule belongs there. The prohibition is explicit because the failure was
not a missing check but an invented one: the child asked the parent a
question the parent cannot answer, and the parent's answer was noise.

### D5: The spec pins the general rule

A new requirement states that every CLI command prints at least one line on
stdout when it succeeds, and that a usage error prints on stderr with an
empty stdout. Without it, the next command can be silent again, and the
next agent will probe again.

## Risks

- The confirmation line is new stdout in a command whose stdout some
  callers may parse. The command had no stdout before, so no caller can
  break on it.
- The receipt path leaks a scratch path into the child's pane. The child
  already knows its own session path from `PI_PMUX_SESSION`.

## Migration

None. The change adds output to a command that produced none.
