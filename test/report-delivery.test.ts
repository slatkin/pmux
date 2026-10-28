/**
 * The shared `file-ack-v1` delivery flow: artifact registration before
 * transport, the verified pointer submission with its `notification` event,
 * and the bounded ack wait — with the pane submission and the clock faked.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  awaitReportAck,
  deliverReport,
  registerReport,
  reportAcknowledged,
  submitReportPointer,
  REPORT_ACK_POLL_MS,
  type ReportDeliveryDeps,
} from "../pi-extension/pmux/report-delivery.ts";
import type {
  ChannelSubmitArgs,
  ChannelSubmitResult,
} from "../pi-extension/pmux/channel-endpoint.ts";
import {
  isReportId,
  reportArtifactPath,
  VISIBILITY_TOKEN_PREFIX,
} from "../pi-extension/pmux/report-artifact.ts";
import { appendReportAck, readReportLog } from "../pi-extension/pmux/report-receipt.ts";
import { inboxDirPath, writeMonitorMarker } from "../pi-extension/pmux/report-inbox.ts";
import type { VerifiedPromptResult } from "../pi-extension/pmux/tmux.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir, withTempDirAsync } = tempDirHelpers("pmux-delivery-");

const CLI = "/pkg/pi-extension/pmux/cli.ts";
const ID = "aa".repeat(16);

interface SubmitCall {
  pane: string;
  text: string;
  token: string;
}

/** A submit dep that records its arguments and answers `result`. */
function fakeSubmit(
  result: Partial<VerifiedPromptResult> & { status: VerifiedPromptResult["status"] },
) {
  const calls: SubmitCall[] = [];
  const submit: NonNullable<ReportDeliveryDeps["submit"]> = async (pane, text, token) => {
    calls.push({ pane, text, token });
    return {
      pane,
      submitted: result.status === "submitted",
      enterAttempted: result.status !== "not-submitted",
      ...result,
    };
  };
  return { submit, calls };
}

/** A channel dep that records its arguments and answers `result`. */
function fakeChannel(result: ChannelSubmitResult) {
  const calls: ChannelSubmitArgs[] = [];
  const submitChannel = async (args: ChannelSubmitArgs): Promise<ChannelSubmitResult> => {
    calls.push(args);
    return result;
  };
  return { submitChannel, calls };
}

function submitArgs(sessionFile: string) {
  return {
    sessionFile,
    to: "%12",
    id: ID,
    reportPath: reportArtifactPath(sessionFile, ID),
    bytes: 7,
    cliPath: CLI,
    from: "worker",
  };
}

describe("registerReport", () => {
  it("writes the artifact unchanged and registers it before any pane input", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const text = "line one\nline two — naïve";
      const report = registerReport({ sessionFile, to: "%12", text });

      assert.equal(isReportId(report.id), true);
      assert.equal(report.reportPath, reportArtifactPath(sessionFile, report.id));
      assert.equal(readFileSync(report.reportPath, "utf8"), text);
      assert.equal(report.bytes, Buffer.byteLength(text, "utf8"));

      const state = readReportLog(sessionFile);
      assert.equal(state.reports.length, 1);
      assert.deepEqual(state.reports[0], {
        id: report.id,
        to: "%12",
        bytes: report.bytes,
        report: report.reportPath,
        at: state.reports[0]!.at,
      });
      assert.equal(state.notifications.length, 0);
    });
  });

  it("throws when the artifact write fails, before any registration", () => {
    const sessionFile = join("/nonexistent-dir-pmux", "s.jsonl");
    assert.throws(() => registerReport({ sessionFile, to: "%12", text: "hi" }));
    assert.equal(existsSync(`${sessionFile}.sent`), false);
  });

  it("throws when the registration record cannot be appended", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      // A directory where the log file must go makes the append fail.
      mkdirSync(`${sessionFile}.sent`);
      assert.throws(() => registerReport({ sessionFile, to: "%12", text: "hi" }), /register/);
      // The artifact was written; the log holds no record of it.
      const state = readReportLog(sessionFile);
      assert.equal(state.reports.length, 0);
    });
  });
});

