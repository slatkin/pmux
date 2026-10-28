/**
 * Pane-side run wrapper: start a child from a launch spec with no shell,
 * report its exit, wake the parent when a send-mode child left no report, and
 * (skill launches only) close the pane after a `done` or `handoff` sidecar.
 *
 * This is the body of the CLI's `run` subcommand. `runSpec` returns the
 * child's exit code, so the CLI can exit with it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildPaneTitle, type LaunchSpec } from "./launch.ts";
import { REPORT_PROTOCOL } from "./launch-build.ts";
import { agentPrompt, closeSurface } from "./tmux.ts";
import { exitSidecarPath, readExitSidecar, writeExitSidecar } from "./exit-sidecar.ts";
import { encodePaneText } from "./pane-input.ts";
import { countReportsTo, readReportLog } from "./report-receipt.ts";
import {
  deliverReport as sharedDeliverReport,
  registerReport,
  reportAcknowledged,
  type DeliverReportArgs,
  type DeliverReportResult,
  type RegisteredReportFile,
} from "./report-delivery.ts";
import { isTerminalChildStatus, readChildStatus, writeChildStatus } from "./status-file.ts";

/**
 * pi wipes a title emitted before it finishes booting (it enters the
 * alternate screen). The old backgrounded shell line used the same 8 s
 * heuristic; the emission is best-effort.
 */
const OSC_TITLE_DELAY_MS = 8000;

/** `sh`'s "command not found" status, used when the child could not start. */
const SPAWN_FAILED_CODE = 127;

