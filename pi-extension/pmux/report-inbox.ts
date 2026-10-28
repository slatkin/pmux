/**
 * The per-parent report inbox (report-inbox spec; designs D1–D5): one
 * directory per parent pane, one durable entry per report the pane is owed,
 * a `.monitor` marker while `inbox --follow` runs, and the reader that prints
 * each entry as a pointer line.
 *
 * The directory is `$XDG_RUNTIME_DIR/pmux-inbox/<h>-<n>`, or the `/tmp`
 * fallback, where `<h>` is the FNV-1a 64 hash of the tmux socket path and
 * `<n>` the parent pane id. `channel-endpoint.ts` derives its socket the same
 * way, so the sender and the reader agree with no registry.
 *
 * An entry holds the pointer's facts and never the report text: the report
 * artifact stays the one copy (report-inbox, "Inbox entry").
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { fnv1a64Hex } from "./channel-endpoint.ts";
import { type InboxUnavailableReason } from "./inbox-reason.ts";
import { isReportId, shellQuote } from "./report-artifact.ts";
import { readReportLog } from "./report-receipt.ts";
import { runtimeDirPath } from "./runtime-dir.ts";

/** The directory name every inbox lives under. */
export const INBOX_DIR_NAME = "pmux-inbox";

/** The live-monitor marker a running follower keeps in its inbox. */
export const INBOX_MARKER = ".monitor";

/** The rescan bound: a missed filesystem notification costs at most this. */
export const INBOX_RESCAN_MS = 5000;

/**
 * The inbox of a parent pane, or null when no inbox can exist because `TMUX`
 * is unset or empty. The path names the target pane, never the caller's.
 */
export function inboxDirPath(args: {
  /** The process environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The parent pane id, with or without its `%`. */
  targetPane: string;
  /** The uid the `/tmp` fallback directory names; defaults to this process's. */
  uid?: number;
}): string | null {
  const env = args.env ?? process.env;
  const socketPath = env.TMUX?.split(",")[0];
  if (!socketPath) return null;
  const pane = args.targetPane.replace(/^%/, "");
  const root = runtimeDirPath({ env, name: INBOX_DIR_NAME, uid: args.uid });
  return join(root, `${fnv1a64Hex(socketPath)}-${pane}`);
}

/** The fields of a `.monitor` marker that the reader needs. */
function readMarker(dir: string): { pid: number } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, INBOX_MARKER), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { v, pid, at } = value as Record<string, unknown>;
    if (v !== 1 || typeof at !== "string") return null;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid };
  } catch {
    return null;
  }
}

/**
 * The pid of the live follower on an inbox, or null when there is none. A
 * marker whose process is gone, or a malformed one, reads as absent
 * (report-inbox, "Live-monitor marker"). `EPERM` means the process exists under
 * another user, so it still counts as live.
 */
export function liveMonitorPid(dir: string): number | null {
  const marker = readMarker(dir);
  if (marker === null) return null;
  try {
    process.kill(marker.pid, 0);
    return marker.pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? marker.pid : null;
  }
}

/** Write the `.monitor` marker for a follower that just started. */
export function writeMonitorMarker(dir: string, pid: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = { v: 1, pid, at: new Date().toISOString() };
  writeFileSync(join(dir, INBOX_MARKER), `${JSON.stringify(marker)}\n`);
}

/** Remove the marker when it still names `pid`; a newer follower's marker stays. */
export function removeMonitorMarker(dir: string, pid: number): void {
  if (readMarker(dir)?.pid !== pid) return;
  try {
    unlinkSync(join(dir, INBOX_MARKER));
  } catch {
    // Already gone: the marker is what we wanted removed.
  }
}

