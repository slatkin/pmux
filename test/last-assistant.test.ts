/**
 * The last-assistant walk, shared by the sidebar's stop payload and the turn
 * notifier's outcome.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastAssistantMessage, stopFailureError } from "../pi-extension/pmux/last-assistant.ts";

describe("lastAssistantMessage", () => {
  it("takes the last assistant message's text", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "a " },
          { type: "text", text: "b" },
        ],
        stopReason: "stop",
      },
      { role: "user", content: [{ type: "text", text: "noise" }] },
    ];
    assert.deepEqual(lastAssistantMessage(messages), {
      text: "a b",
      stopReason: "stop",
      errorMessage: undefined,
    });
  });

  it("returns null without an assistant message", () => {
    assert.equal(lastAssistantMessage([{ role: "user", content: [] }]), null);
    assert.equal(lastAssistantMessage([]), null);
  });
});

describe("stopFailureError", () => {
  it("prefers pi's error message, then the stop reason", () => {
    assert.equal(stopFailureError({ text: "", stopReason: "error", errorMessage: "boom" }), "boom");
    assert.equal(stopFailureError({ text: "", stopReason: "error" }), "error");
    assert.equal(stopFailureError(null), "error");
  });
});
