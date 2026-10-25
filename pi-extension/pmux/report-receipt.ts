/**
 * The `<session file>.sent` report event log — host independent, like
 * `exit-sidecar.ts` and `status-file.ts`.
 *
 * Under the legacy protocol a send-mode child delivers its report with the
 * `send` subcommand, which appends one kindless JSON line per delivered
 * report. The pane-side wrapper counts the lines addressed to the parent to
 * decide whether it must wake the parent, so the count does not depend on
 * how the child quoted the send invocation.
 *
 * Under `file-ack-v1` the file is an append-only event log with three record
 * kinds. `report` registers the artifact before transport — it is what lets
 * the wrapper recover the report file — and carries `id`, `to`, `bytes` and
 * the `report` path. `notification` records that a pointer was submitted to
 * the pane and adds the visibility `token` and the transport `via`; it means
 * only that the parent received the pointer — through the channel endpoint
 * (`via:"channel"`) or through the verified pane input (`via:"tmux"`, with
 * `channelError` naming why the channel fell back). `ack` (`id` only, no
 * `to`) is the sole read receipt. The two
 * protocols share the one file: a kindless line with a string `to` stays a
 * valid legacy notification with no ID and no ack semantics. Readers skip
 * malformed lines and unknown kinds. Both sides read and write the file
 * through this module, so the name and the record shapes live in one place.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { type ChannelUnavailableReason, isChannelUnavailableReason } from "./channel-reason.ts";

/** The suffix the receipt file carries next to the session file. */
export const REPORT_RECEIPT_SUFFIX = ".sent";

/** The transport a `notification` record names (design D5). */
export type ReportVia = "channel" | "tmux";

/** One delivered report under the legacy protocol (a kindless line). */
export interface ReportReceipt {
  /** ISO time of the delivery. */
  at: string;
  /** The pane the report was typed into. */
  to: string;
  /** Length of the delivered text in UTF-8 bytes. */
  bytes: number;
}

/** The fields of a `report` record beyond `at` and `kind`. */
export interface ReportRegistration {
  /** The report ID the artifact was written under. */
  id: string;
  /** The pane the pointer is typed into. */
  to: string;
  /** Length of the report text in UTF-8 bytes. */
  bytes: number;
  /** The artifact path the pointer names. */
  report: string;
}

/** The fields of a `notification` record beyond `at` and `kind`. */
export interface PointerNotification {
  /** The report ID the pointer names. */
  id: string;
  /** The visibility token this attempt ended with. */
  token: string;
  /** The pane the pointer was typed into. */
  to: string;
  /** Length of the report text in UTF-8 bytes. */
  bytes: number;
  /** The artifact path the pointer names. */
  report: string;
  /** The transport the pointer was submitted through. */
  via: ReportVia;
  /** Why the channel was unavailable; set only after a fallback (design D5). */
  channelError?: ChannelUnavailableReason;
}

/** A `report` record read back from the log. */
export interface RegisteredReport extends ReportRegistration {
  /** ISO time of the registration, when the writer recorded it. */
  at?: string;
}

/** A notification read back: a `notification` record, or a legacy kindless line. */
export interface LoggedNotification {
  /** The pane the notification or report was typed into. */
  to: string;
  /** The report ID a `notification` record carries; a legacy line has none. */
  id?: string;
  /** The visibility token a `notification` record carries. */
  token?: string;
  /** Length of the delivered text in UTF-8 bytes. */
  bytes?: number;
  /** The artifact path a `notification` record names. */
  report?: string;
  /**
   * The transport the notification went out on. A record written before this
   * field existed reads as `tmux` — it was, and the default keeps every old
   * log truthful (design D5).
   */
  via: ReportVia;
  /** Why the channel fell back; present only on a fallback record. */
  channelError?: ChannelUnavailableReason;
  /** ISO time of the record, when the writer recorded it. */
  at?: string;
}

/** The events one session's log holds. */
export interface ReportLogState {
  /** `report` registrations, in file order. */
  reports: RegisteredReport[];
  /**
   * `notification` records and legacy kindless lines, in file order. A
   * legacy line carries no `id`, so it can never be re-delivered or acked.
   */
  notifications: LoggedNotification[];
  /**
   * Report IDs with at least one `ack` record. Concurrent `ack` commands may
   * append a duplicated line, so the reader keeps set semantics.
   */
  ackedIds: Set<string>;
}

/** The receipt file next to a session file. */
export function reportReceiptPath(sessionFile: string): string {
  return `${sessionFile}${REPORT_RECEIPT_SUFFIX}`;
}

