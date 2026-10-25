/**
 * The `<session>.sent` event log: the `report`, `notification` and `ack`
 * record writers, the state reader, and the kindless-only legacy count.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendReportAck,
  appendReportNotification,
  appendReportReceipt,
  appendReportRegistration,
  countReportsTo,
  readReportLog,
  reportReceiptPath,
} from "../pi-extension/pmux/report-receipt.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-receipt-");

const ID_A = "aa".repeat(16);
const ID_B = "bb".repeat(16);
const TOKEN = "cc".repeat(16);

/** Read the log back as raw lines. */
function logLines(sessionFile: string): string[] {
  return readFileSync(reportReceiptPath(sessionFile), "utf8").trimEnd().split("\n");
}

describe("event log writers", () => {
  it("writes the legacy kindless receipt line unchanged", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const at = new Date().toISOString();
      assert.equal(appendReportReceipt(sessionFile, { at, to: "%12", bytes: 4 }), true);
      // No `kind` key: the line must stay a legacy notification.
      assert.deepEqual(JSON.parse(logLines(sessionFile)[0]!), { at, to: "%12", bytes: 4 });
    });
  });

  it("writes a `report` registration record before transport", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const report = `${sessionFile}.${ID_A}.report.md`;
      assert.equal(
        appendReportRegistration(sessionFile, { id: ID_A, to: "%12", bytes: 9, report }),
        true,
      );
      const record = JSON.parse(logLines(sessionFile)[0]!);
      assert.equal(record.kind, "report");
      assert.equal(record.id, ID_A);
      assert.equal(record.to, "%12");
      assert.equal(record.bytes, 9);
      assert.equal(record.report, report);
      assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("writes a `notification` record with the visibility token", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const report = `${sessionFile}.${ID_A}.report.md`;
      assert.equal(
        appendReportNotification(sessionFile, {
          id: ID_A,
          token: TOKEN,
          to: "%12",
          bytes: 9,
          report,
        }),
        true,
      );
      const record = JSON.parse(logLines(sessionFile)[0]!);
      assert.equal(record.kind, "notification");
      assert.equal(record.id, ID_A);
      assert.equal(record.token, TOKEN);
      assert.equal(record.to, "%12");
      assert.equal(record.bytes, 9);
      assert.equal(record.report, report);
      assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("writes an `ack` record naming only the report ID — never a `to`", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      assert.equal(appendReportAck(sessionFile, ID_A), true);
      const record = JSON.parse(logLines(sessionFile)[0]!);
      assert.equal(record.kind, "ack");
      assert.equal(record.id, ID_A);
      // An ack can never be mistaken for a delivered report.
      assert.equal(record.to, undefined);
      assert.deepEqual(Object.keys(record).sort(), ["at", "id", "kind"]);
    });
  });

  it("reports a failed write without throwing", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "missing", "s.jsonl");
      assert.equal(
        appendReportRegistration(sessionFile, { id: ID_A, to: "%12", bytes: 1, report: "/r" }),
        false,
      );
      assert.equal(
        appendReportNotification(sessionFile, {
          id: ID_A,
          token: TOKEN,
          to: "%12",
          bytes: 1,
          report: "/r",
        }),
        false,
      );
      assert.equal(appendReportAck(sessionFile, ID_A), false);
      assert.equal(
        appendReportReceipt(sessionFile, { at: new Date().toISOString(), to: "%12", bytes: 1 }),
        false,
      );
    });
  });
});

