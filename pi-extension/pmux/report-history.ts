/**
 * The per-pane report history (report-viewer spec; design D8): one directory
 * per parent pane, one durable record per `report` registration addressed to
 * that pane. The history is what the `reports` viewer lists; unlike the
 * inbox, a record stays after the parent's `ack` and is only ever removed by
 * `prune` past the launcher-file retention.
 *
 * The directory is `$XDG_RUNTIME_DIR/pmux-history/<h>-<n>`, or the `/tmp`
 * fallback — the same hash and pane key as the report inbox
 * (`report-inbox.ts`), so a pane's history sits beside its inbox under the
 * same name. A record holds the pointer's facts and never the report text.
 *
 * Every write is best-effort: a history failure must not fail or delay the
 * registration or the delivery, so `registerReport` drops any error.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fnv1a64Hex } from "./channel-endpoint.ts";
import { isReportId } from "./report-artifact.ts";
import { runtimeDirPath } from "./runtime-dir.ts";

/** The directory name every history lives under. */
export const HISTORY_DIR_NAME = "pmux-history";

/**
 * The history of a parent pane, or null when no history can exist because
 * `TMUX` is unset or empty. The path names the target pane, never the
 * caller's, and its key is the inbox's key (report-viewer, "History path").
 */
export function historyDirPath(args: {
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
  const root = runtimeDirPath({ env, name: HISTORY_DIR_NAME, uid: args.uid });
  return join(root, `${fnv1a64Hex(socketPath)}-${pane}`);
}

/** One history record: the registration's facts, never the report body. */
export interface HistoryRecord {
  v: 1;
  /** The report ID; the file is named `<id>.json`. */
  id: string;
  /** The child's launch name. */
  from: string;
  /** The absolute session file; its log carries the `ack` state. */
  session: string;
  /** The absolute report artifact path the viewer opens. */
  report: string;
  /** ISO time of the registration. */
  at: string;
}

function recordPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** Read one record file, or null when it is missing or malformed. */
function readRecord(file: string): HistoryRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { v, id, from, session, report, at } = value as Record<string, unknown>;
    if (v !== 1 || !isReportId(id)) return null;
    if (typeof from !== "string" || typeof session !== "string") return null;
    if (typeof report !== "string" || typeof at !== "string") return null;
    return { v: 1, id, from, session, report, at };
  } catch {
    return null;
  }
}

/** Write one record atomically: a temporary file, then a rename. */
export function writeHistoryRecord(dir: string, record: HistoryRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = recordPath(dir, record.id);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`);
  renameSync(temp, file);
}

/** Every readable record in a history, newest first. A missing history holds none. */
export function listHistory(dir: string): HistoryRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: HistoryRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(join(dir, name));
    if (record !== null && `${record.id}.json` === name) records.push(record);
  }
  return records.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

/** What the history sweep of `prune` did, or would do under `dryRun`. */
export interface PruneHistoryResult {
  /** History directories examined. */
  histories: number;
  /** Records older than the retention. */
  recordsDeleted: number;
  /** Histories left holding no record. */
  dirsDeleted: number;
}

/** True when a file name is a record: `<report id>.json`. */
function isRecordFile(name: string): boolean {
  return name.endsWith(".json") && isReportId(name.slice(0, -".json".length));
}

/** The file's modification time, or infinity when it cannot be read. */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The history sweep of `prune` (report-viewer, "History outlives ack").
 * Records older than `maxAgeMs` are deleted. A history directory left
 * holding no record is removed with them. `dryRun` counts without deleting.
 */
export function pruneHistory(args: {
  env: NodeJS.ProcessEnv;
  maxAgeMs: number;
  dryRun: boolean;
  /** The clock; defaults to `Date.now`. */
  now?: number;
}): PruneHistoryResult {
  const root = runtimeDirPath({ env: args.env, name: HISTORY_DIR_NAME });
  const cutoff = (args.now ?? Date.now()) - args.maxAgeMs;
  const result: PruneHistoryResult = { histories: 0, recordsDeleted: 0, dirsDeleted: 0 };
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
    result.histories += 1;
    let remaining = 0;
    for (const file of files) {
      if (!isRecordFile(file)) continue;
      const path = join(dir, file);
      if (mtimeMs(path) >= cutoff) {
        remaining += 1;
        continue;
      }
      if (args.dryRun) {
        result.recordsDeleted += 1;
        continue;
      }
      try {
        unlinkSync(path);
        result.recordsDeleted += 1;
      } catch {
        remaining += 1;
      }
    }
    if (remaining > 0) continue;
    result.dirsDeleted += 1;
    if (!args.dryRun) rmSync(dir, { recursive: true, force: true });
  }
  return result;
}
