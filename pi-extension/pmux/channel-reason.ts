/**
 * The reason vocabulary of a channel attempt — the module both sides of the
 * `.sent` log share, host independent like `report-receipt.ts`. The endpoint
 * client (`channel-endpoint.ts`), the receipt log and the delivery flow all
 * import the reason type and its guard from here, so no reader of the log
 * ever needs the socket client to narrow a `channelError`.
 */

/**
 * The reasons a channel attempt can end without a delivery. `no-endpoint`,
 * `refused`, `timeout` and `bad-reply` are the client's own; `unarmed`,
 * `write-failed` and `invalid` come from the endpoint itself.
 */
export type ChannelUnavailableReason =
  "no-endpoint" | "refused" | "timeout" | "unarmed" | "write-failed" | "invalid" | "bad-reply";

/**
 * The reasons this vocabulary names, in the order the spec lists them
 * (report-channel, "Channel result classes"). Keep in step with the union
 * above: a reason missing here strips `channelError` on read-back.
 */
export const CHANNEL_REASONS: readonly ChannelUnavailableReason[] = [
  "no-endpoint",
  "refused",
  "timeout",
  "unarmed",
  "write-failed",
  "invalid",
  "bad-reply",
];

/** True when `value` is one of the known `ChannelUnavailableReason` strings. */
export function isChannelUnavailableReason(value: unknown): value is ChannelUnavailableReason {
  return typeof value === "string" && (CHANNEL_REASONS as readonly string[]).includes(value);
}
