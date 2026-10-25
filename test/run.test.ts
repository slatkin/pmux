/**
 * The run wrapper under the `file-ack-v1` report protocol (design D8): the
 * exit re-delivery of the current run's unacknowledged parent reports, the
 * durable no-report wake-up, and the ordering with the pane close.
 *
 * The decision tests inject the wrapper's `deliverReport` seam with a
 * recorder, so the wrapper's after-the-sentinel decisions — the baseline, the
 * ack recheck, the delivery order, the stderr failure path — are asserted
 * without a tmux server. Two tests run the real delivery flow through the
 * shared tmux fake, so the default seam and the `.sent` records stay
 * exercised.
 */
import "./host-env.ts";
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_SPEC_VERSION, type LaunchSpec } from "../pi-extension/pmux/launch.ts";
import { REPORT_PROTOCOL } from "../pi-extension/pmux/launch-build.ts";
import { runSpec } from "../pi-extension/pmux/run.ts";
import { __setTmuxExecForTests__ } from "../pi-extension/pmux/tmux.ts";
import { useTmuxPaneFake } from "./tmux-fakes.ts";
import {
  deliverReport as sharedDeliverReport,
  registerReport,
  type DeliverReportArgs,
  type DeliverReportResult,
  type ReportDeliveryDeps,
} from "../pi-extension/pmux/report-delivery.ts";
import type { ChannelSubmitArgs } from "../pi-extension/pmux/channel-endpoint.ts";
import { newReportId, reportArtifactPath } from "../pi-extension/pmux/report-artifact.ts";
import {
  appendReportAck,
  appendReportReceipt,
  readReportLog,
} from "../pi-extension/pmux/report-receipt.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("pmux-run-");

const STUB = join(dirname(fileURLToPath(import.meta.url)), "stubs", "pi-stub.ts");
const CLI = "/pkg/pi-extension/pmux/cli.ts";
const PARENT = "%12";

/** A marked send-mode spec running the stub child in the wrapper's pane. */
function markedSpec(cwd: string, over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    version: LAUNCH_SPEC_VERSION,
    name: "scout-1",
    env: { PI_PMUX_REPORT_PROTOCOL: REPORT_PROTOCOL },
    command: process.execPath,
    args: [STUB],
    sessionFile: join(cwd, "session.jsonl"),
    parent: PARENT,
    report: "send",
    ...over,
  };
}

interface MarkedResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The delivery seam calls, in order — real or injected. */
  deliveries: DeliverReportArgs[];
  /** The raw legacy text contacts, in order (an unmarked spec only). */
  rawWakes: Array<{ to: string; text: string }>;
  /** Sequenced events: `deliver <id>`, `sleep <ms>`, `close <pane>`. */
  events: string[];
}

interface MarkedCaseOptions {
  /** The stub child writes this `.exit` body when it exits. */
  exitBody?: string;
  /** The stub child exits with this code. */
  stubCode?: string;
  /** Replace the child argv (a `-e` script does the child's side effects). */
  childScript?: string;
  /** The delivery seam; default records every call as a submitted attempt. */
  deliver?: (args: DeliverReportArgs) => Promise<DeliverReportResult>;
  /** When true, the wrapped recorder invokes the real delivery flow. */
  realDelivery?: boolean;
  /** Deps the real delivery flow runs with, e.g. an injected channel client. */
  deliveryDeps?: ReportDeliveryDeps;
}

