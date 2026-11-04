/**
 * Unit tests for the dialog list reducer (design D3) and the renderer's
 * wrapping, divided rows and windowing (popup-dialogs, "List rows divide
 * and wrap"). The renderer is a thin draw loop over the reducer.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filteredItems,
  initListState,
  itemLines,
  reduceListKey,
  renderListLines,
  wrapLine,
  type ListState,
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
});
