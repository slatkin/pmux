/**
 * The report viewer (report-viewer capability; designs D1, D8 and D9).
 *
 * `reportsDialogOuter` is the outer side: it opens the popup over the
 * caller's pane through `runDialog` and returns the one result line the
 * host prints — pi's `/pmux-reports` shows it through `ctx.ui.notify`,
 * the Claude Code `pmux-reports` skill prints it on stdout.
 *
 * `reportsDialogInner` is the inner side: `cli.ts reports --inner` runs it
 * in the popup. It lists the caller pane's report history newest first —
 * each row is the sender, the registration time and the report's state
 * (`pending`, `acknowledged` or `missing` for a gone report file, from
 * `readReportLog` on the record's session). Enter opens the report file in
 * `$PAGER`/`less` on the TTY and returns to the list; Escape cancels.
 * Reading a report never writes an `ack` record and touches neither the
 * inbox nor the history. An empty history answers "no reports".
 */
import {
  DIALOG_STATE_ENV,
  dialogStatePath,
  markDialogOpen,
  runDialog,
  writeDialogCancel,
  writeDialogDone,
  type RunDialogDeps,
} from "./dialog-host.ts";
import { errorMessage, type RolesChoose } from "./dialog-roles.ts";
import { chooseFromList, runOnTty } from "./dialog-ui.ts";
import { isFile } from "./launch-build.ts";
import { historyDirPath, listHistory, type HistoryRecord } from "./report-history.ts";
import { readReportLog } from "./report-receipt.ts";

/** The popup title (`-T`) and the list's title line. */
export const REPORTS_DIALOG_TITLE = "pmux reports";

/** The result line an empty history answers (spec: "No reports"). */
export const NO_REPORTS_LINE = "no reports";

/** The pager run on a report file; `runOnTty`-compatible. */
export type ReportPager = (path: string) => { status: number | null; error?: Error };

/**
 * Injected pieces for both sides of the report viewer; every default is
 * the real thing. The `RunDialogDeps` fields cover the outer side's wait,
 * the additions cover the inner side's TTY list and pager.
 */
export interface ReportsDialogDeps extends RunDialogDeps {
  /** The list widget; defaults to `chooseFromList` on the popup's TTY. */
  choose?: RolesChoose;
  /** The report file's pager run; defaults to `$PAGER`/`less` on the TTY. */
  runPager?: ReportPager;
}

/** One list entry: the record plus its resolved ack and file state. */
interface ReportEntry {
  record: HistoryRecord;
  /** The session's log holds an `ack` for the report id. */
  acknowledged: boolean;
  /** The report file is gone: the row shows it and Enter does not open it. */
  missing: boolean;
}

/** Read the ack and file state of every record; the log is the sole ack source. */
function reportEntries(records: readonly HistoryRecord[]): ReportEntry[] {
  return records.map((record) => ({
    record,
    acknowledged: readReportLog(record.session).ackedIds.has(record.id),
    missing: !isFile(record.report),
  }));
}

/** The display time of a record: the ISO date and minute of the registration. */
function reportTime(at: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at);
  return match === null ? at : `${match[1]} ${match[2]}`;
}

/** One row of the report list: sender, time and state (spec: "Report list"). */
function reportRow(entry: ReportEntry): string {
  const state = entry.missing ? "missing" : entry.acknowledged ? "acknowledged" : "pending";
  return `${entry.record.from}  ${reportTime(entry.record.at)}  ${state}`;
}

/** What the inner command line gives the dialog. */
export interface ReportsInnerArgs {
  /** The caller's pane id: the pane whose history the viewer lists. */
  pane: string;
  /** The popup's environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the report viewer inside the popup: write `open`, list the caller
 * pane's history and write `done` or `cancel`. Throws when the state-file
 * env is missing — the outer side's `open` deadline treats a thrown inner
 * as a failed popup. A failure after `open` becomes a `done` record whose
 * line carries the error, so the user sees it instead of a silent cancel.
 */
export async function reportsDialogInner(
  args: ReportsInnerArgs,
  deps: ReportsDialogDeps = {},
): Promise<void> {
  const env = args.env ?? process.env;
  const statePath = dialogStatePath(env);
  if (statePath === null) {
    throw new Error(`the inner dialog needs ${DIALOG_STATE_ENV} in its environment`);
  }
  markDialogOpen(statePath);

  try {
    // The popup env's TMUX names the same server as the caller's, so the
    // history key the `--pane` argument selects is the caller pane's
    // (spec: "History path"). No socket means no history: "no reports".
    const dir = historyDirPath({ env, targetPane: args.pane });
    const records = dir === null ? [] : listHistory(dir);
    if (records.length === 0) {
      writeDialogDone(statePath, { line: NO_REPORTS_LINE });
      return;
    }
    const choose = deps.choose ?? chooseFromList;
    const runPager = deps.runPager ?? ((path: string) => runOnTty(env.PAGER || "less", [path]));
    for (;;) {
      // The entries rebuild on every pass: a report read here stays
      // pending, but an `ack` that lands while the viewer is up shows.
      const entries = reportEntries(records);
      const choice = await choose(entries.map(reportRow), {
        title: REPORTS_DIALOG_TITLE,
      });
      if (choice === null) {
        writeDialogCancel(statePath);
        return;
      }
      const entry = entries[choice.index]!;
      // A missing report file does not open (spec: "Report list"); the
      // list just shows again. A pager exit — success or failure — also
      // returns to the list.
      if (!entry.missing) runPager(entry.record.report);
    }
  } catch (error) {
    writeDialogDone(statePath, { line: `report viewer failed: ${errorMessage(error)}` });
  }
}

/** What a host command gives the outer side. */
export interface ReportsOuterArgs {
  /** The caller's cwd: the popup's start directory. */
  cwd: string;
  /** The resolved agent config directory, passed to the popup env. */
  agentDir: string;
  /** The caller's environment (holds `TMUX`, `TMUX_PANE`, `PATH`, `PAGER`…). */
  env: NodeJS.ProcessEnv;
  /** The Claude Code path's wait limit; unset waits with no limit (pi). */
  stopAfterMs?: number;
}

/**
 * Open the report viewer in a popup over the caller's pane and return the
 * result line to report: the inner side's line on `done` ("no reports" or
 * a failure), a closed-viewer line on `cancel`, or the still-open line
 * after `stopAfterMs`. Throws when no popup can open (outside tmux, a
 * `display-popup` error, no `open` state).
 */
export async function reportsDialogOuter(
  args: ReportsOuterArgs,
  deps: RunDialogDeps = {},
): Promise<string> {
  const outcome = await runDialog(
    {
      title: REPORTS_DIALOG_TITLE,
      innerArgs: ["reports", "--inner", "--pane", args.env.TMUX_PANE ?? ""],
      cwd: args.cwd,
      agentDir: args.agentDir,
      env: args.env,
      ...(args.stopAfterMs !== undefined ? { stopAfterMs: args.stopAfterMs } : {}),
    },
    deps,
  );
  if (outcome.kind === "done") {
    const line = outcome.result.line;
    return typeof line === "string" && line.length > 0 ? line : "done";
  }
  if (outcome.kind === "cancel") return "report viewer closed";
  return outcome.line;
}