/** Append one JSON line; reports whether it was written. Never throws. */
function appendEvent(sessionFile: string, record: Record<string, unknown>): boolean {
  try {
    appendFileSync(reportReceiptPath(sessionFile), `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one kindless receipt line, the legacy record. Never throws: the
 * delivery already happened, and a lost receipt only costs the parent a
 * spurious wake-up. It reports whether the line was written, so the caller
 * can tell a receipt from no receipt.
 */
export function appendReportReceipt(sessionFile: string, receipt: ReportReceipt): boolean {
  return appendEvent(sessionFile, { ...receipt });
}

/**
 * Append the `report` record that registers a new artifact before transport.
 * Unlike every other write here this one is required: the registration is
 * what lets the run wrapper recover the report file, so a caller whose
 * registration failed must refuse the send before the pane is touched.
 * Reports whether the line landed.
 */
export function appendReportRegistration(
  sessionFile: string,
  registration: ReportRegistration,
): boolean {
  return appendEvent(sessionFile, {
    ...registration,
    at: new Date().toISOString(),
    kind: "report",
  });
}

/**
 * Append a `notification` record after a pointer was submitted. Best effort:
 * a lost notification record never fails the send it describes. Reports
 * whether the line landed.
 */
export function appendReportNotification(
  sessionFile: string,
  notification: PointerNotification,
): boolean {
  return appendEvent(sessionFile, {
    ...notification,
    at: new Date().toISOString(),
    kind: "notification",
  });
}

/**
 * Append an `ack` record — the only read receipt. It carries no `to`, so it
 * can never be mistaken for a delivered report. Unlike the notification
 * write a failed append is operational failure: the caller must not claim
 * success without it. Reports whether the line landed.
 */
export function appendReportAck(sessionFile: string, id: string): boolean {
  return appendEvent(sessionFile, {
    at: new Date().toISOString(),
    kind: "ack",
    id,
  });
}

/**
 * Parse one log line into a plain object, or null when it is not a JSON
 * object. A malformed line proves nothing about the session: skip it.
 */
function parseLogLine(line: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(line);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The pane a parsed record was delivered to as a legacy receipt, or null when
 * it names none — the rule in one place, shared by `foldRecord` and the
 * receipt count. A legacy delivery is a kindless line with a string `to`: a
 * record delivered under the pre-`file-ack-v1` protocol. Every record that
 * carries a `kind` — a `report` registration, a `notification` record or an
 * `ack` — is an event-log entry, never a legacy delivery, so a `report` line
 * with a `to` must not pass as a delivered report.
 */
function legacyReceiptTarget(record: Record<string, unknown>): string | null {
  if (record.kind !== undefined) return null;
  return typeof record.to === "string" ? record.to : null;
}

/** Fold one parsed record into the session's log state. */
function foldRecord(record: Record<string, unknown>, state: ReportLogState): void {
  const at = typeof record.at === "string" ? record.at : undefined;
  // A legacy delivery is the one kindless shape that reaches the
  // notifications: the rule lives in `legacyReceiptTarget`, which the kind
  // checks below never need to restate.
  const to = legacyReceiptTarget(record);
  if (to !== null) {
    state.notifications.push({
      to,
      // A legacy delivery went out through the verified pane input; the
      // default is the same rule the `notification` branch applies below.
      via: "tmux",
      ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
      ...(at !== undefined ? { at } : {}),
    });
    return;
  }
  if (record.kind === "report") {
    if (
      typeof record.id === "string" &&
      typeof record.to === "string" &&
      typeof record.bytes === "number" &&
      typeof record.report === "string"
    ) {
      state.reports.push({
        id: record.id,
        to: record.to,
        bytes: record.bytes,
        report: record.report,
        ...(at !== undefined ? { at } : {}),
      });
    }
    return;
  }
  if (record.kind === "notification") {
    if (
      typeof record.id === "string" &&
      typeof record.token === "string" &&
      typeof record.to === "string" &&
      typeof record.bytes === "number" &&
      typeof record.report === "string"
    ) {
      state.notifications.push({
        id: record.id,
        token: record.token,
        to: record.to,
        bytes: record.bytes,
        report: record.report,
        // A record without `via`, or with a value this reader does not know,
        // reads as the tmux transport (design D5): the field is additive, so
        // an older log line was a verified-input delivery.
        via: record.via === "channel" ? "channel" : "tmux",
        ...(isChannelUnavailableReason(record.channelError)
          ? { channelError: record.channelError }
          : {}),
        ...(at !== undefined ? { at } : {}),
      });
    }
    return;
  }
  if (record.kind === "ack") {
    if (typeof record.id === "string") state.ackedIds.add(record.id);
    return;
  }
  // An unknown kind is skipped, so a newer writer never breaks this reader.
}

/**
 * Read the event log for one session. A missing or unreadable file reads as
 * an empty log; a missing session file name reads as none.
 */
export function readReportLog(sessionFile: string | undefined): ReportLogState {
  const state: ReportLogState = { reports: [], notifications: [], ackedIds: new Set() };
  if (!sessionFile) return state;
  let content: string;
  try {
    content = readFileSync(reportReceiptPath(sessionFile), "utf8");
  } catch {
    return state;
  }
  for (const line of content.split("\n")) {
    if (!line) continue;
    const record = parseLogLine(line);
    if (record !== null) foldRecord(record, state);
  }
  return state;
}

/**
 * The pane a log line was delivered to as a legacy receipt, or null when the
 * line names none. The rule lives in `legacyReceiptTarget`, which both the
 * log fold and the receipt count apply.
 */
function receiptTarget(line: string): string | null {
  const record = parseLogLine(line);
  if (record === null) return null;
  return legacyReceiptTarget(record);
}

/**
 * Count the receipts addressed to `target`.
 *
 * Only kindless lines addressed to the target count: a report sent to some
 * other pane does not tell the parent that this child is done, so it must
 * not suppress the wake-up; and a `file-ack-v1` record is not a legacy
 * delivery however its fields read. A receipt line that does not parse is
 * skipped for the same reason. A missing file counts as no reports.
 */
export function countReportsTo(sessionFile: string | undefined, target: string): number {
  if (!sessionFile) return 0;
  let content: string;
  try {
    content = readFileSync(reportReceiptPath(sessionFile), "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    // A malformed line proves nothing about the target: skip it.
    if (receiptTarget(line) === target) count += 1;
  }
  return count;
}