describe("submitReportPointer", () => {
  it("types a pointer naming the report and records the notification", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const result = await submitReportPointer(submitArgs(sessionFile), { submit });

      assert.equal(result.status, "submitted");
      assert.equal(result.submitted, true);
      assert.equal(result.enterAttempted, true);
      assert.equal(result.notificationRecorded, true);
      assert.equal(isReportId(result.token), true);

      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.pane, "%12");
      assert.equal(call.token, result.token);
      // The typed text is the one-line pointer: id, paths, ack command, token.
      assert.ok(!call.text.includes("\n"));
      assert.ok(call.text.includes(`pmux report ${ID}.`));
      assert.ok(call.text.includes(`node '${CLI}' ack`));
      assert.ok(call.text.endsWith(`[${VISIBILITY_TOKEN_PREFIX}${result.token}]`));

      const state = readReportLog(sessionFile);
      assert.equal(state.notifications.length, 1);
      // No injected endpoint and no inbox: the fallback ran, so the record
      // names the transport, the channel's reason (design D5) and the
      // inbox's reason (report-inbox D4).
      assert.deepEqual(state.notifications[0], {
        id: ID,
        token: result.token,
        to: "%12",
        bytes: 7,
        report: reportArtifactPath(sessionFile, ID),
        via: "tmux",
        channelError: "no-endpoint",
        inboxError: "no-inbox",
        at: state.notifications[0]!.at,
      });
    });
  });

  it("mints a fresh token for each attempt", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({ status: "submitted" });
      const first = await submitReportPointer(submitArgs(sessionFile), { submit });
      const second = await submitReportPointer(submitArgs(sessionFile), { submit });
      assert.notEqual(first.token, second.token);
    });
  });

  it("records no notification when the submission is refused", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({
        status: "not-submitted",
        enterAttempted: false,
        error: "the pane is in a mode",
      });
      const result = await submitReportPointer(submitArgs(sessionFile), { submit });
      assert.equal(result.status, "not-submitted");
      assert.equal(result.enterAttempted, false);
      assert.equal(result.notificationRecorded, false);
      assert.equal(result.error, "the pane is in a mode");
      assert.equal(readReportLog(sessionFile).notifications.length, 0);
    });
  });

  it("records no notification when the Enter's outcome is unknown", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({ status: "unknown", error: "can't find pane" });
      const result = await submitReportPointer(submitArgs(sessionFile), { submit });
      assert.equal(result.status, "unknown");
      assert.equal(result.submitted, false);
      assert.equal(result.enterAttempted, true);
      assert.equal(result.notificationRecorded, false);
      assert.equal(readReportLog(sessionFile).notifications.length, 0);
    });
  });

  it("delivers by the channel and never touches the pane on `emitted`", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const { submitChannel, calls: channelCalls } = fakeChannel({ status: "emitted" });
      const result = await submitReportPointer(submitArgs(sessionFile), { submit, submitChannel });

      // `emitted` ends the attempt: no verified-input call at all.
      assert.equal(calls.length, 0);
      assert.equal(result.status, "submitted");
      assert.equal(result.submitted, true);
      // The channel ran no pane input, so no Enter was attempted.
      assert.equal(result.enterAttempted, false);
      assert.equal(result.via, "channel");
      assert.equal(result.channelError, undefined);
      assert.equal(isReportId(result.token), true);

      // The channel request carried the report and the pointer.
      assert.equal(channelCalls.length, 1);
      assert.equal(channelCalls[0]!.id, ID);
      assert.equal(channelCalls[0]!.to, "%12");
      assert.equal(channelCalls[0]!.bytes, 7);
      assert.equal(channelCalls[0]!.token, result.token);

      // The submission was still recorded, with the channel's token.
      assert.equal(result.notificationRecorded, true);
      const state = readReportLog(sessionFile);
      assert.equal(state.notifications.length, 1);
      assert.equal(state.notifications[0]!.token, result.token);
    });
  });

  it("falls back to the same pointer through the verified input on `unavailable`", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const { submitChannel, calls: channelCalls } = fakeChannel({
        status: "unavailable",
        reason: "unarmed",
      });
      const result = await submitReportPointer(submitArgs(sessionFile), { submit, submitChannel });

      // One fallback call, with the SAME pointer the channel was offered.
      assert.equal(calls.length, 1);
      assert.equal(channelCalls.length, 1);
      assert.equal(calls[0]!.text, channelCalls[0]!.text);
      assert.equal(calls[0]!.token, channelCalls[0]!.token);
      assert.equal(calls[0]!.pane, "%12");
      assert.equal(result.status, "submitted");
      assert.equal(result.via, "tmux");
      assert.equal(result.channelError, "unarmed");
      assert.equal(result.token, calls[0]!.token);
      assert.equal(result.notificationRecorded, true);
    });
  });

  it("reports not-submitted with the channel error when both transports fail", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({
        status: "not-submitted",
        enterAttempted: false,
        error: "the pane is in a mode",
      });
      const { submitChannel, calls: channelCalls } = fakeChannel({
        status: "unavailable",
        reason: "refused",
      });
      const result = await submitReportPointer(submitArgs(sessionFile), { submit, submitChannel });

      assert.equal(result.status, "not-submitted");
      assert.equal(result.submitted, false);
      assert.equal(result.via, "tmux");
      assert.equal(result.channelError, "refused");
      assert.equal(result.error, "the pane is in a mode");
      assert.equal(result.notificationRecorded, false);
      // The channel was still the first try.
      assert.equal(channelCalls.length, 1);
      assert.equal(readReportLog(sessionFile).notifications.length, 0);
    });
  });

  it("passes the delivery env to the channel client, not the ambient one", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const env = { TMUX: "/tmp/tmux-1000/default,1,0" };
      const { submit } = fakeSubmit({ status: "submitted" });
      const { submitChannel, calls: channelCalls } = fakeChannel({
        status: "unavailable",
        reason: "no-endpoint",
      });
      await submitReportPointer(submitArgs(sessionFile), { submit, submitChannel, env });

      // The channel request carried the injected env — the same lookup the
      // mode gate reads — so an injected env routes the channel too.
      assert.equal(channelCalls.length, 1);
      assert.equal(channelCalls[0]!.env, env);
    });
  });

  it("never falls back on a missing or late ack after `emitted`", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const { submitChannel } = fakeChannel({ status: "emitted" });
      let t = 0;
      const result = await deliverReport(
        { ...submitArgs(sessionFile), ackTimeoutSeconds: 1 },
        {
          submit,
          submitChannel,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        },
      );
      // The channel emitted once, the pane was never touched, and the ack
      // timeout alone decided `acknowledged:false` — no second submission.
      assert.equal(calls.length, 0);
      assert.equal(result.submitted, true);
      assert.equal(result.via, "channel");
      assert.equal(result.acknowledged, false);
    });
  });
});

