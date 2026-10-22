/**
 * Age-based cleanup for the temporary scratch files the launcher writes.
 *
 * `start` writes one launch spec, a launch record, a session file and an
 * activity file per child under `<tmp>/pmux`; the prompt and role prompt
 * files go under `artifacts/<parent id>/{context,pmux-resume}` (design D5),
 * and later sidecars and the `.sent` report receipts join the session file. Nothing
 * deleted them, so heavy use filled the temporary folder. This module is the
 * single place that decides what is safe to delete: only files with known
 * launcher suffixes — the stamped prompt files under the artifact tree — and
 * only when their mtime is older than the retention. Fresh files stay so
 * running children and recent resumes keep working.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REPORT_RECEIPT_SUFFIX } from "./report-receipt.ts";
import {
  LAUNCH_CONTEXT_FOLDER,
  LAUNCH_RESUME_FOLDER,
  LAUNCHER_ARTIFACT_FILE,
} from "./launch-build.ts";

/** Default retention for scratch files: a week keeps recent resumes working. */
export const DEFAULT_PRUNE_MAX_AGE_DAYS = 7;
/** Sentinels are transient completion signals, so a day is plenty. */
export const DEFAULT_SENTINEL_MAX_AGE_DAYS = 1;

export interface PruneOptions {
  /** Maximum file age in milliseconds; older managed files are deleted. */
  maxAgeMs: number;
  /** List without deleting when true. */
  dryRun?: boolean;
  /** Clock override for tests; defaults to `Date.now()`. */
  now?: number;
}

export interface PruneResult {
  scanned: number;
  deleted: string[];
  deletedBytes: number;
}

/** Suffixes the launcher owns inside the scratch directory. */
function isManagedScratchFile(name: string): boolean {
  return (
    name.endsWith(".json") ||
    name.endsWith(".jsonl") ||
    name.endsWith(".prompt.md") ||
    name.endsWith(".role.md") ||
    name.endsWith(".resume.md") ||
    name.endsWith(".exit") ||
    name.endsWith(".msg") ||
    name.endsWith(".report.md") ||
    name.endsWith(REPORT_RECEIPT_SUFFIX)
  );
}

/** Sentinel names the Claude path writes directly under the tmp root. */
export function isSentinelFile(name: string): boolean {
  return /^pi-claude-.*-done(\.transcript)?$/.test(name);
}

function pruneDir(
  dir: string,
  matches: (name: string) => boolean,
  options: PruneOptions,
): PruneResult {
  const result: PruneResult = { scanned: 0, deleted: [], deletedBytes: 0 };
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const path = join(dir, name);
    let mtime: number;
    let size: number;
    let isFile: boolean;
    try {
      const stat = statSync(path);
      isFile = stat.isFile();
      mtime = stat.mtimeMs;
      size = stat.size;
    } catch {
      continue;
    }
    if (!isFile) continue;
    result.scanned += 1;
    if (mtime > now - options.maxAgeMs) continue;
    if (!options.dryRun) {
      try {
        rmSync(path, { force: true });
      } catch {
        continue;
      }
    }
    result.deleted.push(path);
    result.deletedBytes += size;
  }
  result.deleted.sort((a, b) => a.localeCompare(b));
  return result;
}

/**
 * The artifact folders the launcher writes its prompt files into (design
 * D4), imported from the launcher itself (`launch-build.ts`), so the cleanup
 * and the writer cannot name the folders differently. Files elsewhere under
 * an artifacts id are not launcher-written, so they are left alone.
 */
const LAUNCHER_ARTIFACT_FOLDERS = new Set([LAUNCH_CONTEXT_FOLDER, LAUNCH_RESUME_FOLDER]);

/** The launcher-owned files under `artifacts/<id>/{context,pmux-resume}`. */
function isManagedArtifactFile(name: string): boolean {
  return LAUNCHER_ARTIFACT_FILE.test(name);
}

/** Delete old launcher files inside a scratch directory: the top level's
 * managed suffixes (legacy files age out), plus the stamped prompt files of
 * the artifact prompt folders. Anything else inside the tree — a foreign
 * suffix, another folder name, another root — is never touched. */
export function pruneScratch(dir: string, options: PruneOptions): PruneResult {
  const parts: PruneResult[] = [pruneDir(dir, isManagedScratchFile, options)];
  try {
    for (const id of readdirSync(join(dir, "artifacts"))) {
      for (const folder of LAUNCHER_ARTIFACT_FOLDERS) {
        parts.push(pruneDir(join(dir, "artifacts", id, folder), isManagedArtifactFile, options));
      }
    }
  } catch {
    // No artifacts tree (or an unreadable one): the top level still prunes.
  }
  return {
    scanned: parts.reduce((n, part) => n + part.scanned, 0),
    deleted: parts.flatMap((part) => part.deleted).sort((a, b) => a.localeCompare(b)),
    deletedBytes: parts.reduce((n, part) => n + part.deletedBytes, 0),
  };
}

/** Delete orphaned Claude sentinel files directly under the tmp root. */
export function pruneSentinels(dir: string, options: PruneOptions): PruneResult {
  return pruneDir(dir, isSentinelFile, options);
}

/** Default scratch directory: `<tmp>/pmux`. */
export function defaultScratchDir(): string {
  return join(tmpdir(), "pmux");
}

/**
 * Best-effort cleanup after a start. It never throws: a full or read-only
 * tmp folder must not fail the launch it was meant to protect.
 */
export function autoPrune(scratchDir: string, maxAgeDays = DEFAULT_PRUNE_MAX_AGE_DAYS): void {
  try {
    pruneScratch(scratchDir, { maxAgeMs: maxAgeDays * 86_400_000 });
  } catch {
    // Best effort; the launch continues.
  }
}
