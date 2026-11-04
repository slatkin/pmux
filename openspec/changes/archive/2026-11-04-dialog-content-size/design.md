# Design

## Sizing split: hints at the outer, clamp at the host

`tmux display-popup` takes one size at open and cannot be resized, and the popup's size must cover every step of the dialog, not only the first list. The outer side is the only place that runs before the popup exists, so it computes the hints; `dialog-host.ts` stays generic and turns hints into argv.

- `RunDialogArgs` gains optional `width` and `height` in cells. `popupArgs` passes `-w <n> -h <n>` when both are set and keeps `-w 80% -h 80%` when they are not.
- The host clamps a hint to four fifths of the caller pane's size, read with one `display-message -p -t <pane> '#{pane_width} #{pane_height}'` call before the popup. The read runs under the normal tmux budget; the wait on the state file stays out of budget as before. The clamp is injected (`paneSize` in `RunDialogDeps`) so tests need no tmux server.
- The width hint covers the title and the rows the outer side knows. Footer lines (the built-in-copy path, a model-list error) are excluded: they wrap inside the popup instead of widening it. The height hint covers the largest known list plus the list chrome (title, filter, footer).

## The list widget draws divided and wrapped rows

`dialog-ui.ts` keeps items as logical strings; the rendering gains three rules.

- An item may hold embedded newlines. The widget splits each item on `\n` into its lines.
- Any line longer than the popup's content width (`output.columns`) is word-wrapped; a word longer than the width is hard-split. Title, filter and footer lines wrap the same way.
- Scrolling moves by display lines, not items: the window starts at the furthest item before the selected one whose lines fit, and draws whole items until the budget runs out; a lone item taller than the window clips. Every line of the selected item draws in inverse video, so the selection reads as one block.

The reducer, the filter and the choice mapping are untouched: filtering still matches the whole item text, and a choice still maps back through `items.indexOf`, so callers keep using indexes.

## Per-dialog hints

- **Role editor.** `roleRow` becomes two lines: `name  [source]`, then the values line indented two spaces. The outer side calls `listRoles` (a cheap directory read) and computes the width from the widest row line and the title, and the height from the role list. The value steps' model ids are unknown to the outer side and wrap.
- **Spawn dialog.** The same role rows drive the hints, but the brief editor runs in the same popup, so the width hint never drops below 80 columns. With a role named on the command line the dialog opens at the brief step, so the hints are the floor alone.
- **Report viewer.** The outer side now reads the caller pane's history first. An empty or missing history answers `no reports` and opens nothing; otherwise the same records give the row count for the height and the widest known row for the width.

The `no reports` pre-check re-reads nothing in the inner side: the inner keeps listing the history itself, so a report that lands between the check and the popup still shows.

## Spec deltas

- `popup-dialogs` gains a "Dialog size" requirement: content-fit sizing, the four-fifths cap, divided rows, wrapping, and block selection.
- `report-viewer` modifies "Report viewer commands": the command checks the history first and answers `no reports` with no popup when the history is empty or missing. The "No reports" scenario under "Report list" stays: the inner side still answers `no reports` when a race or a direct inner run finds an empty history.