describe("awaitReportAck", () => {
  it("resolves at once when the ack is already logged, without sleeping", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      appendReportAck(sessionFile, ID);
      let sleeps = 0;
      const acked = await awaitReportAck(
        { sessionFile, id: ID, timeoutSeconds: 15 },
        {
          sleep: async () => {
            sleeps += 1;
          },
        },
      );
      assert.equal(acked, true);
      assert.equal(sleeps, 0);
    });
  });

  it("checks once and never sleeps for a zero timeout", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      let sleeps = 0;
      const acked = await awaitReportAck(
        { sessionFile, id: ID, timeoutSeconds: 0 },
        {
          sleep: async () => {
            sleeps += 1;
          },
        },
      );
      assert.equal(acked, false);
      assert.equal(sleeps, 0);
    });
  });

  it("sees an ack that lands mid-wait", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      let t = 0;
      let sleeps = 0;
      const acked = await awaitReportAck(
        { sessionFile, id: ID, timeoutSeconds: 5 },
        {
          now: () => t,
          sleep: async (ms) => {
            t += ms;
            sleeps += 1;
            if (sleeps === 2) appendReportAck(sessionFile, ID);
          },
        },
      );
      assert.equal(acked, true);
      assert.equal(sleeps, 2);
    });
  });

  it("times out without an ack", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      let t = 0;
      const acked = await awaitReportAck(
        { sessionFile, id: ID, timeoutSeconds: 2 },
        {
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        },
      );
      assert.equal(acked, false);
      assert.ok(t >= 2000);
      assert.ok(t <= 2000 + REPORT_ACK_POLL_MS);
    });
  });
});