/** Run the wrapper on a send-mode spec with every side effect recorded. */
async function runMarkedCase(
  dir: string,
  spec: LaunchSpec,
  options: MarkedCaseOptions = {},
): Promise<MarkedResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const rawWakes: Array<{ to: string; text: string }> = [];
  const deliveries: DeliverReportArgs[] = [];
  const events: string[] = [];
  const deliver = async (args: DeliverReportArgs): Promise<DeliverReportResult> => {
    deliveries.push(args);
    events.push(`deliver ${args.id}`);
    if (options.realDelivery === true) return sharedDeliverReport(args, options.deliveryDeps);
    if (options.deliver !== undefined) return options.deliver(args);
    return {
      status: "submitted",
      submitted: true,
      enterAttempted: true,
      token: newReportId(),
      notificationRecorded: true,
      acknowledged: false,
    };
  };
  const sessionFile = spec.sessionFile ?? join(dir, "session.jsonl");
  const exitPath = `${sessionFile}.exit`;
  const specFull: LaunchSpec =
    options.childScript !== undefined ? { ...spec, args: ["-e", options.childScript] } : spec;

  const code = await runSpec(specFull, undefined, {
    // The wake text and the pointer name this CLI for the parent.
    cliPath: CLI,
    env: {
      PATH: process.env.PATH,
      TMUX_PANE: "%77",
      // The stub child records its env; the wrapper passes the pane through.
      PI_STUB_EXIT: exitPath,
      ...(options.exitBody !== undefined ? { PI_STUB_EXIT_BODY: options.exitBody } : {}),
      ...(options.stubCode !== undefined ? { PI_STUB_CODE: options.stubCode } : {}),
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
    },
    closePane: (pane) => {
      events.push(`close ${pane}`);
    },
    sendToParent: (to, text) => {
      rawWakes.push({ to, text });
      events.push(`raw ${to} ${text}`);
    },
    deliverReport: deliver,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), deliveries, rawWakes, events };
}

/**
 * A `-e` script the stub child never sees — the child IS the script. It
 * registers one `file-ack-v1` report the way `send` does (artifact file,
 * `report` record, optional `notification`), optionally acks it like a
 * parent reading early, writes the exit body and stops.
 */
function childReportScript(args: {
  sessionFile: string;
  id: string;
  to: string;
  notify?: boolean;
  ack?: boolean;
  exitBody?: string;
  /** `process.exit` code, for a script that must not exit 0. */
  exitCode?: number;
}): string {
  const sent = `${args.sessionFile}.sent`;
  const artifact = reportArtifactPath(args.sessionFile, args.id);
  const record = { id: args.id, to: args.to, bytes: 11, report: artifact };
  const event = (one: Record<string, unknown>): string =>
    `fs.appendFileSync(${JSON.stringify(sent)}, ${JSON.stringify(
      JSON.stringify({ ...one, at: new Date().toISOString() }),
    )} + "\\n");`;
  return (
    // `var` (not `const`): a test may concatenate two report scripts, and a
    // `var` redeclaration is legal in a CJS `-e` script.
    `var fs = require("fs");` +
    `fs.writeFileSync(${JSON.stringify(artifact)}, "REPORT BODY");` +
    event({ ...record, kind: "report" }) +
    (args.notify === false
      ? ""
      : event({ ...record, token: "ee".repeat(16), kind: "notification" })) +
    (args.ack === true ? event({ kind: "ack", id: args.id }) : "") +
    (args.exitBody !== undefined
      ? `fs.writeFileSync(${JSON.stringify(`${args.sessionFile}.exit`)}, ${JSON.stringify(args.exitBody)});`
      : "") +
    (args.exitCode !== undefined ? `process.exit(${args.exitCode});` : "") +
    `process.exitCode = process.exitCode ?? 0;`
  );
}

/** Kindless legacy line, as an old in-child `send` writes it. */
function childLegacyScript(sessionFile: string, exitBody?: string): string {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    to: PARENT,
    bytes: 5,
  });
  return (
    `var fs = require("fs");` +
    `fs.appendFileSync(${JSON.stringify(`${sessionFile}.sent`)}, ${JSON.stringify(line)} + "\\n");` +
    (exitBody !== undefined
      ? `fs.writeFileSync(${JSON.stringify(`${sessionFile}.exit`)}, ${JSON.stringify(exitBody)});`
      : "")
  );
}

/** The done-sidecar wake wording, shared by the wake tests. */
function wakeTextDone(sessionFile: string): string {
  return `scout-1 done without sending a report. Read its last message: node ${CLI} last-message --session ${sessionFile}`;
}

/** A submitted seam result (not carrying the args: results are not args). */
function submittedResult(): DeliverReportResult {
  return {
    status: "submitted",
    submitted: true,
    enterAttempted: true,
    token: newReportId(),
    notificationRecorded: true,
    acknowledged: false,
  };
}

afterEach(() => {
  __setTmuxExecForTests__(null);
});

