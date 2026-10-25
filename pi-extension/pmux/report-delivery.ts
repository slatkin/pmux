/**
 * The shared `file-ack-v1` submit-then-await-ack flow (designs D5, D6, D8) —
 * host independent except for the pane submission, which goes through the
 * tmux backend's verified report input.
 *
 * A report exists as a durable artifact and a `report` registration before
 * any pane input (`registerReport`); both `send` and the run wrapper's
 * no-report wake-up start there. The transport is `submitReportPointer`: a
 * fresh pointer is built for the attempt (same report ID, fresh visibility
 * token), offered to the parent's channel endpoint first (design D3), and —
 * when the channel is `unavailable`, whatever the reason — submitted through
 * `verifiedAgentPrompt` as the fallback. A `notification` event is recorded —
 * best effort — after a submission through either transport, naming the
 * transport that ran and, after a fallback, the channel's reason (design D5).
 * `awaitReportAck`
 * then polls the event log for the `ack`: `send` waits up to its
 * `--ack-timeout`, while the wrapper's exit re-delivery passes no timeout
 * and instead rechecks the ack immediately before each retry
 * (`reportAcknowledged`).
 */
import { encodePaneText } from "./pane-input.ts";
import { buildReportPointer, writeReportArtifact } from "./report-artifact.ts";
import {
  submitChannel,
  type ChannelSubmitResult,
  type ChannelUnavailableReason,
} from "./channel-endpoint.ts";
import { defaultSleep } from "./sleep.ts";
import {
  appendReportNotification,
  appendReportRegistration,
  readReportLog,
  type ReportVia,
} from "./report-receipt.ts";
import { verifiedAgentPrompt, type VerifiedPromptResult } from "./tmux.ts";

/** The interval the ack wait polls the event log at. */
export const REPORT_ACK_POLL_MS = 250;

/** Injected pieces of the delivery flow; the defaults are the real ones. */
export interface ReportDeliveryDeps {
  /**
   * Verified pane input; defaults to the tmux backend. The options carry the
   * injected poll timer and clock so tests can compress the token poll.
   */
  submit?: (
    pane: string,
    text: string,
    token: string,
    options: { sleep?: (ms: number) => Promise<void>; now?: () => number },
  ) => Promise<VerifiedPromptResult>;
  /** Poll timer; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll and deadline clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * The process environment the delivery runs in; defaults to `process.env`.
   * The channel client derives its endpoint from the same environment the
   * mode gate reads, so an injected env routes the channel too — never the
   * ambient one (the seam rule `PI_PMUX_SESSION` already follows).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The channel endpoint client; defaults to the real `submitChannel`. The
   * fallback only decides after this has answered (design D3).
   */
  submitChannel?: typeof submitChannel;
}

/** The transport one pointer submission reached the parent through. */
export type { ReportVia };

/** The registered artifact a report text becomes before any pane input. */
export interface RegisteredReportFile {
  /** The minted report ID. */
  id: string;
  /** The artifact path the pointer names. */
  reportPath: string;
  /** The UTF-8 byte length of the report text, for the log records. */
  bytes: number;
}

/**
 * Write `text` to a fresh artifact and append the `report` registration.
 * Both steps are required (design D2): the registration is what lets the run
 * wrapper recover the report file, so a failure here throws and the caller
 * must refuse the delivery before the pane is touched.
 */
export function registerReport(args: {
  sessionFile: string;
  to: string;
  text: string;
}): RegisteredReportFile {
  const { id, reportPath } = writeReportArtifact(args.sessionFile, args.text);
  const bytes = Buffer.byteLength(args.text, "utf8");
  const registered = appendReportRegistration(args.sessionFile, {
    id,
    to: args.to,
    bytes,
    report: reportPath,
  });
  if (!registered) {
    throw new Error(`could not register report ${id} in ${args.sessionFile}.sent`);
  }
  return { id, reportPath, bytes };
}

/** The arguments one pointer submission needs. */
export interface SubmitPointerArgs {
  /** The session file the log lives next to and the `ack` command names. */
  sessionFile: string;
  /** The pane the pointer is typed into. */
  to: string;
  /** The report ID; stable across re-deliveries. */
  id: string;
  /** The artifact path the pointer names. */
  reportPath: string;
  /** The UTF-8 byte length of the report text, for the `notification` record. */
  bytes: number;
  /** The package's `cli.ts` path, for the pointer's `ack` command. */
  cliPath: string;
}

/**
 * The outcome of one pointer submission. It reports the verified-input fields
 * shown to callers of the flow (`VerifiedPromptResult` without the `pane`,
 * which the flow consumes itself) plus the fields the flow adds.
 */
export type PointerSubmitResult = Pick<
  VerifiedPromptResult,
  "status" | "submitted" | "enterAttempted" | "error"
> & {
  /** The fresh visibility token this attempt ended its pointer with. */
  token: string;
  /**
   * Whether the post-submit `notification` event landed. Always false on a
   * refusal: the record means the pointer was submitted to the pane.
   */
  notificationRecorded: boolean;
  /** The transport the pointer reached the parent through (design D3). */
  via: ReportVia;
  /**
   * Why the channel was `unavailable`, present only after a fallback to the
   * verified input ran (design D3, D5).
   */
  channelError?: ChannelUnavailableReason;
};

/**
 * The transport fields a fallback result and its `notification` record
 * share: the tmux transport plus, after a channel that ran out, the reason.
 */
