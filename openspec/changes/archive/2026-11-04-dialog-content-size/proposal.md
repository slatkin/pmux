# Proposal

## Why

The three popup dialogs open at a fixed `-w 80% -h 80%`, and every list in them is a single column, so a dialog over a wide terminal is mostly empty space. The role editor is the worst case: each role row is one long line (name, source, and three values), which forces the width up while the list itself is one column. The report viewer has the same shape in miniature. Separately, `/pmux-reports` opens the popup before it knows whether the pane has any reports, so a pane with no reports gets a popup that only says "no reports".

## What Changes

- Size each popup to its dialog's content instead of a fixed 80% by 80%:
  - The outer side of each dialog computes a width and height hint from the content it knows (title, rows, chrome) and passes both to the dialog host.
  - The host clamps both hints to four fifths of the caller pane's size and opens the popup with cell counts.
  - A dialog without hints keeps today's `80%` by `80%` popup.
- Make the list widget carry divided and long rows:
  - An item may hold embedded newlines; the widget draws each item on one or more lines and highlights every line of the selected item.
  - The widget word-wraps any line longer than the popup's width, including the title and footer lines, and scrolls by display lines so a tall item stays visible as a whole.
- Divide the role row onto two lines: identity (name and source) on the first, the three values on the second. The spawn dialog's role step shows the same rows.
- The report viewer's outer side reads the caller pane's history before it opens anything: with an empty or missing history it answers `no reports` and no popup opens.
- The spawn dialog keeps a wide floor (80 columns) for the brief editor step, so the editor is not cramped by the role list's narrow fit.
- Out of scope: resizing a popup after it opens (tmux cannot), and per-step sizes inside one dialog.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `popup-dialogs`: a new requirement pins the content-fit sizing and the list's wrapping and divided-row drawing.
- `report-viewer`: the viewer commands check the history first and answer `no reports` without a popup when there is nothing to show.

## Impact

- `pi-extension/pmux/dialog-host.ts`: `RunDialogArgs` width and height hints, the pane-size clamp, and the popup argv.
- `pi-extension/pmux/dialog-ui.ts`: multi-line items, word wrap, and line-based scrolling in the list widget.
- `pi-extension/pmux/dialog-roles.ts`: the two-line role row and the editor's size hints.
- `pi-extension/pmux/dialog-spawn.ts`: the spawn dialog's size hints with the editor floor.
- `pi-extension/pmux/dialog-reports.ts`: the no-reports pre-check and the viewer's size hints.
- `pi-extension/pmux/tmux.ts`: a pane-size read the host clamp uses.