/** Injected pieces of the wrapper; the defaults are the real process. */
export interface RunSpecDeps {
  /** Base environment holding `TMUX_PANE`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Sentinel and OSC title sink; defaults to `process.stdout.write`. */
  stdout?: (text: string) => void;
  /** Spawn-failure message sink; defaults to `process.stderr.write`. */
  stderr?: (text: string) => void;
  /** Close grace timer; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Pane close; defaults to the tmux backend. */
  closePane?: (pane: string) => void;
  /**
   * Parent wake-up of an unmarked send-mode child: the legacy behavior types
   * the raw text. Defaults to the tmux pane-input primitive. A
   * `file-ack-v1` spec never uses it — its contact is `deliverReport`.
   */
  sendToParent?: (parent: string, text: string) => void;
  /**
   * Parent delivery of a `file-ack-v1` run: one registered report's pointer —
   * an exit re-delivery or the durable wake artifact. Defaults to the shared
   * `deliverReport` flow (verified submission, no ack wait: the wrapper
   * rechecks the ack itself); a test injects a recorder.
   */
  deliverReport?: (args: DeliverReportArgs) => Promise<DeliverReportResult>;
  /** The CLI path the send-mode wake-up message names for reading the session. */
  cliPath?: string;
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** Map a finished child to its report code, printing why it could not start. */
function reportExit(
  outcome: ChildOutcome,
  command: string,
  writeErr: (text: string) => void,
): number {
  if (outcome.error !== undefined) {
    writeErr(`Failed to start ${command}: ${outcome.error.message}\n`);
    return SPAWN_FAILED_CODE;
  }
  if (outcome.signal !== null) return 128 + constants.signals[outcome.signal];
  const code = outcome.code ?? SPAWN_FAILED_CODE;
  if (code < 0) {
    // A spawn failure can surface as the negative errno on `close` when the
    // `error` event was not observed first.
    writeErr(`Failed to start ${command} (exit code ${code})\n`);
    return SPAWN_FAILED_CODE;
  }
  return code;
}

/** The sidecar shape the wake wording reads. */
interface WakeSidecar {
  type?: string;
  message?: unknown;
}

/** One contact row: a registered report to re-deliver, or the run's wake text. */
type WakeRow =
  | { kind: "report"; id: string; reportPath: string; bytes: number }
  | { kind: "wake"; text: string };

/** The wake wording both contact shapes share: the exit state, or the quoted
 * ping question. The launch spec's name wins — the parent knows the launch,
 * not the child's own sidecar name.
 */
function wakeText(
  name: string,
  cliPath: string,
  sessionFile: string,
  sidecar: WakeSidecar | undefined,
  code: number,
): string {
  if (sidecar?.type === "ping" && typeof sidecar.message === "string") {
    return `${name} pinged: ${sidecar.message}`;
  }
  // A sidecar names its own state; a child with none gets `exited` for code 0
  // and `crashed (code <n>)` when the wrapper's `error` sidecar, or a terminal
  // status, took the crash's place.
  const state = sidecar?.type ?? (code === 0 ? "exited" : `crashed (code ${code})`);
  return `${name} ${state} without sending a report. Read its last message: node ${cliPath} last-message --session ${sessionFile}`;
}

/**
 * The contact context one send-mode run assembles once (design D8) and
 * passes whole: the parent's address, the wording inputs, and the mode and
 * baseline values that decide the rows. Both the row builder
 * (`contactRows`) and the deliverer (`contactParent`) read it.
 */
interface ContactContext {
  /** The parent pane the contact targets. */
  parent: string;
  /** The child's final sidecar, for the wake wording. */
  sidecar: WakeSidecar | undefined;
  /** The child's exit code, for the wake wording. */
  code: number;
  /** Whether the spec runs the `file-ack-v1` protocol. */
  marked: boolean;
  /** The session file the event log and artifacts live beside. */
  sessionFile: string;
  /** The spec's child name, for the wake wording. */
  name: string;
  /** The CLI path the contact names for reading the session and acknowledging. */
  cliPath: string;
  /** The report IDs registered before this run spawned, or null when unmarked. */
  baselineReportIds: Set<string> | null;
  /** The parent's legacy receipt count before this run spawned. */
  receiptsBefore: number;
}

/**
 * The contact rows of a send-mode run, after the sentinel (design D8), in
 * delivery order. The baseline was read before spawn, so an earlier run's
 * registrations and receipts are out of scope whatever they decide here: a
 * resumed run neither re-delivers their reports nor lets their counts
 * suppress its wake.
 *
 * A marked run returns every current-run report addressed to the parent in
 * registration order, or — when the run produced no parent report — the one
 * wake-text row. A legacy run's contact is a raw text, so it carries the
 * wake row only when the child reported nothing new to the parent.
 */
function contactRows(context: ContactContext): WakeRow[] {
  if (context.marked) {
    // Only registrations newer than the baseline, and only the parent's
    // address: another pane's report is that pane's business, and an older
    // run's report was already offered once (design D8).
    const log = readReportLog(context.sessionFile);
    const reports: WakeRow[] = log.reports.flatMap((report) =>
      report.to === context.parent && !context.baselineReportIds?.has(report.id)
        ? [
            {
              kind: "report" as const,
              id: report.id,
              reportPath: report.report,
              bytes: report.bytes,
            },
          ]
        : [],
    );
    if (reports.length > 0) return reports;
  }
  // Parent contact without a report ID still counts against the wake-up:
  // a kindless receipt line, addressed to the parent, means an unmarked
  // `send` typed its report there. A legacy receipt is its only record;
  // `countReportsTo` decides this count, the same function the baseline
  // applied before the spawn, so one function counts both sides.
  const receiptsAfter = countReportsTo(context.sessionFile, context.parent);
  if (receiptsAfter <= context.receiptsBefore) {
    return [
      {
        kind: "wake",
        text: wakeText(
          context.name,
          context.cliPath,
          context.sessionFile,
          context.sidecar,
          context.code,
        ),
      },
    ];
  }
  return [];
}

/**
 * The registered fields one marked row delivers (design D8), or null when a
 * report row is already acked and its delivery is skipped. A report row
 * supplies its registration as is; a wake row registers itself first, so
 * both rows end in one `deliver` call. Throwing here (a failed wake-row
 * registration) is the row's one failure path, caught by the caller's try.
 */
function markedDeliverArgs(row: WakeRow, context: ContactContext): RegisteredReportFile | null {
  if (row.kind === "report") {
    if (reportAcknowledged(context.sessionFile, row.id)) return null;
    return { id: row.id, reportPath: row.reportPath, bytes: row.bytes };
  }
  return registerReport({
    sessionFile: context.sessionFile,
    to: context.parent,
    text: row.text,
  });
}

/**
 * Deliver every contact row to the parent, one try per row (design D8): a
 * failed contact names the parent on stderr and does not change the child's
 * exit code, and a later row still runs. The marked rows go through the
 * delivery seam; the legacy row keeps the raw pane-input primitive.
 */
async function contactParent(args: {
  /** The contact the rows were decided from. */
  context: ContactContext;
  deliverReport?: (args: DeliverReportArgs) => Promise<DeliverReportResult>;
  sendToParent?: (parent: string, text: string) => void;
  writeErr: (text: string) => void;
}): Promise<void> {
  const context = args.context;
  // The delivery seam: the shared flow, or the injected recorder.
  const deliver = args.deliverReport ?? sharedDeliverReport;
  for (const row of contactRows(context)) {
    // One row, one try: a failed contact names the parent on stderr and does
    // not change the child's exit code (design D8), and a later row still
    // runs.
    //
    // The failure wording is written once, in `fail`: the flow's own refusal
    // and the catch below name the parent the same way because `detail` is
    // known per row before the try.
    const detail = row.kind === "report" ? `re-deliver report ${row.id} to` : "wake";
    const fail = (message: string): void => {
      args.writeErr(`Failed to ${detail} parent ${context.parent}: ${message}\n`);
    };
    try {
      if (context.marked) {
        // file-ack-v1 (design D8): a durable artifact and its pointer stand
        // in for the raw text. A report row re-delivers the same ID with a
        // fresh token and no ack wait — the parent answers one pointer per
        // report or none — and the ack is rechecked immediately before the
        // retry, so one acked late (the parent ran the pointer's command
        // while the child ran on) is skipped. The wake row becomes its own
        // artifact, registered as `send` registers a report, delivered
        // through the same flow.
        const toDeliver = markedDeliverArgs(row, context);
        if (toDeliver === null) continue;
        const result = await deliver({
          sessionFile: context.sessionFile,
          to: context.parent,
          id: toDeliver.id,
          reportPath: toDeliver.reportPath,
          bytes: toDeliver.bytes,
          cliPath: context.cliPath,
          from: context.name,
        });
        if (!result.submitted) fail(result.error ?? result.status);
      } else if (row.kind === "wake") {
        // Legacy text contact — an unmarked spec keeps its behavior (design
        // D1). The ping question is the child's own text and can span lines,
        // so it is encoded like a report: the parent reads the question as
        // one input.
        (args.sendToParent ?? agentPrompt)(context.parent, encodePaneText(row.text));
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Start `spec.command` with `spec.args` (plus `@<prompt>` when a prompt path
 * is given), inherit the pane's stdio, print the sentinel, and return the
 * code the CLI must exit with.
 */
export async function runSpec(
  spec: LaunchSpec,
  prompt?: string,
  deps: RunSpecDeps = {},
): Promise<number> {
  const base = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const closePane = deps.closePane ?? closeSurface;
  // The pane the wrapper runs in: this process's own tmux pane.
  const pane = base.TMUX_PANE;

  const env: NodeJS.ProcessEnv = { ...base, ...spec.env };
  // The spec is pane-independent: whichever pane runs it becomes the child's
  // surface.
  if (pane) env.PI_PMUX_SURFACE = pane;

  // Only a send-mode spec with a parent may contact the parent. In `last`
  // mode, and for any spec without a parent, the wrapper contacts nobody: the
  // orchestrator's wake is the `wait` command, as before.
  const parent = spec.report === "send" ? spec.parent : undefined;
  // A marked spec moves the contact onto the file-ack-v1 flow (design D1):
  // the marker is read from the spec env, never from this process's env, so
  // this wrapper's own environment cannot upgrade an unmarked launch.
  const marked = parent !== undefined && spec.env.PI_PMUX_REPORT_PROTOCOL === REPORT_PROTOCOL;
  if (marked && spec.sessionFile === undefined) {
    // Not a silent legacy fallback (design D1): the flow needs the event log
    // and the artifacts beside the session file.
    throw new Error(
      "launch spec is marked for PI_PMUX_REPORT_PROTOCOL=file-ack-v1 but holds no session file",
    );
  }
  // The baseline matters because `resume` reuses the session file: receipts
  // from earlier runs must not suppress the wake-up of this run.
  const reportsBefore = parent === undefined ? 0 : countReportsTo(spec.sessionFile, parent);
  // A marked run snapshots the registered report IDs too (design D8): after
  // the sentinel it examines only registrations newer than this set, so an
  // earlier run's reports are neither re-delivered nor counted here.
  const reportIdsBefore = marked
    ? new Set(readReportLog(spec.sessionFile).reports.map((report) => report.id))
    : null;

  const args = prompt ? [...spec.args, `@${prompt}`] : [...spec.args];

  // Best-effort title, late enough to survive the child's boot. Unref'd so it
  // can never hold the wrapper open.
  const title = spec.title ?? buildPaneTitle(spec.name);
  let titleTimer: NodeJS.Timeout | undefined;
  if (title.length > 0) {
    titleTimer = setTimeout(() => {
      try {
        write(`\x1b]2;${title}\x07`);
      } catch {
        // Best-effort: a broken stdout must not kill the wrapper.
      }
    }, OSC_TITLE_DELAY_MS);
    titleTimer.unref();
  }

  // Ignore SIGINT while the child runs so Ctrl-C reaches the child and the
  // wrapper stays alive to print the sentinel.
  const ignoreSigint = (): void => {};
  process.on("SIGINT", ignoreSigint);

  let outcome: ChildOutcome;
  try {
    const child = spawn(spec.command, args, {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env,
      stdio: "inherit",
    });
    outcome = await new Promise<ChildOutcome>((resolve) => {
      child.once("error", (error: Error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
        resolve({ code, signal }),
      );
    });
  } finally {
    process.removeListener("SIGINT", ignoreSigint);
    if (titleTimer) clearTimeout(titleTimer);
  }

  const code = reportExit(outcome, spec.command, writeErr);
  write(`__SUBAGENT_DONE_${code}__\n`);

  // A child that died left `working` or `idle` on disk and no sidecar: mark it
  // blocked with the exit code so a status wait ends, and write the `error`
  // sidecar the parent polls, so a crashed child ends the run at once instead
  // of leaving the parent to poll until the idle watchdog gives up (forever, for
  // an interactive child). A clean completion or a ping (a sidecar, or a
  // terminal status the child wrote itself) is left as is.
  if (spec.sessionFile && !existsSync(exitSidecarPath(spec.sessionFile))) {
    const status = readChildStatus(spec.sessionFile);
    if (status === null || !isTerminalChildStatus(status.status)) {
      const reason =
        code === 0
          ? "child exited with code 0 without calling pmux_done"
          : `child exited with code ${code}`;
      writeChildStatus(spec.sessionFile, "blocked", reason);
      writeExitSidecar(spec.sessionFile, {
        type: "error",
        errorMessage: reason,
        // Marks this sidecar as the wrapper's, not the child's own error path.
        source: "wrapper",
        exitCode: code,
      });
    }
  }

  // The child's final sidecar, read once: the wake-up and the close-on-done
  // step below both look at it.
  const sidecar = spec.sessionFile ? readExitSidecar(spec.sessionFile) : undefined;

  // Every parent contact runs after the sentinel and before the close-on-done
  // step (design D8). A cancelled child wakes no one (quiet-cancel-exit D2);
  // a contact failure is stderr alone, and the exit code stands.
  if (parent !== undefined && sidecar?.type !== "cancelled" && spec.sessionFile) {
    await contactParent({
      context: {
        parent,
        sidecar,
        code,
        marked,
        sessionFile: spec.sessionFile,
        name: spec.name,
        cliPath: deps.cliPath ?? "<pmux-cli>",
        baselineReportIds: reportIdsBefore,
        receiptsBefore: reportsBefore,
      },
      deliverReport: deps.deliverReport,
      sendToParent: deps.sendToParent,
      writeErr,
    });
  }

  if (spec.closeOnDone && spec.sessionFile && pane) {
    // Read the sidecar directly rather than through `interpretExitSidecar`:
    // that function maps unknown payloads to `done`, which would close panes
    // on malformed sidecars. `handoff` closes like `done` — the child ended
    // cleanly and its result lives in the sidecar and its session file. So
    // does `cancelled`: the user stopped the child (quiet-cancel-exit D4).
    const sidecarType = sidecar?.type;
    if (sidecarType === "done" || sidecarType === "handoff" || sidecarType === "cancelled") {
      if (spec.closeOnDone.graceMs > 0) await sleep(spec.closeOnDone.graceMs);
      closePane(pane);
    }
  }

  return code;
}
