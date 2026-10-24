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
import { agentPrompt, closeSurface } from "./tmux.ts";
import { exitSidecarPath, readExitSidecar, writeExitSidecar } from "./exit-sidecar.ts";
import { encodePaneText } from "./pane-input.ts";
import { countReportsTo } from "./report-receipt.ts";
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
  /** Parent wake-up; defaults to the tmux pane-input primitive. */
  sendToParent?: (parent: string, text: string) => void;
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
  // The baseline matters because `resume` reuses the session file: receipts
  // from earlier runs must not suppress the wake-up of this run.
  const reportsBefore = parent === undefined ? 0 : countReportsTo(spec.sessionFile, parent);

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

  // A send-mode child that exits without a report leaves the parent asleep
  // forever; wake it with the exit state so it can read the session. A ping
  // sidecar carries the question, so the wake-up quotes it directly. A user
  // cancel wakes no one (quiet-cancel-exit D2).
  if (
    parent !== undefined &&
    sidecar?.type !== "cancelled" &&
    countReportsTo(spec.sessionFile, parent) <= reportsBefore
  ) {
    const cliHint = deps.cliPath ?? "<pmux-cli>";
    let wake: string;
    if (sidecar?.type === "ping" && typeof sidecar.message === "string") {
      wake = `${spec.name} pinged: ${sidecar.message}`;
    } else {
      const state = sidecar?.type ?? (code === 0 ? "exited" : `crashed (code ${code})`);
      wake = `${spec.name} ${state} without sending a report. Read its last message: node ${cliHint} last-message --session ${spec.sessionFile ?? "<session>"}`;
    }
    try {
      // The ping question is the child's own text and can span lines, so it
      // is encoded like a report: the parent reads the question as one
      // input.
      (deps.sendToParent ?? agentPrompt)(parent, encodePaneText(wake));
    } catch (error) {
      writeErr(
        `Failed to wake parent ${parent}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
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
