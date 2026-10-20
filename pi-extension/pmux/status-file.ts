/**
 * The `<session file>.status` file — host independent, like `exit-sidecar.ts`.
 *
 * A child that runs this extension (a session with `PI_PMUX_SESSION` set)
 * writes its live status next to its session file: one JSON object with
 * `status` (`working`, `idle`, `done`, `blocked`), `at` and an optional
 * `message`. Each write replaces the whole file (a temp file renamed over
 * the target), so a reader never sees a partial object. A terminal `done` or
 * `blocked` write latches for the rest of the child process: later writes are
 * skipped. A failed write never throws — it cannot delay a turn, the sidecar
 * write or shutdown.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export type ChildStatus = "working" | "idle" | "done" | "blocked";

/** The status names a child may write; the single source of the vocabulary. */
export const CHILD_STATUSES: readonly ChildStatus[] = ["working", "idle", "done", "blocked"];

/** The statuses that end a child's life; a later write is skipped. */
export const TERMINAL_CHILD_STATUSES: readonly ChildStatus[] = ["done", "blocked"];

/** True when the value is one of the known status names. */
export function isChildStatus(value: unknown): value is ChildStatus {
  return typeof value === "string" && (CHILD_STATUSES as readonly string[]).includes(value);
}

/** True when the status ends the child's life. */
export function isTerminalChildStatus(status: ChildStatus): boolean {
  return TERMINAL_CHILD_STATUSES.includes(status);
}

export interface ChildStatusRecord {
  status: ChildStatus;
  /** ISO time of the write. */
  at?: string;
  /** The ping question or the provider error text; absent for `working`/`idle`. */
  message?: string;
}

/** Session files that already hold a terminal status in this process. */
const terminalWrites = new Set<string>();

export function statusFilePath(sessionFile: string): string {
  return `${sessionFile}.status`;
}

/**
 * Write the status file as one whole-file replace. Returns true when the file
 * was written, false when the write failed or a terminal status already
 * latched this process. Never throws.
 */
export function writeChildStatus(
  sessionFile: string,
  status: ChildStatus,
  message?: string,
): boolean {
  if (terminalWrites.has(sessionFile)) return false;
  const record: ChildStatusRecord = {
    status,
    at: new Date().toISOString(),
    ...(message !== undefined ? { message } : {}),
  };
  try {
    // A unique temp name keeps concurrent writers from clobbering each other's
    // rename target; the rename itself is atomic, so a reader never sees a
    // partial object.
    const tmp = `${statusFilePath(sessionFile)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, statusFilePath(sessionFile));
  } catch {
    return false;
  }
  if (isTerminalChildStatus(status)) terminalWrites.add(sessionFile);
  return true;
}

/**
 * Parse one raw status-file buffer. Returns the parsed record, or null when
 * it is not a JSON object with a known status.
 */
export function parseChildStatus(raw: string): ChildStatusRecord | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (
      data === null ||
      typeof data !== "object" ||
      !isChildStatus((data as { status?: unknown }).status)
    ) {
      return null;
    }
    return data as ChildStatusRecord;
  } catch {
    return null;
  }
}

/** The status name inside one raw status-file buffer, for timeout messages. */
export function rawChildStatusName(raw: string): string {
  try {
    const status = (JSON.parse(raw) as { status?: unknown }).status;
    return typeof status === "string" ? status : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read the status file. Returns the parsed record, or null when the file is
 * missing or is not a JSON object with a known status.
 */
export function readChildStatus(sessionFile: string): ChildStatusRecord | null {
  try {
    return parseChildStatus(readFileSync(statusFilePath(sessionFile), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Remove the status file, so an earlier run's status is never read as the
 * next run's. A missing file is fine. Never throws.
 */
export function removeChildStatus(sessionFile: string): void {
  try {
    rmSync(statusFilePath(sessionFile), { force: true });
  } catch {
    // Best effort: a stale status only costs one poll cycle.
  }
}