describe("deliverReport", () => {
  it("submits and reports acknowledged when the ack lands in the wait", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({ status: "submitted" });
      let t = 0;
      let sleeps = 0;
      const result = await deliverReport(
        { ...submitArgs(sessionFile), ackTimeoutSeconds: 15 },
        {
          submit,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
            sleeps += 1;
            if (sleeps === 3) appendReportAck(sessionFile, ID);
          },
        },
      );
      assert.equal(result.submitted, true);
      assert.equal(result.acknowledged, true);
      assert.equal(result.notificationRecorded, true);
    });
  });

  it("submits and reports unacknowledged when the wait times out", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({ status: "submitted" });
      let t = 0;
      const result = await deliverReport(
        { ...submitArgs(sessionFile), ackTimeoutSeconds: 1 },
        {
          submit,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        },
      );
      assert.equal(result.submitted, true);
      assert.equal(result.acknowledged, false);
      assert.equal(result.notificationRecorded, true);
    });
  });

  it("never waits when the submission was refused", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit } = fakeSubmit({ status: "not-submitted", enterAttempted: false });
      let sleeps = 0;
      const result = await deliverReport(
        { ...submitArgs(sessionFile), ackTimeoutSeconds: 15 },
        {
          submit,
          sleep: async () => {
            sleeps += 1;
          },
        },
      );
      assert.equal(result.status, "not-submitted");
      assert.equal(result.acknowledged, false);
      assert.equal(sleeps, 0);
    });
  });

  it("does no ack check at all without a timeout — the wrapper rechecks itself", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      // An ack is already logged: a no-wait delivery still reports
      // unacknowledged, because the caller owns the recheck-before-retry.
      appendReportAck(sessionFile, ID);
      const { submit } = fakeSubmit({ status: "submitted" });
      let sleeps = 0;
      const result = await deliverReport(submitArgs(sessionFile), {
        submit,
        sleep: async () => {
          sleeps += 1;
        },
      });
      assert.equal(result.submitted, true);
      assert.equal(result.acknowledged, false);
      assert.equal(sleeps, 0);
      // The delivery itself was still recorded.
      assert.equal(readReportLog(sessionFile).notifications.length, 1);
    });
  });
});

describe("reportAcknowledged", () => {
  it("reflects the ack records of the session log", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "s.jsonl");
      assert.equal(reportAcknowledged(sessionFile, ID), false);
      appendReportAck(sessionFile, ID);
      assert.equal(reportAcknowledged(sessionFile, ID), true);
      assert.equal(reportAcknowledged(sessionFile, "bb".repeat(16)), false);
    });
  });
});