function tmuxTransportFields(channel: ChannelSubmitResult): {
  via: ReportVia;
  channelError?: ChannelUnavailableReason;
} {
  return {
    via: "tmux",
    ...(channel.reason !== undefined ? { channelError: channel.reason } : {}),
  };
}

/**
 * Build a fresh pointer for a registered report and submit it to the parent.
 * Every attempt mints a new visibility token while the report ID stays
 * stable, so a re-delivery can prove the new pointer appeared even when an
 * earlier one is still on screen.
 *
 * The channel goes first (design D3): an `emitted` result ends the attempt —
 * nothing is typed into the pane, whatever the later `ack` decides. Every
 * `unavailable` reason falls back to the verified pane input with the SAME
 * pointer, and the result then carries the channel's reason as
 * `channelError`. A missing or late `ack` is never a fallback: the ack wait
 * belongs to the caller, after one submission. A submission through either
 * transport appends the `notification` event — best effort, never fatal
 * (design D2).
 */
export async function submitReportPointer(
  args: SubmitPointerArgs,
  deps: ReportDeliveryDeps = {},
): Promise<PointerSubmitResult> {
  const submit = deps.submit ?? verifiedAgentPrompt;
  const pointer = buildReportPointer({
    id: args.id,
    reportPath: args.reportPath,
    sessionFile: args.sessionFile,
    cliPath: args.cliPath,
  });
  // The pointer is already one line; the encoding is the same rule `send`
  // applies to any text it types, kept in one place. The channel request
  // carries the exact text the verified input would type (design D4), so
  // both transports hold one pointer shape.
  const text = encodePaneText(pointer.text);
  const channel = await (deps.submitChannel ?? submitChannel)({
    to: args.to,
    id: args.id,
    text,
    bytes: args.bytes,
    token: pointer.token,
    // The endpoint path comes from the environment; the delivery's env is
    // the same lookup the mode gate reads, so an injected env routes the
    // channel too and a live pane's ambient `TMUX` cannot leak in.
    env: deps.env ?? process.env,
  });
  if (channel.status === "emitted") {
    const notificationRecorded = appendReportNotification(args.sessionFile, {
      id: args.id,
      token: pointer.token,
      to: args.to,
      bytes: args.bytes,
      report: args.reportPath,
      via: "channel",
    });
    return {
      status: "submitted",
      submitted: true,
      enterAttempted: true,
      token: pointer.token,
      notificationRecorded,
      via: "channel",
    };
  }
  const result = await submit(args.to, text, pointer.token, {
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (!result.submitted) {
    return {
      status: result.status,
      submitted: false,
      enterAttempted: result.enterAttempted,
      token: pointer.token,
      notificationRecorded: false,
      ...tmuxTransportFields(channel),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
  const notificationRecorded = appendReportNotification(args.sessionFile, {
    id: args.id,
    token: pointer.token,
    to: args.to,
    bytes: args.bytes,
    report: args.reportPath,
    ...tmuxTransportFields(channel),
  });
  return {
    status: "submitted",
    submitted: true,
    enterAttempted: true,
    token: pointer.token,
    notificationRecorded,
    ...tmuxTransportFields(channel),
  };
}

/** True when the event log holds an `ack` for the report ID. */
export function reportAcknowledged(sessionFile: string, id: string): boolean {
  return readReportLog(sessionFile).ackedIds.has(id);
}

/**
 * Poll the event log every 250 ms for an `ack` of the report ID, for up to
 * `timeoutSeconds` seconds (design D6). `0` means one immediate check with
 * no sleep. A timeout is not a failure: it resolves `false`.
 */
export async function awaitReportAck(
  args: { sessionFile: string; id: string; timeoutSeconds: number },
  deps: ReportDeliveryDeps = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  if (reportAcknowledged(args.sessionFile, args.id)) return true;
  if (args.timeoutSeconds <= 0) return false;
  const deadline = now() + args.timeoutSeconds * 1000;
  while (now() < deadline) {
    await sleep(Math.min(REPORT_ACK_POLL_MS, deadline - now()));
    if (reportAcknowledged(args.sessionFile, args.id)) return true;
  }
  return false;
}

/** The arguments of one delivery: a submission plus an optional ack wait. */
export interface DeliverReportArgs extends SubmitPointerArgs {
  /**
   * Seconds to wait for the `ack` after a submission (`send`'s
   * `--ack-timeout`; `0` checks once). Omitted means no wait at all — the
   * wrapper's exit re-delivery (design D8), which rechecks the ack itself
   * before each retry.
   */
  ackTimeoutSeconds?: number;
}

/** The outcome of one delivery. */
export interface DeliverReportResult extends PointerSubmitResult {
  /**
   * Whether an `ack` for the report ID was seen within the wait. Always
   * false for a refused submission and for a no-wait delivery.
   */
  acknowledged: boolean;
}

/**
 * Submit a registered report's pointer and wait for its `ack`. This is the
 * flow `send` runs after `registerReport` (design D6) and the run wrapper
 * runs for each unacknowledged current-run report at exit — same ID, fresh
 * token, no `ackTimeoutSeconds` (design D8).
 */
export async function deliverReport(
  args: DeliverReportArgs,
  deps: ReportDeliveryDeps = {},
): Promise<DeliverReportResult> {
  const submission = await submitReportPointer(args, deps);
  if (!submission.submitted || args.ackTimeoutSeconds === undefined) {
    return { ...submission, acknowledged: false };
  }
  const acknowledged = await awaitReportAck(
    { sessionFile: args.sessionFile, id: args.id, timeoutSeconds: args.ackTimeoutSeconds },
    deps,
  );
  return { ...submission, acknowledged };
}
