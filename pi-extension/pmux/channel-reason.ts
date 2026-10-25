/**
 * The reason vocabulary of a channel attempt — the module both sides of the
 * `.sent` log share, host independent like `report-receipt.ts`. The endpoint
 * client (`channel-endpoint.ts`), the receipt log and the delivery flow all
 * import the reason type and its guard from here, so no reader of the log
 * ever needs the socket client to narrow a `channelError`.
 */

/**
 * The reasons a channel attempt can end without a delivery, in the order the
 * spec lists them (report-channel, "Channel result classes"). `no-endpoint`,
 * `refused`, `timeout` and `bad-reply` are the client's own; `unarmed`,
 * `write-failed` and `invalid` come from the endpoint itself. The union is
 * derived from this array, so a reason added here is a reason everywhere —
 * a list that drifts from the vocabulary is a compile error, not a silent
 * strip of `channelError` on read-back.
 */
export const CHANNEL_REASONS = [
  "no-endpoint",
  "refused",
  "timeout",
  "unarmed",
  "write-failed",
  "invalid",
  "bad-reply",
] as const;

export type ChannelUnavailableReason = (typeof CHANNEL_REASONS)[number];

/** True when `value` is one of the known `ChannelUnavailableReason` strings. */
export function isChannelUnavailableReason(value: unknown): value is ChannelUnavailableReason {
  return typeof value === "string" && (CHANNEL_REASONS as readonly string[]).includes(value);
}
