/**
 * The dialog list widget (design D3): a pure reducer over the list state —
 * the tests drive it — plus a raw-mode renderer that draws the state with
 * ANSI codes and reads keys through `node:readline` `emitKeypressEvents`.
 *
 * The keyboard model: Up/Down move the selection, typed characters narrow
 * the list to items containing every typed word (case-insensitive),
 * Backspace widens it again, Enter chooses the selected item, Escape
 * cancels. Editor and pager steps hand the TTY to a child process through
 * `runOnTty` (`spawnSync` with `stdio: "inherit"`) and take raw mode back
 * after it.
 *
 * The role editor adds two screens on the same plumbing (design D2): a
 * model picker over two item arrays with Tab to swap them, and a role
 * panel whose rows stage frontmatter edits until `s` saves them.
 */
import { spawnSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";

import { THINKING_LEVELS, type RoleInfo, type RoleKey, type RoleSource } from "./agent-defs.ts";

/** The mark a row shows when a frontmatter value is absent. */
export const ABSENT_MARK = "—";

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

export function initListState(
  items: readonly string[],
  options: { selected?: number } = {},
): ListState {
  const selected = Math.max(0, Math.min(items.length - 1, options.selected ?? 0));
  return { items, filter: "", selected, outcome: { type: "pending" } };
}

/**
 * The items a filter keeps: it splits the typed text on spaces, drops empty
 * words, and keeps an item that contains every word (design D7). A filter
 * without a space therefore matches as a plain substring, as it always did.
 */
function filterWords(items: readonly string[], filter: string): string[] {
  const words = filter
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 0);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const text = item.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The rows the filter keeps. */
export function filteredItems(state: ListState): string[] {
  return filterWords(state.items, state.filter);
}

/** An item's row in the filtered view, or 0 when the item is not shown. */
function selectedInView(items: readonly string[], filter: string, item?: string): number {
  if (item === undefined) return 0;
  const index = filterWords(items, filter).indexOf(item);
  return index === -1 ? 0 : index;
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
  /** The row the list opens on, an index in `items`; defaults to the top. */
  selected?: number;
  /** The item the renderer marks, an index in `items`; unmarked when unset. */
  marked?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** The marker a list draws in front of the marked item. */
const ITEM_MARKER = "● ";

/** The room the marked-item column takes when a list marks an item. */
const MARKER_WIDTH = ITEM_MARKER.length;

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
    // A marked list keeps a column for the marker, so the items stay aligned.
    const marked = options.marked;
    const column = marked === undefined ? 0 : MARKER_WIDTH;
    const wrapped = filtered.map((item) => itemLines(item, Math.max(1, width - column)));
    const { start, end } = listWindow(wrapped, state.selected, maxRows);
    let budget = maxRows;
    draw: for (const [row, item] of wrapped.slice(start, end).entries()) {
      const index = start + row;
      const chosen = index === state.selected;
      const prefix =
        marked === undefined ? "" : index === marked ? ITEM_MARKER : " ".repeat(column);
      for (const line of item) {
        // A lone item taller than the window clips at the budget.
        if (budget-- === 0) break draw;
        const text = `${prefix}${line}`;
        lines.push(chosen ? `\x1b[7m${text}\x1b[0m` : text);
      }
    }
  }
  if (options.footer) lines.push(...wrapLine(options.footer, width));
  return lines;
}

/** What a screen draws with: the terminal size the runner reads at each draw. */
interface ScreenSize {
  rows: number;
  columns: number;
}

/** The two streams a screen runs on. */
interface ScreenStreams {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * The TTY loop every screen shares: draw, read keys in raw mode, hand each
 * key to the reducer, and resolve with the final state once `finished`
 * holds. The reducer decides every key; the renderer only draws.
 */
function runScreen<S>(
  initial: S,
  streams: ScreenStreams,
  step: (state: S, key: ListKey) => S,
  finished: (state: S) => boolean,
  draw: (state: S, size: ScreenSize) => string[],
): Promise<S> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  let state = initial;

