/**
 * Unit tests for the dialog screens (designs D2 and D7): the list reducer
 * and renderer, the word filter, the picker over two item arrays, and the
 * role panel with its staged edits. The renderer is a thin draw loop over
 * the reducers.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  chooseFromPanel,
  chooseFromPicker,
  cycleThinking,
  filteredItems,
  initListState,
  initPanelState,
  initPickerState,
  itemLines,
  panelChanges,
  pickerMarked,
  reduceListKey,
  reducePanelKey,
  reducePickerKey,
  renderListLines,
  renderPanelLines,
  stagePanelValue,
  wrapLine,
  type ListState,
  type PanelState,
  type PickerState,
} from "../pi-extension/pmux/dialog-ui.ts";

/** Feed one character per keypress, as readline reports them. */
function type(state: ListState, text: string): ListState {
  return [...text].reduce(
    (next, ch) => reduceListKey(next, { name: ch === " " ? "space" : ch, sequence: ch }),
    state,
  );
}

const ROLES = ["reviewer", "scout", "worker"];

describe("dialog list reducer", () => {
  it("starts pending with every item and the first row selected", () => {
    const state = initListState(ROLES);
    assert.equal(state.outcome.type, "pending");
    assert.deepEqual(filteredItems(state), ROLES);
    assert.equal(state.selected, 0);
  });

  it("moves the selection with Down and Up, clamped at both ends", () => {
    let state = initListState(ROLES);
    state = reduceListKey(state, { name: "down", sequence: "\u001b[B" });
    state = reduceListKey(state, { name: "down", sequence: "\u001b[B" });
    assert.equal(state.selected, 2);
    state = reduceListKey(state, { name: "down", sequence: "\u001b[B" });
    assert.equal(state.selected, 2);
    state = reduceListKey(state, { name: "up", sequence: "\u001b[A" });
    assert.equal(state.selected, 1);
  });

  it("narrows the list to the typed characters: `sc` shows only scout", () => {
    const state = type(initListState(ROLES), "sc");
    assert.deepEqual(filteredItems(state), ["scout"]);
    assert.equal(state.selected, 0);
  });

  it("matches the filter case-insensitively", () => {
    const state = type(initListState(ROLES), "SC");
    assert.deepEqual(filteredItems(state), ["scout"]);
  });

  it("keeps an item that contains every typed word", () => {
    const models = ["opencode-go/glm-5.3-flash", "opencode-go/glm-5.3", "devin/swe-2"];
    const state = type(initListState(models), "glm flash");
    assert.deepEqual(filteredItems(state), ["opencode-go/glm-5.3-flash"]);
  });

  it("drops repeated spaces from the word filter", () => {
    const models = ["opencode-go/glm-5.3-flash", "opencode-go/glm-5.3"];
    const state = type(initListState(models), " glm   flash ");
    assert.deepEqual(filteredItems(state), ["opencode-go/glm-5.3-flash"]);
  });

  it("opens on the given initial selection", () => {
    const state = initListState(ROLES, { selected: 2 });
    assert.equal(state.selected, 2);
    const chosen = reduceListKey(state, { name: "return", sequence: "\r" });
    assert.deepEqual(chosen.outcome, { type: "chosen", index: 2, item: "worker" });
  });

  it("puts the selection back at the top when a filter narrows the list", () => {
    const state = type(initListState(ROLES, { selected: 2 }), "sc");
    assert.equal(state.selected, 0);
  });

  it("widens the list again on Backspace", () => {
    let state = type(initListState(ROLES), "sc");
    assert.deepEqual(filteredItems(state), ["scout"]);
    state = reduceListKey(state, { name: "backspace", sequence: "" });
    assert.equal(state.filter, "s");
    assert.deepEqual(filteredItems(state), ["scout"]);
    state = reduceListKey(state, { name: "backspace", sequence: "" });
    assert.deepEqual(filteredItems(state), ROLES);
  });

  it("does nothing on Backspace with an empty filter", () => {
    const state = initListState(ROLES);
    assert.equal(reduceListKey(state, { name: "backspace", sequence: "" }), state);
  });

  it("chooses the selected row on Enter, with its index in items", () => {
    let state = type(initListState(ROLES), "worker");
    state = reduceListKey(state, { name: "return", sequence: "\r" });
    assert.deepEqual(state.outcome, { type: "chosen", index: 2, item: "worker" });
  });

  it("stays pending on Enter with no matching row", () => {
    let state = type(initListState(ROLES), "zzz");
    state = reduceListKey(state, { name: "return", sequence: "\r" });
    assert.equal(state.outcome.type, "pending");
  });

  it("cancels on Escape", () => {
    const state = reduceListKey(initListState(ROLES), { name: "escape", sequence: "\u001b" });
    assert.deepEqual(state.outcome, { type: "cancel" });
  });

  it("cancels on Ctrl-C", () => {
    const state = reduceListKey(initListState(ROLES), {
      name: "c",
      sequence: "\u0003",
      ctrl: true,
    });
    assert.deepEqual(state.outcome, { type: "cancel" });
  });

  it("latches the outcome: keys after Enter or Escape change nothing", () => {
    let state = reduceListKey(initListState(ROLES), { name: "escape", sequence: "\u001b" });
    const cancelled = state;
    state = reduceListKey(state, { name: "down", sequence: "\u001b[B" });
    state = type(state, "x");
    assert.equal(state, cancelled);

    state = reduceListKey(initListState(ROLES), { name: "return", sequence: "\r" });
    const chosen = state;
    state = reduceListKey(state, { name: "up", sequence: "\u001b[A" });
    assert.equal(state, chosen);
  });

  it("ignores modified and unnamed control keys", () => {
    const state = initListState(ROLES);
    assert.equal(reduceListKey(state, { name: "x", sequence: "x", meta: true }), state);
    assert.equal(reduceListKey(state, { name: "tab", sequence: "\t" }), state);
  });
});

