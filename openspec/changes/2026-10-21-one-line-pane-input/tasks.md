# Tasks

## 1. The encoding

- [ ] 1.1 In `pi-extension/pmux/pane-input.ts`, add `encodePaneText(text)`: a newline (U+000A) becomes the two characters `\n`, a carriage return (U+000D) becomes `\r`, a tab (U+0009) becomes `\t`, and any other C0 control character or DEL (U+007F) becomes `\xNN` with two lowercase hex digits. Every other character, a backslash included, is left as it is. The module is host independent, next to `exit-sidecar.ts` and `status-file.ts`.
- [ ] 1.2 In `pi-extension/pmux/cli.ts`, the `send` command types `encodePaneText(text)` instead of the raw text, so the report reaches the parent as one input whatever the parent pane runs. The receipt keeps counting the text `send` received, before the encoding.
- [ ] 1.3 The send footer stops telling the child to keep the report on one line. It says the report may span lines and that a line break arrives as `\n`. The phrases the spec requires stay.
- [ ] 1.4 In `AGENTS.md`, document the report encoding next to the other completion and env contracts: a pane input is one line, and the report channel encodes the line breaks so a report cannot be split across inputs.

## 2. Tests

- [ ] 2.1 Add `test/pane-input.test.ts`: the encoding table (newline, carriage return, tab, another control character, DEL), that a text without control characters comes back unchanged, and that the encoded text holds no line terminator and no tab.
- [ ] 2.2 In `test/cli.test.ts`, the multi-line `send` case expects one `send-keys -l` call whose text holds the lines joined by `\n`, and a new case covers a tab and a control character in the text.
- [ ] 2.3 The receipt case keeps asserting that `bytes` counts the text `send` received.

## 3. Gates

- [ ] 3.1 `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`.
- [ ] 3.2 `openspec validate 2026-10-21-one-line-pane-input --strict`.
