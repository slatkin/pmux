/**
 * The `.exit` sidecar protocol — host independent.
 *
 * A child writes `<session file>.exit` when it finishes (done, ping, handoff
 * or error). A child whose turn the user aborted writes a `cancelled` sidecar
 * and exits; no parent is woken for it (quiet-cancel-exit D1, D2). The parent
 * polls that file, so the
 * completion channel does not depend on the terminal host. Both backends read
 * it through this module so they decode a payload the same way.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";

export interface PollResult {
  /** How the subagent exited, or that the user cancelled its turn */
  reason: "done" | "ping" | "sentinel" | "error" | "handoff" | "cancelled";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Handoff data if reason is "handoff" (context-alert handoff, D5) */
  handoff?: { message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
  /** Who wrote the error sidecar: the child's own error path, or the wrapper. */
  errorSource?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by pmux_done / caller_ping /
 * the error path in pmux-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "handoff") {
    const message =
      typeof data.message === "string" && data.message.trim() !== ""
        ? data.message
        : "(handoff text missing)";
    return { reason: "handoff", exitCode: 0, handoff: { message } };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return {
      reason: "error",
      exitCode: 1,
      errorMessage,
      ...(typeof data.source === "string" ? { errorSource: data.source } : {}),
    };
  }
  if (data?.type === "cancelled") {
    // Nothing failed, so the exit code stays 0; the reason carries the meaning
    // (report-user-cancel D3).
    return { reason: "cancelled", exitCode: 0 };
  }
  return { reason: "done", exitCode: 0 };
}

/** The `.exit` sidecar path next to a session file. */
export function exitSidecarPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

/**
 * Read the `.exit` sidecar next to a session file. Returns the parsed JSON, or
 * null when the file is missing or is not valid JSON. Never deletes the file —
 * callers that consume a sidecar remove it themselves.
 */
export function readExitSidecar(sessionFile: string): any {
  try {
    return JSON.parse(readFileSync(exitSidecarPath(sessionFile), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the `.exit` sidecar next to a session file. Never throws: a failed
 * write only costs the parent its exit signal, and the idle watchdog still
 * ends the run.
 */
export function writeExitSidecar(sessionFile: string, data: unknown): boolean {
  try {
    writeFileSync(exitSidecarPath(sessionFile), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the `.exit` sidecar next to a session file, so a later run never
 * reads an earlier run's exit. A missing file is fine. Never throws.
 */
export function removeExitSidecar(sessionFile: string): void {
  try {
    rmSync(exitSidecarPath(sessionFile), { force: true });
  } catch {
    // Best effort: a stale sidecar only costs one poll cycle.
  }
}

/** The interrupt marker next to a session file (quiet-cancel-exit D3). */
export function interruptMarkerPath(sessionFile: string): string {
  return `${sessionFile}.interrupt`;
}

/**
 * Mark the next abort as the parent's `pmux_interrupt`, so the child stays
 * open instead of ending as cancelled. Never throws: without the marker the
 * interrupt ends the child as a user cancel would.
 */
export function writeInterruptMarker(sessionFile: string): boolean {
  try {
    writeFileSync(interruptMarkerPath(sessionFile), "");
    return true;
  } catch {
    return false;
  }
}

/** Remove the interrupt marker and say whether it was there. Never throws. */
export function takeInterruptMarker(sessionFile: string): boolean {
  try {
    rmSync(interruptMarkerPath(sessionFile));
    return true;
  } catch {
    return false;
  }
}
