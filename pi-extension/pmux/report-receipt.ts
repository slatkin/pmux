/**
 * The `<session file>.sent` report receipts — host independent, like
 * `exit-sidecar.ts` and `status-file.ts`.
 *
 * A send-mode child delivers its report with the `send` subcommand, which
 * appends one JSON line per delivered report. The pane-side wrapper counts
 * the lines addressed to the parent to decide whether it must wake the
 * parent, so the count does not depend on how the child quoted the send
 * invocation. Both sides read and write the file through this module, so the
 * name and the record shape live in one place.
 */
import { appendFileSync, readFileSync } from "node:fs";

/** The suffix the receipt file carries next to the session file. */
export const REPORT_RECEIPT_SUFFIX = ".sent";

/** One delivered report. */
export interface ReportReceipt {
  /** ISO time of the delivery. */
  at: string;
  /** The pane the report was typed into. */
  to: string;
  /** Length of the delivered text. */
  bytes: number;
}

/** The receipt file next to a session file. */
export function reportReceiptPath(sessionFile: string): string {
  return `${sessionFile}${REPORT_RECEIPT_SUFFIX}`;
}

/**
 * Append one receipt line. Never throws and never reports failure: the
 * delivery already happened, and a lost receipt only costs the parent a
 * spurious wake-up.
 */
export function appendReportReceipt(sessionFile: string, receipt: ReportReceipt): void {
  try {
    appendFileSync(reportReceiptPath(sessionFile), `${JSON.stringify(receipt)}\n`);
  } catch {
    // Best effort; see above.
  }
}

/**
 * The pane a receipt line names, or null when the line names none.
 *
 * The count rule is the spec's: a line counts when it parses as JSON and
 * its `to` is a string. The other fields belong to the writer, and a line
 * that lacks them still names a pane.
 */
function receiptTarget(line: string): string | null {
  try {
    const data: unknown = JSON.parse(line);
    if (data === null || typeof data !== "object") return null;
    const to = (data as Record<string, unknown>).to;
    return typeof to === "string" ? to : null;
  } catch {
    return null;
  }
}

/**
 * Count the receipts addressed to `target`.
 *
 * Only receipts addressed to the target count: a report sent to some other
 * pane does not tell the parent that this child is done, so it must not
 * suppress the wake-up. A receipt line that does not parse is skipped for the
 * same reason. A missing file counts as no reports.
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
