/**
 * Pane-side run wrapper: start a child from a launch spec with no shell,
 * report its exit, and (skill launches only) close the pane after a `done`
 * or `handoff` sidecar.
 *
 * This is the body of the CLI's `run` subcommand. `runSpec` returns the
 * child's exit code, so the CLI can exit with it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildPaneTitle, type LaunchSpec } from "./launch.ts";
import { agentSend, closeSurface } from "./tmux.ts";
import { readExitSidecar } from "./exit-sidecar.ts";
import { readChildStatus, writeChildStatus } from "./status-file.ts";

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
  /** Parent wake-up; defaults to the tmux backend. */
  sendToParent?: (parent: string, text: string) => void;
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
  // blocked with the exit code so a status wait ends. A clean completion or a
  // ping (a sidecar, or a terminal status the child wrote itself) is left as is.
  if (spec.sessionFile && !existsSync(`${spec.sessionFile}.exit`)) {
    const status = readChildStatus(spec.sessionFile);
    if (status?.status !== "done" && status?.status !== "blocked") {
      writeChildStatus(spec.sessionFile, "blocked", `child exited with code ${code}`);
    }
  }

  // The child's report is its last assistant message, which this wrapper
  // cannot see in the session file; wake the parent with the exit state so
  // it can read the session.
  if (spec.parent) {
    const sidecar = spec.sessionFile ? readExitSidecar(spec.sessionFile)?.type : undefined;
    const state = sidecar ?? (code === 0 ? "exited" : `crashed (code ${code})`);
    try {
      (deps.sendToParent ?? agentSend)(
        spec.parent,
        `${spec.name} ${state}. Its report is its last assistant message, which the wrapper cannot read. Read its last message: node <skill-dir>/launch.ts last-message --session ${spec.sessionFile ?? "<session>"}`,
      );
    } catch (error) {
      writeErr(
        `Failed to wake parent ${spec.parent}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (spec.closeOnDone && spec.sessionFile && pane) {
    // Read the sidecar directly rather than through `interpretExitSidecar`:
    // that function maps unknown payloads to `done`, which would close panes
    // on malformed sidecars. `handoff` closes like `done` — the child ended
    // cleanly and its result lives in the sidecar and its session file.
    const sidecarType = readExitSidecar(spec.sessionFile)?.type;
    if (sidecarType === "done" || sidecarType === "handoff") {
      if (spec.closeOnDone.graceMs > 0) await sleep(spec.closeOnDone.graceMs);
      closePane(pane);
    }
  }

  return code;
}
