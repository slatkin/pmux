# Tasks

## 1. List widget

- [x] 1.1 `dialog-ui.ts`: word-wrap a line to a width (greedy on spaces, hard-split overlong words); split items on embedded newlines.
- [x] 1.2 `dialog-ui.ts`: draw items as one or more lines, highlight every line of the selected item, scroll by display lines, and clip an item taller than the window.
- [x] 1.3 Tests: wrapping, divided rows, block selection and windowing at small row budgets.

## 2. Dialog host

- [x] 2.1 `tmux.ts`: read a pane's width and height with one `display-message` call.
- [x] 2.2 `dialog-host.ts`: `width` and `height` hints on `RunDialogArgs`, the four-fifths clamp against the caller pane, and the cell-count popup argv; percent argv when no hints are set.
- [x] 2.3 Tests: clamped and unclamped argv, the no-hint default, and the clamp's tmux failure falling back to the percent argv.

## 3. Dialogs

- [x] 3.1 `dialog-roles.ts`: the two-line role row; the outer side's width and height hints from the role list.
- [x] 3.2 `dialog-spawn.ts`: hints from the role rows with the 80-column editor floor; the floor alone when a role is named.
- [x] 3.3 `dialog-reports.ts`: the no-reports pre-check before any popup, and hints from the history it already read.
- [x] 3.4 Tests: hint computation per dialog and the pre-check's line and argv.

## 4. Spec and gates

- [x] 4.1 Spec deltas: `popup-dialogs` "Dialog size"; `report-viewer` "Report viewer commands". `openspec validate --strict`.
- [x] 4.2 Gates: `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`.