/** One inbox entry: the pointer's facts, never the report body. */
export interface InboxEntry {
  v: 1;
  /** The report ID; the file is named `<id>.json`. */
  id: string;
  /** The child's launch name. */
  from: string;
  /** The absolute session file the `ack` command names. */
  session: string;
  /** The absolute report artifact path the pointer names. */
  report: string;
  /** The absolute path of the package's `cli.ts`. */
  cli: string;
  /** ISO time of the last write. */
  at: string;
  /** 1 on the first write; each re-delivery adds 1. */
  delivery: number;
}

/** The fields a sender supplies; the writer adds `v`, `at` and `delivery`. */
export type InboxEntryFields = Pick<InboxEntry, "id" | "from" | "session" | "report" | "cli">;

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** Read one entry file, or null when it is missing or malformed. */
function readEntry(file: string): InboxEntry | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { v, id, from, session, report, cli, at, delivery } = value as Record<string, unknown>;
    if (v !== 1 || !isReportId(id) || typeof delivery !== "number") return null;
    if (typeof from !== "string" || typeof session !== "string") return null;
    if (typeof report !== "string" || typeof cli !== "string" || typeof at !== "string") {
      return null;
    }
    return { v: 1, id, from, session, report, cli, at, delivery };
  } catch {
    return null;
  }
}