describe("dialog list rendering", () => {
  it("keeps a line that fits the width whole", () => {
    assert.deepEqual(wrapLine("scout", 20), ["scout"]);
  });

  it("wraps a long line greedily on spaces", () => {
    assert.deepEqual(wrapLine("alpha beta gamma", 10), ["alpha beta", "gamma"]);
  });

  it("hard-splits a word longer than the width", () => {
    assert.deepEqual(wrapLine("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
  });

  it("splits a divided item on its embedded newlines and wraps each line", () => {
    assert.deepEqual(itemLines("scout  [built-in]\n  model: a very long model name here", 20), [
      "scout  [built-in]",
      "  model: a very long",
      "model name here",
    ]);
  });

  it("draws every line of the selected item in inverse video", () => {
    const state = initListState(["scout  [built-in]\n  model: a/x"]);
    const lines = renderListLines(state, { rows: 24, columns: 80 }, {});
    assert.deepEqual(lines, [
      "> ",
      "\x1b[7mscout  [built-in]\x1b[0m",
      "\x1b[7m  model: a/x\x1b[0m",
    ]);
  });

  it("wraps the title and footer lines", () => {
    const state = initListState(["a"]);
    const lines = renderListLines(
      state,
      { rows: 24, columns: 10 },
      {
        title: "pmux roles editor",
        footer: "edits create a user copy here",
      },
    );
    assert.deepEqual(lines, [
      "pmux roles",
      "editor",
      "> ",
      "\x1b[7ma\x1b[0m",
      "edits",
      "create a",
      "user copy",
      "here",
    ]);
  });

  it("shows only the whole items that fit the row budget", () => {
    const state = initListState(["one\nx", "two\nx", "three\nx"]);
    const lines = renderListLines(state, { rows: 6, columns: 80 }, { title: "t" });
    // Chrome: title plus filter leaves 4 rows; the first two items fit.
    assert.deepEqual(lines, ["t", "> ", "\x1b[7mone\x1b[0m", "\x1b[7mx\x1b[0m", "two", "x"]);
  });

  it("moves the window so a newly selected divided item shows whole", () => {
    let state = initListState(["one\nx", "two\nx", "three\nx"]);
    state = reduceListKey(state, { name: "down", sequence: "\x1b[B" });
    const lines = renderListLines(state, { rows: 6, columns: 80 }, { title: "t" });
    assert.deepEqual(lines, ["t", "> ", "one", "x", "\x1b[7mtwo\x1b[0m", "\x1b[7mx\x1b[0m"]);
    state = reduceListKey(state, { name: "down", sequence: "\x1b[B" });
    const last = renderListLines(state, { rows: 6, columns: 80 }, { title: "t" });
    assert.deepEqual(last, ["t", "> ", "two", "x", "\x1b[7mthree\x1b[0m", "\x1b[7mx\x1b[0m"]);
  });

  it("clips a lone item taller than the window", () => {
    const state = initListState(["a\nb\nc\nd\ne"]);
    const lines = renderListLines(state, { rows: 3, columns: 80 }, {});
    assert.deepEqual(lines, ["> ", "\x1b[7ma\x1b[0m", "\x1b[7mb\x1b[0m"]);
  });

  it("marks the marked item and keeps the column for every other row", () => {
    const state = initListState(["a", "b", "c"]);
    const lines = renderListLines(state, { rows: 24, columns: 80 }, { marked: 1 });
    assert.deepEqual(lines, ["> ", "\x1b[7m  a\x1b[0m", "● b", "  c"]);
  });

  it("keeps the mark on its item in the filtered view", () => {
    const state = type(initListState(["alpha", "beta", "gamma"]), "mm");
    const lines = renderListLines(state, { rows: 24, columns: 80 }, { marked: 2 });
    assert.deepEqual(lines, ["> mm", "\x1b[7m● gamma\x1b[0m"]);
  });

  it("follows the marked item when the filter drops earlier rows", () => {
    const state = type(initListState(["one", "two", "three"]), "t");
    const lines = renderListLines(state, { rows: 24, columns: 80 }, { marked: 2 });
    assert.deepEqual(lines, ["> t", "\x1b[7m  two\x1b[0m", "● three"]);
  });

  it("marks no row when the filter hides the marked item", () => {
    const state = type(initListState(["zz", "aa", "cc"]), "a");
    const lines = renderListLines(state, { rows: 24, columns: 80 }, { marked: 0 });
    assert.deepEqual(lines, ["> a", "\x1b[7maa\x1b[0m"]);
  });
});

describe("model picker reducer", () => {
  const ALL = ["devin/swe-2", "devin/gpt-6-astra", "claude-bridge/claude-opus-5-5"];
  const ENABLED = ["devin/gpt-6-astra", "claude-bridge/claude-opus-5-5"];

  const keyOf = (state: PickerState, key: Parameters<typeof reducePickerKey>[1]): PickerState =>
    reducePickerKey(state, key);

  it("opens on the enabled models in the setting's order", () => {
    const state = initPickerState(ENABLED, ALL);
    assert.equal(state.scope, "enabled");
    assert.deepEqual(state.list.items, ENABLED);
  });

  it("opens on all models when the setting selects none", () => {
    const state = initPickerState([], ALL);
    assert.equal(state.scope, "all");
    assert.deepEqual(state.list.items, ALL);
  });

  it("marks and selects the row's current value when it is shown", () => {
    const state = initPickerState(ENABLED, ALL, "claude-bridge/claude-opus-5-5");
    assert.equal(pickerMarked(state), 1);
    assert.equal(state.list.selected, 1);
    const chosen = reducePickerKey(state, { name: "return", sequence: "\r" });
    assert.deepEqual(chosen.list.outcome, {
      type: "chosen",
      index: 1,
      item: "claude-bridge/claude-opus-5-5",
    });
  });

  it("opens at the top when the value is not in the shown list", () => {
    const state = initPickerState(ENABLED, ALL, "not/listed");
    assert.equal(pickerMarked(state), undefined);
    assert.equal(state.list.selected, 0);
  });

  it("switches to all models on Tab and keeps the typed filter", () => {
    let state = initPickerState(ENABLED, ALL);
    state = [..."devin"].reduce(
      (next, ch) => reducePickerKey(next, { name: ch, sequence: ch }),
      state,
    );
    state = keyOf(state, { name: "tab", sequence: "\t" });
    assert.equal(state.scope, "all");
    assert.deepEqual(state.list.items, ALL);
    assert.equal(state.list.filter, "devin");
    assert.deepEqual(filteredItems(state.list), ["devin/swe-2", "devin/gpt-6-astra"]);
  });

  it("moves the selection back to the marked item on Tab", () => {
    let state = initPickerState(ENABLED, ALL, "claude-bridge/claude-opus-5-5");
    state = reducePickerKey(state, { name: "up", sequence: "\u001b[A" });
    state = reducePickerKey(state, { name: "down", sequence: "\u001b[B" });
    state = reducePickerKey(state, { name: "tab", sequence: "\t" });
    assert.equal(state.scope, "all");
    assert.equal(state.list.selected, 2);
  });

  it("does nothing on Tab when the enabled scope is empty", () => {
    const state = initPickerState([], ALL);
    assert.equal(reducePickerKey(state, { name: "tab", sequence: "\t" }), state);
  });

  it("keeps the list's Escape and Enter outcomes", () => {
    const escaped = reducePickerKey(initPickerState(ENABLED, ALL), {
      name: "escape",
      sequence: "\u001b",
    });
    assert.deepEqual(escaped.list.outcome, { type: "cancel" });
    const chosen = reducePickerKey(initPickerState(ENABLED, ALL), {
      name: "return",
      sequence: "\r",
    });
    assert.equal(chosen.list.outcome.type, "chosen");
  });
});

describe("role panel reducer", () => {
  const WORKER: { model?: string; modelFallback?: string; thinking?: string } = {
    model: "a/x",
    thinking: "high",
  };

  function panel(values = WORKER, hasModels = true): PanelState {
    return initPanelState({ role: "worker", source: "project", values, hasModels });
  }

  const RIGHT = { name: "right", sequence: "\u001b[C" };
  const LEFT = { name: "left", sequence: "\u001b[D" };
  const DOWN = { name: "down", sequence: "\u001b[B" };
  const UP = { name: "up", sequence: "\u001b[A" };
  const ENTER = { name: "return", sequence: "\r" };

  /** Walk the selection to the named row. */
  function select(state: PanelState, key: string): PanelState {
    const index = state.rows.findIndex((row) => row.key === key);
    return { ...state, selected: index };
  }

  it("shows one row per key with the file's values and no changed mark", () => {
    const state = panel();
    assert.deepEqual(
      state.rows.map((row) => [row.key, row.file, row.staged]),
      [
        ["model", "a/x", "a/x"],
        ["model-fallback", null, null],
        ["thinking", "high", "high"],
      ],
    );
    assert.deepEqual(panelChanges(state), {});
  });

  it("cycles the thinking row forward, with the changed mark and no write", () => {
    const state = reducePanelKey(select(panel(), "thinking"), RIGHT);
    assert.equal(state.rows[2]!.staged, "xhigh");
    assert.notEqual(state.rows[2]!.staged, state.rows[2]!.file);
  });

  it("wraps back to the absent mark after max", () => {
    assert.equal(cycleThinking("max", 1), null);
    assert.equal(cycleThinking(null, 1), "off");
    assert.equal(cycleThinking(null, -1), "max");
    const state = reducePanelKey(select(panel({ thinking: "max" }), "thinking"), RIGHT);
    assert.equal(state.rows[2]!.staged, null);
  });

  it("cycles the thinking row back with Left and forward with Enter", () => {
    const back = reducePanelKey(select(panel(), "thinking"), LEFT);
    assert.equal(back.rows[2]!.staged, "medium");
    const forward = reducePanelKey(select(panel(), "thinking"), ENTER);
    assert.equal(forward.rows[2]!.staged, "xhigh");
  });

  it("ignores Left and Right on a model row", () => {
    const state = panel();
    assert.equal(reducePanelKey(state, RIGHT), state);
    assert.equal(reducePanelKey(state, LEFT), state);
  });

  it("stages a removal on d and leaves the file value alone", () => {
    const state = panel({ modelFallback: "a/z" });
    const cleared = reducePanelKey(select(state, "model-fallback"), { name: "d", sequence: "d" });
    assert.equal(cleared.rows[1]!.file, "a/z");
    assert.equal(cleared.rows[1]!.staged, null);
    assert.deepEqual(panelChanges(cleared), { "model-fallback": null });
  });

  it("reports pick on a model row, and only when models exist", () => {
    const picked = reducePanelKey(panel(), ENTER);
    assert.deepEqual(picked.outcome, { type: "pick", key: "model" });
    assert.equal(reducePanelKey(panel(WORKER, false), ENTER).outcome.type, "pending");
  });

  it("stages a picked value and clears the pick outcome", () => {
    const picked = reducePanelKey(panel(), ENTER);
    const staged = stagePanelValue(picked, "model", "b/y");
    assert.deepEqual(staged.outcome, { type: "pending" });
    assert.equal(staged.rows[0]!.staged, "b/y");
    assert.notEqual(staged.rows[0]!.staged, staged.rows[0]!.file);
  });

  it("saves on s, discards on Escape and moves with Up and Down", () => {
    assert.deepEqual(reducePanelKey(panel(), { name: "s", sequence: "s" }).outcome, {
      type: "save",
    });
    assert.deepEqual(reducePanelKey(panel(), { name: "escape", sequence: "\u001b" }).outcome, {
      type: "discard",
    });
    assert.equal(reducePanelKey(panel(), DOWN).selected, 1);
    assert.equal(reducePanelKey(reducePanelKey(panel(), DOWN), DOWN).selected, 2);
    assert.equal(reducePanelKey(reducePanelKey(panel(), DOWN), UP).selected, 0);
  });

  it("writes every staged key in the fixed key order", () => {
    let state = select(panel(), "thinking");
    state = reducePanelKey(state, RIGHT);
    state = stagePanelValue(state, "model", "b/y");
    assert.deepEqual(panelChanges(state), { model: "b/y", thinking: "xhigh" });
    assert.deepEqual(Object.keys(panelChanges(state)), ["model", "thinking"]);
  });

  it("draws the title, the values, the absent mark, the changed mark and the hints", () => {
    let state = select(panel(), "thinking");
    state = reducePanelKey(state, RIGHT);
    const lines = renderPanelLines(state, { rows: 24, columns: 80 }, {});
    assert.deepEqual(lines.slice(0, 4), [
      "worker  [project]",
      "  model          a/x",
      "  model-fallback —",
      "\x1b[7m  thinking       xhigh  *\x1b[0m",
    ]);
    assert.match(lines.at(-1)!, /esc discard/);
  });

  it("draws the copy notice for a built-in role", () => {
    const state = initPanelState({
      role: "claude-code",
      source: "built-in",
      values: {},
      hasModels: true,
    });
    const lines = renderPanelLines(
      state,
      { rows: 24, columns: 120 },
      {
        copyPath: "/home/u/.pi/agent/agents/claude-code.md",
      },
    );
    assert.ok(lines.includes("edits create a user copy: /home/u/.pi/agent/agents/claude-code.md"));
  });

  it("draws the model list error when there is no copy notice", () => {
    const lines = renderPanelLines(
      panel(WORKER, false),
      { rows: 24, columns: 120 },
      {
        modelsError: "pi --list-models failed: no pi on PATH",
      },
    );
    assert.ok(lines.includes("pi --list-models failed: no pi on PATH"));
  });
});

describe("dialog screen runners", () => {
  /** A fake output stream that records every write and reports a size. */
  function fakeOutput(): {
    written: string[];
    rows: number;
    columns: number;
    write: (text: string) => boolean;
    isTTY: boolean;
  } {
    const fake = {
      written: [] as string[],
      rows: 24,
      columns: 80,
      isTTY: false,
      write: (text: string): boolean => {
        fake.written.push(text);
        return true;
      },
    };
    return fake;
  }

  /** The fake streams, as the screen options type them. */
  function streams(input: PassThrough, output: ReturnType<typeof fakeOutput>) {
    return {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    };
  }

  it("draws the panel's first frame and restores the cursor on finish", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const state = initPanelState({
      role: "worker",
      source: "project",
      values: { model: "a/x" },
      hasModels: true,
    });
    const pending = chooseFromPanel(state, streams(input, output));
    // The first clear-screen write, then the first frame.
    const first = output.written[1]!;
    assert.match(first, /worker {2}\[project\]/);
    assert.match(first, /model {10}a\/x/);
    input.emit("keypress", "\u001b", { name: "escape" });
    const finished = await pending;
    assert.deepEqual(finished.outcome, { type: "discard" });
    assert.equal(output.written.at(-1), "\x1b[?25h");
  });

  it("draws the picker's first frame with the scope line", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const state = initPickerState(["devin/swe-2"], ["devin/swe-2", "devin/x"], "devin/swe-2");
    const pending = chooseFromPicker(state, {
      ...streams(input, output),
      title: "worker: model",
    });
    const first = output.written[1]!;
    assert.match(first, /worker: model/);
    assert.match(first, /● devin\/swe-2/);
    assert.match(first, /enabled models {2}tab: all/);
    input.emit("keypress", "\r", { name: "return" });
    const finished = await pending;
    assert.equal(finished.list.outcome.type, "chosen");
  });
});
