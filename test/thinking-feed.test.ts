/**
 * The thinking feed's file and its coalescing producer.
 *
 * The producer's append and timer are injected, so the tests drive it
 * without a real feed file; the file tests use a temporary runtime
 * directory, so the path layout is exercised as production resolves it.
 */
import "./host-env.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createThinkingFeedProducer,
  THINKING_FLUSH_MS,
  type ThinkingFeedRecord,
  type ThinkingFeedTimer,
  type ThinkingFeedTimerHandle,
} from "../pi-extension/pmux/thinking-feed.ts";
import {
  appendThinkingFeedRecord,
  ensureThinkingFeed,
  thinkingFeedPath,
} from "../pi-extension/pmux/thinking-feed-file.ts";

/** A feed that keeps its records in memory, and a clock that moves per read. */
function fakeProducer() {
  const records: ThinkingFeedRecord[] = [];
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++)).toISOString();
  const { timer, fire, state, isArmed } = fakeTimer();
  const producer = createThinkingFeedProducer({
    append: (record) => records.push(record),
    timer,
    now,
  });
  return { records, producer, fire, state, isArmed };
}

/** A timer whose armed callback the test fires by hand. */
function fakeTimer() {
  const state = { armed: 0, cancelled: 0 };
  let callback: (() => void) | null = null;
  const timer: ThinkingFeedTimer = {
    set: (next, ms) => {
      assert.equal(ms, THINKING_FLUSH_MS);
      state.armed++;
      callback = next;
      const handle: ThinkingFeedTimerHandle = {
        cancel: () => {
          state.cancelled++;
          if (callback === next) callback = null;
        },
      };
      return handle;
    },
  };
  return {
    timer,
    fire: () => {
      const next = callback;
      callback = null;
      next?.();
    },
    state,
    isArmed: () => callback !== null,
  };
}

/** The kinds and texts of the records, for compact assertions. */
function shape(records: ThinkingFeedRecord[]): string[] {
  return records.map((record) =>
    record.text === undefined ? record.kind : `${record.kind}:${record.text}`,
  );
}

describe("the thinking feed path", () => {
  test("the runtime directory vector both repositories pin", () => {
    // The same vector pmux-explorer pins: `/run/user/1000`, `abc`.
    assert.equal(
      thinkingFeedPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, sessionId: "abc" }),
      "/run/user/1000/pmux-thinking/abc.jsonl",
    );
  });

  test("the /tmp fallback names the uid", () => {
    assert.equal(
      thinkingFeedPath({ env: {}, sessionId: "abc", uid: 1000 }),
      "/tmp/pmux-thinking-1000/abc.jsonl",
    );
    // An empty XDG_RUNTIME_DIR reads as unset.
    assert.equal(
      thinkingFeedPath({ env: { XDG_RUNTIME_DIR: "" }, sessionId: "abc", uid: 1000 }),
      "/tmp/pmux-thinking-1000/abc.jsonl",
    );
  });

  test("a session id that could leave the directory is rejected", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    assert.equal(thinkingFeedPath({ env, sessionId: "../x" }), null);
    assert.equal(thinkingFeedPath({ env, sessionId: "a/b" }), null);
    assert.equal(thinkingFeedPath({ env, sessionId: ".." }), null);
    assert.equal(thinkingFeedPath({ env, sessionId: "." }), null);
    assert.equal(thinkingFeedPath({ env, sessionId: "" }), null);
  });
});