describe("runSpec under file-ack-v1 (design D8)", () => {
  it("delivers nothing for a report the parent already acked, and wakes no one", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({
          sessionFile,
          id,
          to: PARENT,
          ack: true,
          exitBody: '{"type":"done"}',
        }),
      });
      // The child sent; the parent read it; the run has nothing left to say.
      assert.deepEqual(res.deliveries, []);
      assert.equal(res.stderr, "");
      assert.equal(res.stdout, "__SUBAGENT_DONE_0__\n");
      // The ack consumed the report after the sentinel: it is in the log the
      // wrapper examined, and no wake artifact was registered either.
      const log = readReportLog(sessionFile);
      assert.equal(log.ackedIds.has(id), true);
      assert.deepEqual(
        log.reports.map((report) => report.id),
        [id],
      );
    });
  });

  it("re-delivers an unacknowledged report: same ID and file, no ack wait", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({
          sessionFile,
          id,
          to: PARENT,
          exitBody: '{"type":"done"}',
        }),
      });
      assert.equal(res.deliveries.length, 1);
      const call = res.deliveries[0]!;
      assert.equal(call.id, id);
      assert.equal(call.reportPath, reportArtifactPath(sessionFile, id));
      assert.equal(call.to, PARENT);
      assert.equal(call.sessionFile, sessionFile);
      assert.equal(call.bytes, 11);
      assert.equal(call.cliPath, CLI);
      // No ack wait (design D8): the retry offers the pointer and leaves.
      assert.equal(call.ackTimeoutSeconds, undefined);
      assert.equal(res.stderr, "");
      // A delivered report stands in for the wake-up: no second artifact.
      assert.deepEqual(
        readReportLog(sessionFile).reports.map((report) => report.id),
        [id],
      );
    });
  });

  it("re-delivers after a refused send: a registered report needs no notification", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({
          sessionFile,
          id,
          to: PARENT,
          notify: false,
          exitBody: '{"type":"done"}',
        }),
      });
      assert.equal(res.deliveries.length, 1);
      assert.equal(res.deliveries[0]!.id, id);
      assert.equal(res.stderr, "");
      // The send's notification never landed; the re-delivery is unscoped by it.
      assert.equal(readReportLog(sessionFile).notifications.length, 0);
    });
  });

  it("re-delivers several unacknowledged reports in registration order", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const first = newReportId();
      const second = newReportId();
      const script =
        childReportScript({ sessionFile, id: first, to: PARENT }) +
        childReportScript({ sessionFile, id: second, to: PARENT, exitBody: '{"type":"done"}' });
      const res = await runMarkedCase(dir, markedSpec(dir), { childScript: script });
      // Registration order (the file order of the `report` records).
      assert.deepEqual(
        res.deliveries.map((call) => call.id),
        [first, second],
      );
      assert.equal(res.stderr, "");
    });
  });

  it("ignores a report to another pane and applies the wake decision instead", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({ sessionFile, id, to: "%99", exitBody: '{"type":"done"}' }),
      });
      // The other pane's report is that pane's business; the parent still gets
      // its durable wake.
      assert.equal(res.deliveries.length, 1);
      const wake = res.deliveries[0]!;
      assert.notEqual(wake.id, id);
      assert.equal(readFileSync(wake.reportPath, "utf8"), wakeTextDone(sessionFile));
      const log = readReportLog(sessionFile);
      assert.deepEqual(
        log.reports.map((report) => report.id),
        [id, wake.id],
      );
      assert.deepEqual(
        log.reports.map((report) => report.to),
        ["%99", PARENT],
      );
      assert.equal(res.stderr, "");
    });
  });

  it("acts on the baseline: an earlier run's report, acked or not, stays out", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      // A resumed marked run's snapshot: one earlier report the parent never
      // acked, one it acked later. Neither belongs to this run.
      registerReport({ sessionFile, to: PARENT, text: "older run A" });
      const olderAcked = registerReport({ sessionFile, to: PARENT, text: "older run B" });
      appendReportAck(sessionFile, olderAcked.id);
      const current = newReportId();
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({
          sessionFile,
          id: current,
          to: PARENT,
          exitBody: '{"type":"done"}',
        }),
      });
      // Only the current run's report is examined — and the no-report wake
      // stays suppressed, because the current run has one.
      assert.deepEqual(
        res.deliveries.map((call) => call.id),
        [current],
      );
      assert.equal(res.stderr, "");
    });
  });

  it("wakes when nothing new landed: earlier receipts do not suppress the wake", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      // An earlier run's legacy receipt sits in the log before this one.
      appendReportReceipt(sessionFile, { at: new Date().toISOString(), to: PARENT, bytes: 9 });
      const res = await runMarkedCase(dir, markedSpec(dir), { exitBody: '{"type":"done"}' });
      // The pre-spawn count dropped the earlier receipt from the decision.
      assert.equal(res.deliveries.length, 1);
      assert.equal(readFileSync(res.deliveries[0]!.reportPath, "utf8"), wakeTextDone(sessionFile));
    });
  });

  it("makes the no-report wake-up durable through the done sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const res = await runMarkedCase(dir, markedSpec(dir), { exitBody: '{"type":"done"}' });
      assert.equal(res.deliveries.length, 1);
      const wake = res.deliveries[0]!;
      assert.match(wake.reportPath, /\.report\.md$/);
      // The artifact holds the legacy wording byte for byte (design D8).
      assert.equal(readFileSync(wake.reportPath, "utf8"), wakeTextDone(sessionFile));
      // Registered as `send` registers a report, addressed to the parent.
      const log = readReportLog(sessionFile);
      assert.deepEqual(
        log.reports.map((report) => report.id),
        [wake.id],
      );
      assert.deepEqual(
        log.reports.map((report) => report.to),
        [PARENT],
      );
      assert.equal(res.stderr, "");
    });
  });

  it("quotes a ping question into the durable wake artifact", async () => {
    await withTempDirAsync(async (dir) => {
      const res = await runMarkedCase(dir, markedSpec(dir), {
        exitBody: '{"type":"ping","name":"w","message":"Which DB?\\nPostgres or MySQL?"}',
      });
      assert.equal(res.deliveries.length, 1);
      // The artifact holds the message unchanged: a real line break, no
      // pane-input encoding (design D2).
      assert.equal(
        readFileSync(res.deliveries[0]!.reportPath, "utf8"),
        "scout-1 pinged: Which DB?\nPostgres or MySQL?",
      );
      assert.equal(res.stderr, "");
    });
  });

  it("makes a crash's wake durable, naming the wrapper's error state", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const res = await runMarkedCase(dir, markedSpec(dir), { stubCode: "2" });
      // The wrapper wrote its own error sidecar, so the wake names that state.
      assert.match(readFileSync(`${sessionFile}.exit`, "utf8"), /"source":"wrapper"/);
      assert.equal(res.deliveries.length, 1);
      assert.equal(
        readFileSync(res.deliveries[0]!.reportPath, "utf8"),
        `scout-1 error without sending a report. Read its last message: node ${CLI} last-message --session ${sessionFile}`,
      );
      // The crash code survives the contact.
      assert.equal(res.code, 2);
      assert.equal(res.stdout, "__SUBAGENT_DONE_2__\n");
    });
  });

  it("skips a report acked between the sentinel and its retry", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const first = newReportId();
      const second = newReportId();
      const script =
        childReportScript({ sessionFile, id: first, to: PARENT }) +
        childReportScript({ sessionFile, id: second, to: PARENT, exitBody: '{"type":"done"}' });
      // The parent's ack of the second report lands while the first pointer
      // is being submitted; the second attempt's recheck is the last read
      // before it goes, so it sees the ack and skips.
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: script,
        deliver: async (args) => {
          if (args.id === first) appendReportAck(sessionFile, second);
          return submittedResult();
        },
      });
      assert.deepEqual(
        res.deliveries.map((call) => call.id),
        [first],
      );
      assert.equal(res.stderr, "");
    });
  });

  it("reports a retry failure on stderr only, and still attempts the next report", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const first = newReportId();
      const second = newReportId();
      const script =
        childReportScript({ sessionFile, id: first, to: PARENT, notify: false }) +
        childReportScript({ sessionFile, id: second, to: PARENT }) +
        `fs.writeFileSync(${JSON.stringify(`${sessionFile}.exit`)}, '{"type":"done"}');\n` +
        `process.exit(3);`;
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: script,
        deliver: async (args) =>
          args.id === first
            ? {
                status: "not-submitted",
                submitted: false,
                enterAttempted: false,
                token: newReportId(),
                notificationRecorded: false,
                error: "the pane is in a mode",
                acknowledged: false,
              }
            : submittedResult(),
      });
      // Both rows ran; the first's refusal named the parent on stderr alone.
      assert.deepEqual(
        res.deliveries.map((call) => call.id),
        [first, second],
      );
      assert.match(
        res.stderr,
        /Failed to re-deliver report [0-9a-f]{32} to parent %12: the pane is in a mode/,
      );
      assert.equal(res.code, 3);
      assert.equal(res.stdout, "__SUBAGENT_DONE_3__\n");
    });
  });

  it("contacts the parent after the sentinel, before it closes the pane", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const first = newReportId();
      const second = newReportId();
      const script =
        childReportScript({ sessionFile, id: first, to: PARENT }) +
        childReportScript({ sessionFile, id: second, to: PARENT, exitBody: '{"type":"done"}' });
      const res = await runMarkedCase(dir, markedSpec(dir, { closeOnDone: { graceMs: 0 } }), {
        childScript: script,
      });
      // The close-on-done step runs after the last attempt; both reports
      // delivered, so the wake row does not exist.
      assert.deepEqual(res.events, [`deliver ${first}`, `deliver ${second}`, "close %77"]);
    });
  });

  it("closes the pane after the wake artifact is delivered", async () => {
    await withTempDirAsync(async (dir) => {
      const res = await runMarkedCase(dir, markedSpec(dir, { closeOnDone: { graceMs: 500 } }), {
        exitBody: '{"type":"done"}',
      });
      // Wake delivery, then the grace, then the close: the wake block runs
      // entirely before the close-on-done step (design D8).
      assert.deepEqual(res.events.length, 3);
      const wakeId = res.deliveries[0]!.id;
      assert.deepEqual(res.events, [`deliver ${wakeId}`, "sleep 500", "close %77"]);
    });
  });

  it("stays quiet for a cancelled run: no re-delivery and no wake", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      const res = await runMarkedCase(dir, markedSpec(dir, { closeOnDone: { graceMs: 100 } }), {
        childScript: childReportScript({
          sessionFile,
          id,
          to: PARENT,
          exitBody: '{"type":"cancelled"}',
        }),
      });
      // The run's report is unacknowledged, yet a cancel types nothing.
      assert.deepEqual(res.deliveries, []);
      assert.equal(res.stderr, "");
      // The cancel still closes the pane (quiet-cancel-exit D4).
      assert.deepEqual(res.events, ["sleep 100", "close %77"]);
      // Nothing was added to the log: the report row is the child's own.
      assert.deepEqual(
        readReportLog(sessionFile).reports.map((report) => report.id),
        [id],
      );
    });
  });

  it("refuses a marked spec without a session file loudly, before spawn", async () => {
    await withTempDirAsync(async (dir) => {
      const spec = { ...markedSpec(dir), sessionFile: undefined };
      await assert.rejects(
        runSpec(spec, undefined, {
          env: { PATH: process.env.PATH, TMUX_PANE: "%77" },
          stdout: () => {},
          stderr: () => {},
        }),
        /holds no session file/,
      );
      // No child was started: no stub sidecar can exist.
      assert.equal(existsSync(`${join(dir, "anything")}.exit`), false);
    });
  });

  it("counts a new kindless receipt as parent contact, not as a report to retry", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const res = await runMarkedCase(dir, markedSpec(dir), {
        // An unmarked `send` ran inside this marked child's session: a
        // kindless line went to the parent, and it names no report ID.
        childScript: childLegacyScript(sessionFile, '{"type":"done"}'),
      });
      // Parent contact happened this run, so no wake — and there is no
      // report ID to re-deliver.
      assert.deepEqual(res.deliveries, []);
      assert.equal(res.stderr, "");
      assert.equal(readReportLog(sessionFile).reports.length, 0);
    });
  });

  it("keeps the unmarked wake untouched: one raw text through the legacy seam", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const unmarked: LaunchSpec = { ...markedSpec(dir), env: {} };
      const res = await runMarkedCase(dir, unmarked, { exitBody: '{"type":"done"}' });
      assert.equal(res.deliveries.length, 0);
      // The raw text is the legacy ENCODED one-input line, unmarked wording.
      assert.deepEqual(res.rawWakes, [
        {
          to: PARENT,
          text: `scout-1 done without sending a report. Read its last message: node ${CLI} last-message --session ${sessionFile}`,
        },
      ]);
    });
  });
});