  return new Promise((resolve) => {
    const render = (): void => {
      const lines = draw(state, { rows: output.rows ?? 24, columns: output.columns ?? 80 });
      output.write(`\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\r\n")}\x1b[J`);
    };

    const finish = (): void => {
      input.off("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
      resolve(state);
    };

    const onKeypress = (_str: string, key: ListKey): void => {
      state = step(state, key);
      if (finished(state)) finish();
      else render();
    };

    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    output.write("\x1b[2J\x1b[H\x1b[?25l");
    render();
  });
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
  const { input, output, ...rest } = options;
  return runScreen(
    initListState(items, { selected: options.selected }),
    {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    },
    reduceListKey,
    (state) => state.outcome.type !== "pending",
    (state, size) => renderListLines(state, size, rest),
  ).then((state) =>
    state.outcome.type === "chosen"
      ? { index: state.outcome.index, item: state.outcome.item }
      : null,
  );
}

/**
 * The model picker's two scopes (design D2): the models `enabledModels`
 * selects, and every model `pi --list-models` printed.
 */
export type PickerScope = "enabled" | "all";

/**
 * The picker wraps the list state: it holds both item arrays and the active
 * one, so Tab swaps the array under the same filter and selection rule.
 */
export interface PickerState {
  enabled: readonly string[];
  all: readonly string[];
  scope: PickerScope;
  /** The row's value before the picker opened: marked and selected when shown. */
  current?: string;
  list: ListState;
}

/** The picker's draw and stream options; the title names the row. */
export interface PickerDialogOptions {
  title?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** The item index the picker marks: the row's current value, when shown. */
export function pickerMarked(state: PickerState): number | undefined {
  if (state.current === undefined) return undefined;
  const index = state.list.items.indexOf(state.current);
  return index === -1 ? undefined : index;
}

/**
 * Open the picker on the enabled models, or on all models when the setting
 * selects none. The current value is marked and selected when the active
 * array holds it; otherwise the picker opens at the top.
 */
export function initPickerState(
  enabled: readonly string[],
  all: readonly string[],
  current?: string,
): PickerState {
  const scope: PickerScope = enabled.length > 0 ? "enabled" : "all";
  const items = scope === "enabled" ? enabled : all;
  return {
    enabled,
    all,
    scope,
    ...(current !== undefined ? { current } : {}),
    list: initListState(items, { selected: selectedInView(items, "", current) }),
  };
}

/**
 * One step of the picker: Tab swaps the item array (the filter stays, the
 * selection moves to the marked item or the top), and every other key is the
 * list's. Tab does nothing when `enabled` is empty.
 */
export function reducePickerKey(state: PickerState, key: ListKey): PickerState {
  if (state.list.outcome.type !== "pending") return state;
  if (key.name !== "tab") return { ...state, list: reduceListKey(state.list, key) };
  if (state.enabled.length === 0) return state;
  const scope: PickerScope = state.scope === "enabled" ? "all" : "enabled";
  const items = scope === "enabled" ? state.enabled : state.all;
  return {
    ...state,
    scope,
    list: {
      items,
      filter: state.list.filter,
      selected: selectedInView(items, state.list.filter, state.current),
      outcome: { type: "pending" },
    },
  };
}

/** The scope line under the picker: the active array and the Tab toggle. */
export function pickerScopeLine(state: PickerState): string {
  if (state.enabled.length === 0) return "all models";
  return state.scope === "enabled" ? "enabled models  tab: all" : "all models  tab: enabled";
}

/** The picker's draw lines: the list, with the scope line as its footer. */
export function renderPickerLines(
  state: PickerState,
  size: { rows: number; columns: number },
  options: PickerDialogOptions,
): string[] {
  const marked = pickerMarked(state);
  return renderListLines(state.list, size, {
    ...(options.title !== undefined ? { title: options.title } : {}),
    footer: pickerScopeLine(state),
    ...(marked !== undefined ? { marked } : {}),
  });
}

/**
 * Run the picker on a terminal: the list's keys plus Tab. Resolves with the
 * final state — a chosen or cancelled list outcome.
 */
export function chooseFromPicker(
  state: PickerState,
  options: PickerDialogOptions = {},
): Promise<PickerState> {
  const { input, output, ...rest } = options;
  return runScreen(
    state,
    {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    },
    reducePickerKey,
    (current) => current.list.outcome.type !== "pending",
    (current, size) => renderPickerLines(current, size, rest),
  );
}

/** One row of the role panel: the file's value and the value a save writes. */
export interface PanelRow {
  key: RoleKey;
  /** The value read from the file when the panel opened; null for absent. */
  file: string | null;
  /** The value a save writes; null for a removal. */
  staged: string | null;
}

/** Where the panel stands; `pending` keeps reading keys. */
export type PanelOutcome =
  { type: "pending" } | { type: "pick"; key: RoleKey } | { type: "save" } | { type: "discard" };

/** The role panel's state (design D2). */
export interface PanelState {
  role: string;
  source: RoleSource;
  /** False when `pi --list-models` failed: Enter opens no picker. */
  hasModels: boolean;
  rows: PanelRow[];
  selected: number;
  outcome: PanelOutcome;
}

/** The panel's draw and stream options: the footer facts the state lacks. */
export interface PanelDialogOptions {
  /** The user copy path a built-in role's save creates. */
  copyPath?: string;
  /** The `pi --list-models` error, drawn as the footer when there is no copy. */
  modelsError?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** The panel's key-hint line. */
const PANEL_HINT_LINE = "↑↓ move  ←→ thinking  enter pick  d clear  s save  esc discard";

/** The order the panel's `thinking` row cycles in: absent, then the levels. */
const THINKING_CYCLE: readonly (string | null)[] = [null, ...THINKING_LEVELS];

/** One step of the thinking cycle; an unknown value counts as absent. */
export function cycleThinking(value: string | null, step: number): string | null {
  const index = value === null ? 0 : THINKING_CYCLE.indexOf(value);
  const at = index === -1 ? 0 : index;
  const size = THINKING_CYCLE.length;
  return THINKING_CYCLE[(at + step + size) % size] ?? null;
}

/** The panel's rows in the fixed key order, with the file's values. */
export function initPanelState(args: {
  role: string;
  source: RoleSource;
  values: Pick<RoleInfo, "model" | "modelFallback" | "thinking">;
  hasModels: boolean;
}): PanelState {
  const values: Record<RoleKey, string | null> = {
    model: args.values.model ?? null,
    "model-fallback": args.values.modelFallback ?? null,
    thinking: args.values.thinking ?? null,
  };
  return {
    role: args.role,
    source: args.source,
    hasModels: args.hasModels,
    rows: (["model", "model-fallback", "thinking"] as const).map((key) => ({
      key,
      file: values[key],
      staged: values[key],
    })),
    selected: 0,
    outcome: { type: "pending" },
  };
}

/** Stage one row's value and clear the outcome, so the panel keeps reading. */
export function stagePanelValue(state: PanelState, key: RoleKey, value: string | null): PanelState {
  return {
    ...state,
    rows: state.rows.map((row) => (row.key === key ? { ...row, staged: value } : row)),
    outcome: { type: "pending" },
  };
}

/**
 * One step of the role panel: Up/Down move between rows, Left and Right
 * cycle the `thinking` row, Enter opens the picker on a model row (one
 * forward cycle on `thinking`), `d` stages a removal, `s` saves and Escape
 * discards.
 */
export function reducePanelKey(state: PanelState, key: ListKey): PanelState {
  if (state.outcome.type !== "pending") return state;
  const row = state.rows[state.selected]!;
  const plain = key.ctrl !== true && key.meta !== true;
  switch (key.name) {
    case "escape":
      return { ...state, outcome: { type: "discard" } };
    case "up":
      return { ...state, selected: Math.max(0, state.selected - 1) };
    case "down":
      return { ...state, selected: Math.min(state.rows.length - 1, state.selected + 1) };
    case "left":
      return row.key === "thinking"
        ? stagePanelValue(state, "thinking", cycleThinking(row.staged, -1))
        : state;
    case "right":
      return row.key === "thinking"
        ? stagePanelValue(state, "thinking", cycleThinking(row.staged, 1))
        : state;
    case "return":
    case "enter":
      if (row.key === "thinking") {
        return stagePanelValue(state, "thinking", cycleThinking(row.staged, 1));
      }
      return state.hasModels ? { ...state, outcome: { type: "pick", key: row.key } } : state;
    default:
      break;
  }
  if (plain && key.name === "d") return stagePanelValue(state, row.key, null);
  if (plain && key.name === "s") return { ...state, outcome: { type: "save" } };
  return state;
}

/** The staged changes a save writes, in the fixed key order. */
export function panelChanges(state: PanelState): Partial<Record<RoleKey, string | null>> {
  const changes: Partial<Record<RoleKey, string | null>> = {};
  for (const row of state.rows) {
    if (row.staged === row.file) continue;
    changes[row.key] = row.staged;
  }
  return changes;
}

/** The footer: a built-in role's copy notice, else the model list's error. */
function panelFooter(state: PanelState, options: PanelDialogOptions): string | undefined {
  if (state.source === "built-in" && options.copyPath !== undefined) {
    return `edits create a user copy: ${options.copyPath}`;
  }
  return options.modelsError;
}

/** The panel's draw lines: title, the three rows, the footer and the hints. */
export function renderPanelLines(
  state: PanelState,
  size: { rows: number; columns: number },
  options: PanelDialogOptions,
): string[] {
  const width = Math.max(1, size.columns);
  const lines: string[] = [...wrapLine(`${state.role}  [${state.source}]`, width)];
  for (const [index, row] of state.rows.entries()) {
    const mark = row.staged ?? ABSENT_MARK;
    const changed = row.staged !== row.file ? "  *" : "";
    const text = `  ${row.key.padEnd("model-fallback".length)} ${mark}${changed}`;
    for (const line of wrapLine(text, width)) {
      lines.push(index === state.selected ? `\x1b[7m${line}\x1b[0m` : line);
    }
  }
  const footer = panelFooter(state, options);
  if (footer !== undefined) lines.push(...wrapLine(footer, width));
  lines.push(...wrapLine(PANEL_HINT_LINE, width));
  return lines;
}

/**
 * Run the role panel on a terminal. Resolves with the final state: a `pick`
 * (the row's key), a `save`, or a `discard`.
 */
export function chooseFromPanel(
  state: PanelState,
  options: PanelDialogOptions = {},
): Promise<PanelState> {
  const { input, output, ...rest } = options;
  return runScreen(
    state,
    {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    },
    reducePanelKey,
    (current) => current.outcome.type !== "pending",
    (current, size) => renderPanelLines(current, size, rest),
  );
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
