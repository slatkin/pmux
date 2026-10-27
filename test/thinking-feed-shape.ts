/**
 * Shared assertion helper for the thinking feed's records, used by the
 * producer tests and the wiring tests.
 *
 * A record's text is absent when the phase carried none (a `start`, an
 * empty `end`), so the compact form names the kind alone then, and
 * `<kind>:<text>` when text is present.
 */
import type { ThinkingFeedRecord } from "../pi-extension/pmux/thinking-feed.ts";

/** The kinds and texts of the records, for compact assertions. */
export function feedShape(records: ThinkingFeedRecord[]): string[] {
  return records.map((record) =>
    record.text === undefined ? record.kind : `${record.kind}:${record.text}`,
  );
}
