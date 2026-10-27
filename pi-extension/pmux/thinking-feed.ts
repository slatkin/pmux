/**
 * The thinking feed: the session's reasoning text, written for the
 * sidebar's Thought tab to read. Lifted from johnny-cant-read's producer
 * with its record shape and timing unchanged (design D1).
 *
 * The producer writes raw text: thinking is prose whose wrapping belongs
 * to the reader's width, which the producer does not know. One record is
 * one phase of a thinking block. Deltas are coalesced and appended at
 * most once per 50 ms, while a block's start and end are written at
 * once. `thinking-feed-file.ts` owns the feed's path and the writes.
 */
import { randomUUID } from "node:crypto";

/** One record of the feed: one phase of a thinking block. */
export interface ThinkingFeedRecord {
  /** The phase: the block opens, grows, or completes. */
  kind: "start" | "delta" | "end";
  /** The wall-clock time the producer observed the phase, as an ISO string. */
  ts: string;
  /** The producer that wrote the record, drawn once when the producer is built. */
  producer: string;
  /**
   * The phase's text. A `start` carries none; an `end` carries the final
   * content when pi delivered a non-empty one.
   */
  text?: string;
}

/** How often the pending deltas are appended at most, in milliseconds. */
export const THINKING_FLUSH_MS = 50;

/** An armed flush. The timer that armed it owns the handle. */
export interface ThinkingFeedTimerHandle {
  /** Cancel the armed flush. */
  cancel(): void;
}

/** The timer the coalesced flush runs on. */
export interface ThinkingFeedTimer {
  /** Arm a callback to run once after `ms`, and return a handle for it. */
  set(callback: () => void, ms: number): ThinkingFeedTimerHandle;
}

/** The timer of a real session: one trailing timeout per flush. */
const SYSTEM_TIMER: ThinkingFeedTimer = {
  set(callback, ms) {
    const timeout = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(timeout) };
  },
};

export interface ThinkingFeedProducerDeps {
  /** Append one record to the feed. */
  append(record: ThinkingFeedRecord): void;
  /** The timer the coalesced flush runs on; the system timer by default. */
  timer?: ThinkingFeedTimer;
  /** The wall-clock time of a record, as an ISO string; the system clock by default. */
  now?: () => string;
}

export interface ThinkingFeedProducer {
  /** A thinking block started: the `start` record is written at once. */
  started(): void;
  /** A delta arrived: it joins the pending buffer until the next flush. */
  delta(text: string): void;
  /** A thinking block ended: the pending deltas, then the `end` record. */
  ended(content: string): void;
  /** The session ends: the pending deltas are appended once and the timer is cancelled. */
  close(): void;
}

/**
 * Build the feed's producer. The producer token is drawn once here, so two
 * processes writing one session's feed keep their blocks apart.
 */
export function createThinkingFeedProducer(deps: ThinkingFeedProducerDeps): ThinkingFeedProducer {
  const producer = randomUUID();
  const timer = deps.timer ?? SYSTEM_TIMER;
  const now = deps.now ?? (() => new Date().toISOString());

  /** The deltas not yet appended, with the time of the first of them. */
  let pending: { text: string; ts: string } | null = null;
  /** The armed flush, while one is armed. */
  let handle: ThinkingFeedTimerHandle | null = null;

  function write(kind: ThinkingFeedRecord["kind"], ts: string, text?: string): void {
    const record: ThinkingFeedRecord = { kind, ts, producer };
    if (text !== undefined) record.text = text;
    deps.append(record);
  }

  /**
   * Append a dirty pending buffer as its own `delta` record, stamped with
   * the time of the first buffered delta, and cancel the timer.
   */
  function flushPending(): void {
    if (handle !== null) {
      handle.cancel();
      handle = null;
    }
    const buffered = pending;
    pending = null;
    if (buffered !== null) write("delta", buffered.ts, buffered.text);
  }

  return {
    started() {
      // Flushing first keeps an aborted run's last deltas in that run
      // instead of assigning them to the new block.
      flushPending();
      write("start", now());
    },

    delta(text) {
      if (text === "") return;
      if (pending === null) pending = { text, ts: now() };
      else pending.text += text;
      // One trailing timeout per flush: at most one append per interval.
      handle ??= timer.set(() => {
        handle = null;
        flushPending();
      }, THINKING_FLUSH_MS);
    },

    ended(content) {
      // Flushing first lets the reader finalize exactly the accumulated
      // text when the end carries none.
      flushPending();
      // An empty end is written without `text`: absent text means "no
      // content", and an empty payload must not wipe the block.
      write("end", now(), content === "" ? undefined : content);
    },

    close() {
      // The last text of a run is not lost when the session goes away.
      flushPending();
    },
  };
}
