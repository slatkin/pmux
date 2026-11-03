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

export interface ListDialogOptions {
  /** A line drawn above the filter (the dialog's title). */
  title?: string;
  /** A hint line drawn under the list (the confirm line). */
  footer?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** The rows a list draw takes besides the items: filter line plus chrome. */
function chromeLines(options: ListDialogOptions): number {
  return 1 + (options.title ? 1 : 0) + (options.footer ? 1 : 0);
}

/** The state's draw lines: title, filter, the visible window, the footer. */
function drawLines(state: ListState, maxRows: number, options: ListDialogOptions): string[] {
  const lines: string[] = [];
  if (options.title) lines.push(options.title);
  lines.push(`> ${state.filter}`);
  const filtered = filteredItems(state);
  const first = Math.min(
    Math.max(0, state.selected - maxRows + 1),
    Math.max(0, filtered.length - maxRows),
  );
  const visible = filtered.slice(first, first + maxRows);
  for (const [row, item] of visible.entries()) {
    lines.push(first + row === state.selected ? `\x1b[7m${item}\x1b[0m` : item);
  }
  if (visible.length === 0) lines.push("(no matches)");
  if (options.footer) lines.push(options.footer);
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
      const maxRows = Math.max(1, (output.rows ?? 24) - chromeLines(options));
      const lines = drawLines(state, maxRows, options);
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
