/**
 * The dialog list widget (design D3): a pure reducer over the list state —
 * the tests drive it — plus a raw-mode renderer that draws the state with
 * ANSI codes and reads keys through `node:readline` `emitKeypressEvents`.
 *
 * The keyboard model: Up/Down move the selection, typed characters narrow
 * the list to items containing them (case-insensitive), Backspace widens it
 * again, Enter chooses the selected item, Escape cancels. Editor and pager
 * steps hand the TTY to a child process through `runOnTty` (`spawnSync`
 * with `stdio: "inherit"`) and take raw mode back after it.
 */
import { spawnSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";

/** The key shape the reducer reads; readline's `Key` is compatible. */
export interface ListKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Where the list stands; `pending` keeps reading keys. */
export type ListOutcome =
  { type: "pending" } | { type: "chosen"; index: number; item: string } | { type: "cancel" };

export interface ListState {
  /** Every row, in display order. */
  items: readonly string[];
  /** The typed filter text; the narrowed view is derived, never stored. */
  filter: string;
  /** The selected row of the filtered view (not of `items`). */
  selected: number;
  outcome: ListOutcome;
}

export function initListState(items: readonly string[]): ListState {
  return { items, filter: "", selected: 0, outcome: { type: "pending" } };
}

/** The rows the filter keeps: a case-insensitive substring match. */
export function filteredItems(state: ListState): string[] {
  const needle = state.filter.toLowerCase();
  return state.items.filter((item) => item.toLowerCase().includes(needle));
}

/** True when every character is printable (no control bytes, no DEL). */
function isPrintable(sequence: string): boolean {
  if (sequence.length === 0) return false;
  for (const ch of sequence) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * One step of the list: `(state, key) -> state`. A terminal outcome latches
 * — keys after Enter or Escape change nothing.
 */
export function reduceListKey(state: ListState, key: ListKey): ListState {
  if (state.outcome.type !== "pending") return state;
  const filtered = filteredItems(state);
  switch (key.name) {
    case "escape":
      return { ...state, outcome: { type: "cancel" } };
    case "return":
    case "enter": {
      if (filtered.length === 0) return state;
      const index = Math.min(state.selected, filtered.length - 1);
      const item = filtered[index]!;
      return {
        ...state,
        selected: index,
        outcome: { type: "chosen", index: state.items.indexOf(item), item },
      };
    }
    case "up":
      return { ...state, selected: Math.max(0, state.selected - 1) };
    case "down":
      return {
        ...state,
        selected: Math.max(0, Math.min(filtered.length - 1, state.selected + 1)),
      };
    case "backspace":
      if (state.filter.length === 0) return state;
      // A wider list makes a remembered row ambiguous: start at the top.
      return { ...state, filter: state.filter.slice(0, -1), selected: 0 };
    case "c":
      if (key.ctrl === true) return { ...state, outcome: { type: "cancel" } };
      break;
    default:
      break;
  }
  // A typed character narrows the list and puts the selection back at the
  // top of the narrowed view; named keys the switch did not claim (and
  // modified keys) do nothing.
  if (key.ctrl !== true && key.meta !== true && key.sequence && isPrintable(key.sequence)) {
    return { ...state, filter: state.filter + key.sequence, selected: 0 };
  }
  return state;
}

/** What a finished list returns: the chosen row, or null on a cancel. */
export interface ListChoice {
  /** The chosen item's index in `items` (not in the filtered view). */
  index: number;
  item: string;
}

/**
 * Word-wrap one line to a width: greedy on spaces, and a word longer than
 * the width hard-splits. A width below 1 returns the line whole.
 */
export function wrapLine(line: string, width: number): string[] {
  if (width < 1 || line.length <= width) return [line];
  const rows: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const head = rest.slice(0, width + 1);
    const cut = head.lastIndexOf(" ");
    const at = cut > 0 ? cut : width;
    rows.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^ /, "");
  }
  if (rest.length > 0) rows.push(rest);
  return rows;
}

/**
 * One item's display lines: embedded newlines divide the item, and each
 * divided line wraps to the width.
 */
