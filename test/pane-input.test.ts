/**
 * The pane-input encoding: one line, no control bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePaneText } from "../pi-extension/pmux/pane-input.ts";

test("pane-input: a text without control characters comes back unchanged", () => {
  assert.equal(encodePaneText("PASS abc123"), "PASS abc123");
  assert.equal(encodePaneText(""), "");
  assert.equal(encodePaneText('a back\\slash and "quotes"'), 'a back\\slash and "quotes"');
  assert.equal(encodePaneText("naïve — ok 🎉"), "naïve — ok 🎉");
});

test("pane-input: a newline becomes a visible escape", () => {
  assert.equal(encodePaneText("line one\nline two"), "line one\\nline two");
  assert.equal(encodePaneText("\n"), "\\n");
  assert.equal(encodePaneText("a\nb\nc"), "a\\nb\\nc");
});

test("pane-input: a carriage return and a tab become visible escapes", () => {
  assert.equal(encodePaneText("one\r\ntwo"), "one\\r\\ntwo");
  assert.equal(encodePaneText("a\tb"), "a\\tb");
});

test("pane-input: another control character becomes a hex escape", () => {
  assert.equal(encodePaneText("bell\u0007"), "bell\\x07");
  assert.equal(encodePaneText("esc\u001b"), "esc\\x1b");
  assert.equal(encodePaneText("del\u007f"), "del\\x7f");
  assert.equal(encodePaneText("nul\u0000"), "nul\\x00");
});

test("pane-input: the encoded text holds no line terminator and no tab", () => {
  const encoded = encodePaneText("line one\r\nline two\tend\u0007");
  assert.ok(!encoded.includes("\n"));
  assert.ok(!encoded.includes("\r"));
  assert.ok(!encoded.includes("\t"));
  for (const character of encoded) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(code >= 0x20 && code !== 0x7f, `control byte in ${JSON.stringify(encoded)}`);
  }
});