/** Write one entry atomically: a temporary file, then a rename. */
export function writeInboxEntry(dir: string, entry: InboxEntry): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = entryPath(dir, entry.id);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry)}\n`);
  renameSync(temp, file);
}

/** Every readable entry in an inbox, oldest first. A missing inbox holds none. */
export function listInboxEntries(dir: string): InboxEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: InboxEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const entry = readEntry(join(dir, name));
    if (entry !== null && `${entry.id}.json` === name) entries.push(entry);
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Remove one entry. A missing entry is not an error; other failures throw. */
export function removeInboxEntry(dir: string, id: string): void {
  try {
    unlinkSync(entryPath(dir, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * The entries still owed, oldest first. An entry whose ID already has an `ack`
 * in its session's log is retired here: removed, and not returned (report-inbox,
 * "Entry lifecycle"). A failed removal leaves the entry for the next reader.
 */
export function pendingInboxEntries(dir: string): InboxEntry[] {
  const ackedBySession = new Map<string, Set<string>>();
  const pending: InboxEntry[] = [];
  for (const entry of listInboxEntries(dir)) {
    let acked = ackedBySession.get(entry.session);
    if (acked === undefined) {
      acked = readReportLog(entry.session).ackedIds;
      ackedBySession.set(entry.session, acked);
    }
    if (!acked.has(entry.id)) {
      pending.push(entry);
      continue;
    }
    try {
      removeInboxEntry(dir, entry.id);
    } catch {
      // The next reader retires it.
    }
  }
  return pending;
}

/**
 * The line a follower prints for one entry (report-inbox, "Inbox follow
 * command"): the report ID, the sender, the delivery count, and the
 * shell-quoted read and `ack` commands. One line, with no terminator.
 */
export function formatPointerLine(entry: InboxEntry): string {
  return (
    `pmux report ${entry.id} from ${entry.from} (delivery ${entry.delivery}). ` +
    `Read ${shellQuote(entry.report)}, then run: node ${shellQuote(entry.cli)} ack ` +
    `--session ${shellQuote(entry.session)} --id ${entry.id}. Acknowledge only after reading.`
  );
}

/**
 * Print every pending entry whose `delivery` differs from the one already
 * printed for its ID (report-inbox, D3). The first call prints the backlog; a
 * re-delivery prints again because its count is higher.
 */
export function printPendingEntries(
  dir: string,
  printed: Map<string, number>,
  write: (line: string) => void,
): void {
  for (const entry of pendingInboxEntries(dir)) {
    if (printed.get(entry.id) === entry.delivery) continue;
    printed.set(entry.id, entry.delivery);
    write(formatPointerLine(entry));
  }
}

/**
 * Follow an inbox until the handle is stopped (report-inbox, D3). The backlog
 * prints at once. After that a filesystem watch and a rescan print new and
 * re-delivered entries. The rescan is the correctness path; the watch only
 * shortens the wait. A missing inbox is not an error, so a directory created
 * later is picked up by the next rescan.
 */
export function followInbox(args: {
  dir: string;
  write: (line: string) => void;
  rescanMs?: number;
}): { rescan: () => void; stop: () => void } {
  const printed = new Map<string, number>();
  const rescan = (): void => printPendingEntries(args.dir, printed, args.write);
  rescan();
  const timer = setInterval(rescan, args.rescanMs ?? INBOX_RESCAN_MS);
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(args.dir, rescan);
    watcher.on("error", () => {});
  } catch {
    watcher = null;
  }
  return {
    rescan,
    stop: () => {
      clearInterval(timer);
      watcher?.close();
    },
  };
}

/** The result of offering a pointer through the inbox. */
export type InboxSubmitResult =
  { status: "delivered" } | { status: "unavailable"; reason: InboxUnavailableReason };

/**
 * Offer a pointer through the parent's inbox (report-inbox, "Inbox transport
 * availability"). The entry write is the submission. It needs an inbox path, a
 * live marker and a successful write. A re-delivery of the same ID finds the
 * entry it wrote before and counts it up.
 */
export function submitInboxEntry(args: {
  env: NodeJS.ProcessEnv;
  to: string;
  fields: InboxEntryFields;
}): InboxSubmitResult {
  const dir = inboxDirPath({ env: args.env, targetPane: args.to });
  if (dir === null) return { status: "unavailable", reason: "no-inbox" };
  if (liveMonitorPid(dir) === null) return { status: "unavailable", reason: "unmonitored" };
  try {
    const prior = readEntry(entryPath(dir, args.fields.id));
    writeInboxEntry(dir, {
      v: 1,
      ...args.fields,
      at: new Date().toISOString(),
      delivery: (prior?.delivery ?? 0) + 1,
    });
    return { status: "delivered" };
  } catch {
    return { status: "unavailable", reason: "write-failed" };
  }
}

/** What the inbox sweep of `prune` did, or would do under `dryRun`. */
export interface PruneInboxResult {
  /** Inbox directories examined. */
  inboxes: number;
  /** Entries older than the retention. */
  entriesDeleted: number;
  /** Inboxes left with no entry and no live marker. */
  dirsDeleted: number;
}

/** True when a file name is an entry: `<report id>.json`. */
function isEntryFile(name: string): boolean {
  return name.endsWith(".json") && isReportId(name.slice(0, -".json".length));
}

/**
 * The inbox sweep of `prune` (report-inbox, "Entry lifecycle"). Entries older
 * than `maxAgeMs` are deleted. An inbox left with no entry and no live marker
 * is removed with them. `dryRun` counts without deleting.
 */
export function pruneInboxes(args: {
  env: NodeJS.ProcessEnv;
  maxAgeMs: number;
  dryRun: boolean;
  /** The clock; defaults to `Date.now`. */
  now?: number;
}): PruneInboxResult {
  const root = runtimeDirPath({ env: args.env, name: INBOX_DIR_NAME });
  const cutoff = (args.now ?? Date.now()) - args.maxAgeMs;
  const result: PruneInboxResult = { inboxes: 0, entriesDeleted: 0, dirsDeleted: 0 };
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return result;
  }
  for (const name of names) {
    const dir = join(root, name);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    result.inboxes += 1;
    let remaining = 0;
    for (const file of files) {
      if (!isEntryFile(file)) continue;
      const path = join(dir, file);
      if (mtimeMs(path) >= cutoff) {
        remaining += 1;
        continue;
      }
      if (args.dryRun) {
        result.entriesDeleted += 1;
        continue;
      }
      try {
        unlinkSync(path);
        result.entriesDeleted += 1;
      } catch {
        remaining += 1;
      }
    }
    if (remaining > 0 || liveMonitorPid(dir) !== null) continue;
    result.dirsDeleted += 1;
    if (!args.dryRun) rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

/** The file's modification time, or infinity when it cannot be read. */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