export function itemLines(item: string, width: number): string[] {
  return item.split("\n").flatMap((line) => wrapLine(line, width));
}

export interface ListDialogOptions {
  /** A line drawn above the filter (the dialog's title). */
  title?: string;
  /** A hint line drawn under the list (the confirm line). */
  footer?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** The rows a list draw takes besides the items: filter line plus chrome. */
function chromeLines(options: ListDialogOptions, width: number): number {
  return (
    1 +
    (options.title ? wrapLine(options.title, width).length : 0) +
    (options.footer ? wrapLine(options.footer, width).length : 0)
  );
}

/** The window of items a draw shows: whole items between start (incl.) and end (excl.). */
function listWindow(
  wrapped: string[][],
  selected: number,
  maxRows: number,
): { start: number; end: number } {
  // Walk back from the selection while the earlier items still fit.
  let start = selected;
  let used = wrapped[selected]!.length;
  while (start > 0 && used + wrapped[start - 1]!.length <= maxRows) {
    start--;
    used += wrapped[start]!.length;
  }
  // Draw forward from the start while whole items fit. The caller clips
  // the lone-item case by line budget.
  let end = start;
  used = 0;
  while (end < wrapped.length && used + wrapped[end]!.length <= maxRows) {
    used += wrapped[end]!.length;
    end++;
  }
  if (end === start) end = start + 1;
  return { start, end: Math.min(end, wrapped.length) };
}

/** The state's draw lines: title, filter, the visible items' lines, the footer. */
export function renderListLines(
  state: ListState,
  size: { rows: number; columns: number },
  options: ListDialogOptions,
): string[] {
  const width = Math.max(1, size.columns);
  const maxRows = Math.max(1, size.rows - chromeLines(options, width));
  const lines: string[] = [];
  if (options.title) lines.push(...wrapLine(options.title, width));
  lines.push(...wrapLine(`> ${state.filter}`, width));
  const filtered = filteredItems(state);
  if (filtered.length === 0) {
    lines.push("(no matches)");
  } else {
    const wrapped = filtered.map((item) => itemLines(item, width));
    const { start, end } = listWindow(wrapped, state.selected, maxRows);
    let budget = maxRows;
    draw: for (const [row, item] of wrapped.slice(start, end).entries()) {
      const chosen = start + row === state.selected;
      for (const line of item) {
        // A lone item taller than the window clips at the budget.
        if (budget-- === 0) break draw;
        lines.push(chosen ? `\x1b[7m${line}\x1b[0m` : line);
      }
    }
  }
  if (options.footer) lines.push(...wrapLine(options.footer, width));
  return lines;
}

/**
 * Run the list on a terminal: draw, read keys in raw mode, resolve with the
 * chosen row or null on a cancel. The reducer decides every key; the
 * renderer only draws and returns.
 */
export function chooseFromList(
  items: readonly string[],
  options: ListDialogOptions = {},
): Promise<ListChoice | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let state = initListState(items);

  return new Promise((resolve) => {
    const draw = (): void => {
      const lines = renderListLines(
        state,
        { rows: output.rows ?? 24, columns: output.columns ?? 80 },
        options,
      );
      output.write(`\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\r\n")}\x1b[J`);
    };

    const finish = (choice: ListChoice | null): void => {
      input.off("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
      resolve(choice);
    };

    const onKeypress = (_str: string, key: ListKey): void => {
      state = reduceListKey(state, key);
      if (state.outcome.type === "pending") {
        draw();
      } else if (state.outcome.type === "chosen") {
        finish({ index: state.outcome.index, item: state.outcome.item });
      } else {
        finish(null);
      }
    };

    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    output.write("\x1b[2J\x1b[H\x1b[?25l");
    draw();
  });
}

/**
 * Hand the TTY to a child process — the editor step's `$VISUAL`/`$EDITOR`
 * and the viewer's pager run this way (`stdio: "inherit"`), and the caller
 * takes raw mode back afterwards. Returns the exit status; `error` is set
 * only when the command could not start.
 */
export function runOnTty(
  command: string,
  args: string[] = [],
): { status: number | null; error?: Error } {
  const result = spawnSync(command, args, { stdio: "inherit" });
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  };
}