describe("the thinking feed file", () => {
  test("ensure leaves a 0600 file in a 0700 directory", () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-feed-"));
    const env = { XDG_RUNTIME_DIR: runtime };
    try {
      // A fresh feed directory: created private.
      const fresh = thinkingFeedPath({ env, sessionId: "fresh" });
      assert.ok(fresh);
      ensureThinkingFeed(fresh);
      assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);

      // The directory may have been created first with the default mode;
      // the ensure still makes it private.
      const existing = thinkingFeedPath({ env, sessionId: "existing" });
      assert.ok(existing);
      fs.mkdirSync(path.dirname(existing), { recursive: true, mode: 0o755 });
      fs.chmodSync(path.dirname(existing), 0o755);
      assert.equal(fs.statSync(path.dirname(existing)).mode & 0o777, 0o755);
      ensureThinkingFeed(existing);
      assert.equal(fs.statSync(path.dirname(existing)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(existing).mode & 0o777, 0o600);

      // A file that already exists with a wider mode is made private too.
      const wider = thinkingFeedPath({ env, sessionId: "wider" });
      assert.ok(wider);
      fs.mkdirSync(path.dirname(wider), { recursive: true });
      fs.writeFileSync(wider, "", { mode: 0o644 });
      fs.chmodSync(wider, 0o644);
      ensureThinkingFeed(wider);
      assert.equal(fs.statSync(wider).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });

  test("ensure and append refuse a feed directory another uid owns", () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-feed-"));
    const env = { XDG_RUNTIME_DIR: runtime };
    const ownedUid = typeof process.getuid === "function" ? process.getuid() : 0;
    // A uid other than this process's stands for another account that
    // created the directory first: its entries are not ours to write.
    const foreignUid = ownedUid + 1;
    try {
      const file = thinkingFeedPath({ env, sessionId: "foreign" });
      assert.ok(file);
      ensureThinkingFeed(file, foreignUid);
      // The directory exists, so the check ran against a real directory,
      // and the refused feed holds neither a created nor an appended file.
      assert.equal(fs.existsSync(path.dirname(file)), true);
      assert.equal(fs.existsSync(file), false);

      // The owned directory still gets its feed.
      ensureThinkingFeed(file, ownedUid);
      assert.equal(fs.existsSync(file), true);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);

      // The append entry refuses the same directory, so a directory made
      // writable by another account receives no record even though this
      // process can write in it.
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o666);
      appendThinkingFeedRecord(file, { kind: "start", ts: "t", producer: "p" }, foreignUid);
      assert.equal(fs.readFileSync(file, "utf8"), "");

      // The owned directory gets the record.
      appendThinkingFeedRecord(file, { kind: "start", ts: "t", producer: "p" }, ownedUid);
      assert.deepEqual(
        fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
        ["start"],
      );
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });

  test("append writes one JSON line per record", () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-feed-"));
    const env = { XDG_RUNTIME_DIR: runtime };
    try {
      const file = thinkingFeedPath({ env, sessionId: "s" });
      assert.ok(file);
      ensureThinkingFeed(file);
      appendThinkingFeedRecord(file, { kind: "start", ts: "t", producer: "p" });
      appendThinkingFeedRecord(file, { kind: "end", ts: "t", producer: "p", text: "done" });
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.deepEqual(
        lines.map((line) => JSON.parse(line).kind),
        ["start", "end"],
      );
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });
});

describe("the thinking feed producer", () => {
  test("start and end are synchronous, deltas coalesce, and a pending buffer is flushed first", () => {
    const { records, producer, fire, state } = fakeProducer();

    // A burst of deltas: one pending buffer, stamped with the first delta.
    producer.delta("A");
    producer.delta("B");
    assert.deepEqual(records, []);
    fire();
    assert.deepEqual(shape(records), ["delta:AB"]);
    assert.equal(records[0]!.ts, new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString());

    // The start and the end are written without waiting for the timer.
    producer.started();
    producer.delta("C");
    producer.ended("");
    assert.deepEqual(shape(records), ["delta:AB", "start", "delta:C", "end"]);
    // An empty end is written without text, so it cannot wipe the block.
    assert.equal(records[3]!.text, undefined);

    // An aborted run's pending deltas stay in that run: the new start
    // follows its own delta record.
    producer.started();
    producer.delta("D");
    producer.delta("E");
    producer.started();
    assert.deepEqual(shape(records).slice(4), ["start", "delta:DE", "start"]);

    // An end with content carries its text.
    producer.delta("F");
    producer.ended("FINAL");
    assert.deepEqual(shape(records).slice(7), ["delta:F", "end:FINAL"]);

    // The pending delta was stamped with its arrival, not with the flush.
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();
    assert.equal(records[5]!.ts, at(5));
    assert.equal(records[6]!.ts, at(6));
    assert.equal(records[7]!.ts, at(7));
    assert.equal(records[8]!.ts, at(8));

    // The producer token is drawn once and on every record.
    const producerTokens = new Set(records.map((record) => record.producer));
    assert.equal(producerTokens.size, 1);
    assert.ok([...producerTokens][0]);
    // The timer was armed for each burst; every flush but the fired one
    // cancelled its timer.
    assert.equal(state.armed, 4);
    assert.equal(state.cancelled, 3);
  });

  test("an empty delta writes nothing and arms no timer", () => {
    const { records, producer, state, isArmed } = fakeProducer();
    producer.delta("");
    assert.deepEqual(records, []);
    assert.equal(state.armed, 0);
    assert.equal(isArmed(), false);
  });

  test("closing flushes a dirty pending buffer once and cancels the timer", () => {
    const { records, producer, fire, state, isArmed } = fakeProducer();

    producer.delta("last words");
    assert.equal(isArmed(), true);
    producer.close();
    assert.deepEqual(shape(records), ["delta:last words"]);
    assert.equal(state.cancelled, 1);
    assert.equal(isArmed(), false);

    // A closed producer has nothing left to flush, and no timer to fire.
    producer.close();
    fire();
    assert.deepEqual(shape(records), ["delta:last words"]);
    assert.equal(state.armed, 1);
  });
});