describe("submitReportPointer through the inbox", () => {
  /** The inbox env: a TMUX socket and a runtime dir inside `dir`. */
  function inboxEnv(dir: string): NodeJS.ProcessEnv {
    return { TMUX: "/tmp/tmux-1000/default,1,0", XDG_RUNTIME_DIR: join(dir, "run") };
  }

  it("is carried by a live monitor, with no channel request and no pane input", async () => {
    await withTempDirAsync(async (dir) => {
      const env = inboxEnv(dir);
      writeMonitorMarker(inboxDirPath({ env, targetPane: "%12" })!, process.pid);
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const { submitChannel, calls: channelCalls } = fakeChannel({ status: "emitted" });
      const result = await submitReportPointer(submitArgs(sessionFile), {
        submit,
        submitChannel,
        env,
      });

      assert.equal(result.via, "inbox");
      assert.equal(result.submitted, true);
      assert.equal(result.enterAttempted, false);
      assert.equal(result.notificationRecorded, true);
      assert.equal(result.inboxError, undefined);
      assert.equal(calls.length, 0);
      assert.equal(channelCalls.length, 0);

      const notification = readReportLog(sessionFile).notifications[0]!;
      assert.equal(notification.via, "inbox");
      assert.equal(notification.inboxError, undefined);
      const entry = JSON.parse(
        readFileSync(join(inboxDirPath({ env, targetPane: "%12" })!, `${ID}.json`), "utf8"),
      );
      assert.equal(entry.from, "worker");
      assert.equal(entry.report, reportArtifactPath(sessionFile, ID));
      assert.equal(entry.delivery, 1);
    });
  });

  it("falls back to the channel with unmonitored as the inbox reason", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const { submitChannel, calls: channelCalls } = fakeChannel({ status: "emitted" });
      const result = await submitReportPointer(submitArgs(sessionFile), {
        submit,
        submitChannel,
        env: inboxEnv(dir),
      });

      assert.equal(result.via, "channel");
      assert.equal(result.inboxError, "unmonitored");
      assert.equal(calls.length, 0);
      assert.equal(channelCalls.length, 1);
      assert.equal(readReportLog(sessionFile).notifications[0]!.inboxError, "unmonitored");
    });
  });

  it("falls back to the pane input with write-failed when the entry cannot be written", async () => {
    await withTempDirAsync(async (dir) => {
      const env = inboxEnv(dir);
      const inbox = inboxDirPath({ env, targetPane: "%12" })!;
      writeMonitorMarker(inbox, process.pid);
      // A directory where the entry should go makes the rename fail.
      mkdirSync(join(inbox, `${ID}.json`), { recursive: true });
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const { submitChannel } = fakeChannel({ status: "unavailable", reason: "refused" });
      const result = await submitReportPointer(submitArgs(sessionFile), {
        submit,
        submitChannel,
        env,
      });

      assert.equal(result.via, "tmux");
      assert.equal(result.inboxError, "write-failed");
      assert.equal(result.channelError, "refused");
      assert.equal(calls.length, 1);
    });
  });

  it("never falls back on a missing ack: one entry, no second submission", async () => {
    await withTempDirAsync(async (dir) => {
      const env = inboxEnv(dir);
      writeMonitorMarker(inboxDirPath({ env, targetPane: "%12" })!, process.pid);
      const sessionFile = join(dir, "s.jsonl");
      const { submit, calls } = fakeSubmit({ status: "submitted" });
      const delivery = await deliverReport(
        { ...submitArgs(sessionFile), ackTimeoutSeconds: 0 },
        { submit, env, submitChannel: fakeChannel({ status: "emitted" }).submitChannel },
      );

      assert.equal(delivery.submitted, true);
      assert.equal(delivery.via, "inbox");
      assert.equal(delivery.acknowledged, false);
      assert.equal(calls.length, 0);
    });
  });

  it("counts a re-delivery up in the entry's delivery field", async () => {
    await withTempDirAsync(async (dir) => {
      const env = inboxEnv(dir);
      const inbox = inboxDirPath({ env, targetPane: "%12" })!;
      writeMonitorMarker(inbox, process.pid);
      const sessionFile = join(dir, "s.jsonl");
      await submitReportPointer(submitArgs(sessionFile), { env });
      await submitReportPointer(submitArgs(sessionFile), { env });

      const entry = JSON.parse(readFileSync(join(inbox, `${ID}.json`), "utf8"));
      assert.equal(entry.delivery, 2);
      assert.equal(readReportLog(sessionFile).notifications.length, 2);
    });
  });
});