describe("runSpec with the real delivery (the default seam, tmux fake)", () => {
  let paneCalls: string[] = [];
  let paneFake: ReturnType<typeof useTmuxPaneFake>;

  beforeEach(() => {
    // In-process tmux seam: the fake echoes the typed pointer, so the
    // verified submission's token poll sees it without a real server.
    paneFake = useTmuxPaneFake();
    paneCalls = paneFake.lines;
  });

  it("types the wake pointer into the parent and records both events", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const res = await runMarkedCase(dir, markedSpec(dir), {
        exitBody: '{"type":"done"}',
        realDelivery: true,
      });
      // No injected seam: the default flow ran against the fake — artifact
      // written, registered, pointer submitted with one Enter, notification
      // recorded.
      assert.equal(res.deliveries.length, 1);
      const id = readReportLog(sessionFile).reports[0]!.id;
      assert.equal(existsSync(reportArtifactPath(sessionFile, id)), true);
      assert.equal(
        readFileSync(reportArtifactPath(sessionFile, id), "utf8"),
        wakeTextDone(sessionFile),
      );
      const typed = paneCalls.filter((call) => call.startsWith(`send-keys -t ${PARENT} -l`));
      assert.equal(typed.length, 1);
      assert.ok(typed[0]!.includes(`pmux report ${id}.`));
      assert.match(typed[0]!, /\[pmux-eom-[0-9a-f]{32}\]$/);
      assert.equal(paneCalls.filter((call) => call === `send-keys -t ${PARENT} Enter`).length, 1);
      const log = readReportLog(sessionFile);
      assert.equal(log.notifications.length, 1);
      assert.equal(log.notifications[0]!.id, id);
      assert.equal(res.stderr, "");
    });
  });

  it("writes a re-delivery refusal to stderr when the pane is in a mode", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      paneFake.paneInMode = true;
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({
          sessionFile,
          id,
          to: PARENT,
          notify: false,
          exitBody: '{"type":"done"}',
        }),
        realDelivery: true,
      });
      // The refusal is stderr only: the child's code stands.
      assert.match(
        res.stderr,
        /Failed to re-deliver report [0-9a-f]{32} to parent %12: the pane is in a mode/,
      );
      // The registration and the artifact survive untouched on disk: the
      // send's own notification was refused too, so the log has none for the
      // id, and no keys were typed.
      assert.equal(existsSync(reportArtifactPath(sessionFile, id)), true);
      assert.deepEqual(
        readReportLog(sessionFile).notifications.filter((notification) => notification.id === id),
        [],
      );
      assert.deepEqual(
        paneCalls.filter((call) => call.startsWith("send-keys")),
        [],
      );
    });
  });

  it("re-delivers through the channel: same ID, fresh token, no pane input", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const id = newReportId();
      // The child's own `send` notification token, from its recorded event.
      const childToken = "ee".repeat(16);
      const channelCalls: ChannelSubmitArgs[] = [];
      const res = await runMarkedCase(dir, markedSpec(dir), {
        childScript: childReportScript({
          sessionFile,
          id,
          to: PARENT,
          exitBody: '{"type":"done"}',
        }),
        realDelivery: true,
        deliveryDeps: {
          submitChannel: async (args) => {
            channelCalls.push(args);
            return { status: "emitted" };
          },
        },
      });
      // The exit re-delivery reached the parent through the channel.
      assert.equal(res.deliveries.length, 1);
      assert.equal(res.deliveries[0]!.id, id);
      assert.equal(channelCalls.length, 1);
      assert.equal(channelCalls[0]!.id, id);
      assert.equal(channelCalls[0]!.to, PARENT);
      // A fresh visibility token, not the child's own notification token.
      assert.notEqual(channelCalls[0]!.token, childToken);
      assert.match(channelCalls[0]!.token, /^[0-9a-f]{32}$/);
      assert.ok(channelCalls[0]!.text.includes(`pmux report ${id}.`));
      // `emitted` ends the attempt: no pane input at all.
      assert.deepEqual(
        paneCalls.filter((call) => call.startsWith("send-keys")),
        [],
      );
      // The submission was still recorded, keyed on the fresh token —
      // alongside the child's own `send` notification, which stays untouched.
      const log = readReportLog(sessionFile);
      assert.equal(log.notifications.length, 2);
      const redelivered = log.notifications.filter(
        (notification) => notification.token === channelCalls[0]!.token,
      );
      assert.deepEqual(
        redelivered.map((notification) => notification.id),
        [id],
      );
      assert.equal(res.stderr, "");
    });
  });
});
