/**
 * The dialog host: the outer/inner state-file protocol of design D1.
 *
 * The OUTER side (`runDialog`) runs in the caller's pane with the caller's
 * env. It makes a private temp dir holding the state file `S`, opens the
 * dialog with `tmux display-popup` over the caller's pane, passing `S` as
 * `-e PMUX_DIALOG_STATE=S`, then waits on `S` — never on the tmux call, and
 * never under the five-second tmux call budget, so a dialog can stay open
 * for minutes.
 *
 * The INNER side (`cli.ts <dialog> --inner`, in the popup) writes `S`:
 * `{"state":"open","pid":n}` at start, then `{"state":"done", ...result}`
 * or `{"state":"cancel"}` at the end. `dialogStatePath`, `markDialogOpen`,
 * `writeDialogDone` and `writeDialogCancel` are its half of the protocol.
 *
 * The wait ends when `S` is final, when the inner pid dies without a final
 * state (an Escape, `C-c` or a closed popup reads as a cancel), or — on a
 * host with a time limit — when `stopAfterMs` passes: the popup call is
 * then unref'ed so this process can exit while the dialog keeps running
 * (the inner side does every final action on that path). A state file that
 * never reaches `open` within ten seconds of the popup call is a failed
 * popup.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENTS_DIR } from "./launch-build.ts";
import { defaultSleep } from "./sleep.ts";
import { openPopup, tmuxSetupHint, type PopupHandle } from "./tmux.ts";

/** The env key that carries the state file path into the popup. */
export const DIALOG_STATE_ENV = "PMUX_DIALOG_STATE";

/** The wait poll cadence design D1 pins. */
export const DIALOG_POLL_MS = 200;

/** A state file that shows no `open` within this long is a failed popup. */
export const DIALOG_OPEN_TIMEOUT_MS = 10_000;

/**
 * The Claude Code path's wait limit: inside the 2-minute Bash-tool stop, so
 * the outer side prints its line and exits before the host kills it (D1).
 */
export const DIALOG_HOST_LIMIT_MS = 100_000;

/** The line the outer side reports when its limit passes with the dialog up. */
export const DIALOG_STILL_OPEN_LINE = "dialog still open; it finishes in the popup";

/** `{"state":"open","pid":n}` — the inner side's first write. */
export interface DialogOpenState {
  state: "open";
  pid: number;
}

/** `{"state":"done", ...result}` — the dialog completed; result fields ride along. */
export interface DialogDoneState {
  state: "done";
  [key: string]: unknown;
}

/** `{"state":"cancel"}` — the user cancelled the dialog. */
export interface DialogCancelState {
  state: "cancel";
}

export type DialogState = DialogOpenState | DialogDoneState | DialogCancelState;

/** How the outer side's wait ended. */
export type DialogOutcome =
  | { kind: "done"; result: Record<string, unknown> }
  | { kind: "cancel" }
  | { kind: "still-open"; line: string };

/**
 * Read the state file. Returns the parsed record, or null when the file is
 * missing or is not a JSON object with a known state (a torn write reads as
 * not-yet-written).
 */
export function readDialogState(path: string): DialogState | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (data === null || typeof data !== "object") return null;
    const state = (data as { state?: unknown }).state;
    if (state === "open") {
      const pid = (data as { pid?: unknown }).pid;
      return typeof pid === "number" && Number.isInteger(pid) ? { state: "open", pid } : null;
    }
    if (state === "done" || state === "cancel") return data as DialogState;
    return null;
  } catch {
    return null;
  }
}

/** Write one state record as a whole-file replace, like the status file. */
function writeDialogState(path: string, record: DialogState): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
}

/** The state file path the popup env carries, or null when there is none. */
export function dialogStatePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[DIALOG_STATE_ENV];
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** The inner side's first write: the dialog is up, and this is its pid. */
export function markDialogOpen(path: string, pid: number = process.pid): void {
  writeDialogState(path, { state: "open", pid });
}

/** The inner side's completed write; `result` fields spread into the record. */
export function writeDialogDone(path: string, result: Record<string, unknown>): void {
  writeDialogState(path, { state: "done", ...result });
}

/** The inner side's cancel write. */
export function writeDialogCancel(path: string): void {
  writeDialogState(path, { state: "cancel" });
}

/** The default liveness check for the inner pid: signal 0, EPERM is alive. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a dialog run needs from the caller. */
export interface RunDialogArgs {
  /** The popup title (`-T`): names the dialog. */
  title: string;
  /** The inner argv after the cli path: `<dialog> --inner <args>`. */
  innerArgs: string[];
  /** The popup's start directory (`-d`): the caller's cwd. */
  cwd: string;
  /**
   * The resolved agent config dir: `-e PI_CODING_AGENT_DIR` so the inner
   * side and the processes it starts resolve the same directory (D1).
   */
  agentDir: string;
  /**
   * Stop waiting after this many ms and report `still-open` (the Claude
   * Code path's `DIALOG_HOST_LIMIT_MS`); unset waits with no limit (pi).
   */
  stopAfterMs?: number;
  /** The process environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The node binary the inner command runs under; defaults to `process.execPath`. */
  nodePath?: string;
  /** The cli entry point; defaults to the package's own `cli.ts`. */
  cliPath?: string;
}

