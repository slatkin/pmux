/**
 * The reason vocabulary of an inbox attempt, host independent like
 * `channel-reason.ts`. The inbox writer (`report-inbox.ts`) and the delivery
 * flow name these reasons, and the receipt log reads them back, so the log
 * never imports the inbox writer to narrow an `inboxError`.
 */

/**
 * The reasons an inbox attempt ends without an entry (report-inbox, "Inbox
 * transport availability"): no inbox path, no live monitor, or a failed write.
 */
export const INBOX_REASONS = ["no-inbox", "unmonitored", "write-failed"] as const;

export type InboxUnavailableReason = (typeof INBOX_REASONS)[number];

/** True when `value` is one of the known `InboxUnavailableReason` strings. */
export function isInboxUnavailableReason(value: unknown): value is InboxUnavailableReason {
  return typeof value === "string" && (INBOX_REASONS as readonly string[]).includes(value);
}
