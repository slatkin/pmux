# Design

## The shape of a pane input

A pane input is one line. pmux types the text with `send-keys -l`, then presses Enter. The target reads the line and submits it. Whatever the target is — pi's editor, Claude Code's input box, a shell — one typed line plus one Enter is one input.

A newline inside the typed text breaks that. The target's line discipline ends the line at the newline, so the text after it is a second input. The send-mode wake-up and the `send` report channel both hit this: a report that spans lines arrives as several inputs, and the parent reads the first one and treats the rest as noise (or, in a shell, runs them).

## The encoding

`encodePaneText(text)` returns text that holds no line terminator and no tab:

| input | output |
| --- | --- |
| newline (U+000A) | `\n` |
| carriage return (U+000D) | `\r` |
| tab (U+0009) | `\t` |
| any other C0 control, or DEL (U+007F) | `\xNN`, two lowercase hex digits |
| everything else | unchanged |

A backslash is left alone. The encoding is therefore not reversible, and it does not claim to be: a report that already holds the two characters `\n` reads the same as an encoded newline. That is the price of a one-line delivery, and it is smaller than the price of a split report.

The rules are deliberately narrow. Only the characters that end a line or a field survive raw in a terminal input: LF, CR and TAB. The rest of C0 and DEL are escaped because a stray escape byte in a report could drive the target's terminal, and a visible `\x1b` is worth more than the byte.

Unicode is untouched. A report in any language arrives as it was written.

## Where the rule lives

`pane-input.ts` is host independent, next to `exit-sidecar.ts` and `status-file.ts`: the encoding is a property of terminal input, not of tmux. The tmux backend calls it from `agentPrompt`, so there is one rule at one place, and every pane input pmux sends inherits it: the `send` report, `pmux_message` to a child or a sibling, the send-mode wake-up, the idle-watchdog nudge.

Encoding inside `agentPrompt` rather than at each call site means no caller can forget it. The cost is that the receipt's `bytes` counts the text before the encoding, because `send` receives the child's text and the backend encodes it later. The receipt spec says so explicitly.

## Why not a bracketed paste

tmux can carry a paste: `set-buffer` puts the text in a buffer, `paste-buffer -p` sends it with bracketed paste markers when the target asked for them, and the target reads the newlines as literal text inside one paste. That is the textbook answer, and it keeps the line structure.

It does not survive contact with the targets:

- pi's editor handles a bracketed paste by stripping the newlines out of it and gluing the lines together. The report arrives as one line with no separator, so "line one" and "line two" become "line oneline two".
- A shell with bracketed paste keeps the text in the command line as a multi-line command, and the Enter that follows runs the report as a command.
- Whether the markers are sent at all depends on the target having asked tmux for bracketed paste mode, which pmux cannot observe.

The encoding is the same in every target, and the target can read it: a parent agent reads `verdict: pass\nfiles: a.ts, b.ts` as one message and knows where the lines broke. The line structure is one step from the original instead of exact, and the report is never split, never truncated and never executed.

A bracketed-paste delivery would be a larger change with a target-dependent result, so it stays out of this change.

## What the child is told

The send footer told the child to keep the report on one line, which put the burden of the channel's rule on every child. It now says the report may be long, may contain quotes and may span lines, and that a newline arrives as `\n`. A child can write a report the way it writes one anywhere else.

## Tests

- `test/pane-input.test.ts`: the encoding table, and that a text without control characters comes back unchanged.
- `test/cli.test.ts`: the multi-line `send` case types one line with the visible `\n`, and the receipt still counts the text as received.
- `test/tmux.test.ts`: `agentPrompt` encodes before typing.