/** Injected dependencies; every default is the real thing. */
export interface RunDialogDeps {
  /** The popup call; defaults to `openPopup` in `tmux.ts`. */
  openPopup?: (args: string[]) => PopupHandle;
  /** The poll timer; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** The deadline clock; defaults to `Date.now`. */
  now?: () => number;
  /** The inner pid's liveness check; defaults to `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
  /** The private temp-dir factory; defaults to a `mkdtemp` under `os.tmpdir()`. */
  makeDir?: () => string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The `display-popup` argv design D1 pins: `-E` over the caller's pane with
 * the state path, the agent dir, the caller's `PATH`, and each of `VISUAL`,
 * `EDITOR` and `PAGER` the caller's env sets — the popup gets the tmux
 * server's env, so nothing else is inherited. The inner command runs under
 * the caller's own node binary.
 */
function popupArgs(args: RunDialogArgs, env: NodeJS.ProcessEnv, statePath: string): string[] {
  const argv = [
    "display-popup",
    "-E",
    "-t",
    env.TMUX_PANE ?? "",
    "-T",
    args.title,
    "-w",
    "80%",
    "-h",
    "80%",
    "-d",
    args.cwd,
    "-e",
    `${DIALOG_STATE_ENV}=${statePath}`,
    "-e",
    `PI_CODING_AGENT_DIR=${args.agentDir}`,
  ];
  if (env.PATH) argv.push("-e", `PATH=${env.PATH}`);
  for (const name of ["VISUAL", "EDITOR", "PAGER"] as const) {
    if (env[name]) argv.push("-e", `${name}=${env[name]}`);
  }
  argv.push(args.nodePath ?? process.execPath, args.cliPath ?? join(SUBAGENTS_DIR, "cli.ts"));
  argv.push(...args.innerArgs);
  return argv;
}

/**
 * Run a dialog: open the popup over the caller's pane and wait on its state
 * file. Resolves with the outcome — a `done` result, a `cancel`, or
 * `still-open` after `stopAfterMs` — and throws when no popup can open
 * (outside tmux, a `display-popup` error, or ten seconds without `open`).
 * The state dir is removed once the wait ends for good; on `still-open` it
 * stays for the inner side that may still be writing.
 */
export async function runDialog(
  args: RunDialogArgs,
  deps: RunDialogDeps = {},
): Promise<DialogOutcome> {
  const env = args.env ?? process.env;
  if (!env.TMUX || !env.TMUX_PANE) {
    throw new Error(`pmux dialogs need tmux. ${tmuxSetupHint()}`);
  }
  const openPopupCall = deps.openPopup ?? openPopup;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const makeDir = deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), "pmux-dialog-")));

  const dir = makeDir();
  const statePath = join(dir, "state.json");

  let handle: PopupHandle;
  try {
    handle = openPopupCall(popupArgs(args, env, statePath));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // A popup error is only reported while the dialog never opened; after
  // `open` the inner pid's liveness governs. The catch keeps the rejection
  // handled whether or not the wait still runs.
  let popupError: Error | null = null;
  handle.done.catch((error) => {
    popupError = toError(error);
  });

  const start = now();
  const openDeadline = start + DIALOG_OPEN_TIMEOUT_MS;
  let openPid: number | null = null;
  // On still-open the inner side may still write: keep its state file.
  let keepDir = false;
  try {
    for (;;) {
      const record = readDialogState(statePath);
      if (record?.state === "done") {
        const { state: _state, ...result } = record;
        return { kind: "done", result };
      }
      if (record?.state === "cancel") return { kind: "cancel" };
      if (record?.state === "open") openPid = record.pid;
      if (openPid === null) {
        if (popupError !== null) throw popupError;
        if (now() >= openDeadline) {
          throw new Error(
            `the dialog did not open within ${DIALOG_OPEN_TIMEOUT_MS / 1000} seconds`,
          );
        }
      } else if (!pidAlive(openPid)) {
        // A dead inner pid with no final state is a cancel; read once more
        // in case the final write raced this check.
        const last = readDialogState(statePath);
        if (last?.state === "done") {
          const { state: _state, ...result } = last;
          return { kind: "done", result };
        }
        return { kind: "cancel" };
      }
      if (args.stopAfterMs !== undefined && now() - start >= args.stopAfterMs) {
        keepDir = true;
        handle.unref();
        return { kind: "still-open", line: DIALOG_STILL_OPEN_LINE };
      }
      await sleep(DIALOG_POLL_MS);
    }
  } finally {
    if (!keepDir) rmSync(dir, { recursive: true, force: true });
  }
}