describe("readReportLog", () => {
  it("reads an empty state for a missing file or no session", () => {
    withTempDir((dir) => {
      assert.deepEqual(readReportLog(join(dir, "none.jsonl")), {
        reports: [],
        notifications: [],
        ackedIds: new Set(),
      });
      assert.deepEqual(readReportLog(undefined), {
        reports: [],
        notifications: [],
        ackedIds: new Set(),
      });
    });
  });

  it("returns registrations, notifications and acked IDs in file order", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const reportA = `${sessionFile}.${ID_A}.report.md`;
      const reportB = `${sessionFile}.${ID_B}.report.md`;
      appendReportRegistration(sessionFile, { id: ID_A, to: "%12", bytes: 3, report: reportA });
      appendReportRegistration(sessionFile, { id: ID_B, to: "%99", bytes: 5, report: reportB });
      appendReportNotification(sessionFile, {
        id: ID_A,
        token: TOKEN,
        to: "%12",
        bytes: 3,
        report: reportA,
      });
      appendReportReceipt(sessionFile, { at: "2026-10-24T00:00:00Z", to: "%12", bytes: 7 });
      appendReportAck(sessionFile, ID_A);
      appendReportAck(sessionFile, ID_B);
      // A duplicated ack line (concurrent acks) still reads once.
      appendReportAck(sessionFile, ID_B);

      const state = readReportLog(sessionFile);
      assert.equal(state.reports.length, 2);
      assert.deepEqual(
        state.reports.map((report) => report.id),
        [ID_A, ID_B],
      );
      assert.equal(state.reports[0]!.to, "%12");
      assert.equal(state.reports[0]!.report, reportA);
      assert.match(state.reports[0]!.at ?? "", /^\d{4}-/);
      // The notification record and the kindless legacy line share the list;
      // the legacy one carries no ID.
      assert.equal(state.notifications.length, 2);
      assert.equal(state.notifications[0]!.id, ID_A);
      assert.equal(state.notifications[0]!.token, TOKEN);
      assert.equal(state.notifications[1]!.id, undefined);
      assert.equal(state.notifications[1]!.to, "%12");
      assert.equal(state.notifications[1]!.bytes, 7);
      assert.deepEqual([...state.ackedIds].sort(), [ID_A, ID_B].sort());
    });
  });

  it("skips malformed lines and unknown kinds and still sees the rest", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(
        reportReceiptPath(sessionFile),
        [
          "not json at all",
          JSON.stringify({ kind: "pigeon", id: ID_A, to: "%12" }),
          JSON.stringify({ kind: "report" }), // missing id/to/bytes/report
          JSON.stringify({ kind: "notification", to: "%12" }), // missing id/token
          JSON.stringify({ kind: "ack" }), // missing id
          JSON.stringify({ to: "%12" }),
          JSON.stringify({ kind: "ack", id: ID_A }),
          JSON.stringify([1, 2, 3]),
          "42",
        ].join("\n") + "\n",
      );
      const state = readReportLog(sessionFile);
      assert.equal(state.reports.length, 0);
      assert.equal(state.notifications.length, 1);
      assert.equal(state.notifications[0]!.to, "%12");
      assert.equal(state.notifications[0]!.id, undefined);
      assert.deepEqual([...state.ackedIds], [ID_A]);
    });
  });

  it("treats a kindless line with no `to` as malformed", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(reportReceiptPath(sessionFile), `{"bytes":3}\n{"to":42}\n`);
      assert.deepEqual(readReportLog(sessionFile).notifications, []);
    });
  });
});

describe("countReportsTo", () => {
  it("counts kindless lines only: a `report` registration is no delivery", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      // A file-ack-v1 send registers its artifact with the parent's pane as
      // `to`; that registration must never pass as a delivered report.
      appendReportRegistration(sessionFile, { id: ID_A, to: "%12", bytes: 3, report: "/r" });
      assert.equal(countReportsTo(sessionFile, "%12"), 0);
      // Neither does a submitted pointer, nor an ack.
      appendReportNotification(sessionFile, {
        id: ID_A,
        token: TOKEN,
        to: "%12",
        bytes: 3,
        report: "/r",
      });
      appendReportAck(sessionFile, ID_A);
      assert.equal(countReportsTo(sessionFile, "%12"), 0);
      // A kindless legacy line counts — and only for the pane it names.
      appendReportReceipt(sessionFile, { at: "2026-10-24T00:00:00Z", to: "%12", bytes: 2 });
      appendReportReceipt(sessionFile, { at: "2026-10-24T00:00:00Z", to: "%99", bytes: 2 });
      assert.equal(countReportsTo(sessionFile, "%12"), 1);
      assert.equal(countReportsTo(sessionFile, "%99"), 1);
    });
  });

  it("skips malformed lines and unknown kinds, and counts nothing without a file", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(
        reportReceiptPath(sessionFile),
        ["garbage", JSON.stringify({ kind: "weird", to: "%12" }), JSON.stringify({})].join("\n"),
      );
      assert.equal(countReportsTo(sessionFile, "%12"), 0);
      assert.equal(countReportsTo(join(dir, "none.jsonl"), "%12"), 0);
      assert.equal(countReportsTo(undefined, "%12"), 0);
    });
  });
});
