/**
 * Unit tests for the dialog list reducer (design D3). The renderer is a
 * thin draw loop over the reducer, so the tests drive the reducer only.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filteredItems,
  initListState,
  reduceListKey,
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
