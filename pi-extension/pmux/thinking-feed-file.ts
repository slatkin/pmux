/**
 * The thinking feed's file: where the feed of one session lives, and how a
 * record is written to it.
 *
 * The feed is a JSONL file in a per-user runtime directory, one file per
 * session id (design D2). One line is one record: one phase of a thinking
 * block. The directory rule is the one `channelEndpointPath` shares, from
 * `runtime-dir.ts` — `$XDG_RUNTIME_DIR/<name>`, or `/tmp/<name>-<uid>` when
 * `XDG_RUNTIME_DIR` is unset or empty — under the name `pmux-thinking`, so
 * pmux and pmux-explorer derive the same path with no registry.
 *
 * Thinking text is the most sensitive stream, so the feed directory is
 * made private here: another component may have created it first, with
 * the default mode. A directory this uid does not own is refused before
 * anything is written in it (design D4).
 */
import fs from "node:fs";
import path from "node:path";
import { defaultUid, runtimeDirPath } from "./runtime-dir.ts";
import type { ThinkingFeedRecord } from "./thinking-feed.ts";

/** The directory name every session's feed file lives under. */
const THINKING_DIR_NAME = "pmux-thinking";

/**
 * Whether a directory that exists belongs to `uid`. A directory another
 * account owns is never written in, whatever its mode (design D4): its
 * entries are its owner's to plant and to swap. A directory that cannot be
 * read is not ours either.
 */
function ownedBy(dir: string, uid: number): boolean {
  try {
    return fs.statSync(dir).uid === uid;
  } catch {
    return false;
  }
}

/**
 * The feed file of one session: `<dir>/<session id>.jsonl`, where `<dir>`
 * is `$XDG_RUNTIME_DIR/pmux-thinking`, or `/tmp/pmux-thinking-<uid>` when
 * `XDG_RUNTIME_DIR` is unset or empty (design D2).
 *
 * `null` when the session id is empty, `.`, `..` or contains `/`, so a
 * strange id cannot write outside the directory.
 */
export function thinkingFeedPath(args: {
  /** The process environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The session's id, used verbatim as the file name. */
  sessionId: string;
  /** The uid the `/tmp` fallback directory names; defaults to this process's. */
  uid?: number;
}): string | null {
  const env = args.env ?? process.env;
  const id = args.sessionId;
  if (id === "" || id === "." || id === ".." || id.includes("/")) return null;
  const dir = runtimeDirPath({ env, name: THINKING_DIR_NAME, uid: args.uid });
  return path.join(dir, `${id}.jsonl`);
}

/**
 * Make sure the feed file exists, so a reader can attach to it before the
 * first thinking record. The file is empty then: the reader waits for the
 * first record. It is created 0600 in a directory made 0700, and the
 * modes are applied again when the directory or file already exists with
 * another mode.
 *
 * A directory owned by another uid is refused silently: its entries
 * belong to its owner, who could plant a file or a symlink for the
 * session's feed, and who chooses the directory's mode, so the mode steps
 * prove nothing (design D4). Only the owner or root can change a
 * directory's owner, so the owner check closes that hole.
 *
 * `uid` is the uid the directory must belong to; it defaults to this
 * process's, the same uid the `/tmp` fallback names (design D2).
 */
export function ensureThinkingFeed(args: { filePath: string; uid?: number }): void {
  try {
    const filePath = args.filePath;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The directory may have been created first with the default mode, so
    // the mode is applied again, best effort.
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // A directory whose mode cannot be changed still holds the feed;
      // the session itself is never disturbed by it.
    }
    // A directory another account created first passes the steps above
    // (its `chmod` fails and is swallowed), and nothing may be written in
    // it. The check comes after both steps, so the directory exists to be
    // read.
    if (!ownedBy(dir, args.uid ?? defaultUid())) return;
    // Open for append: creates the file when it does not exist, leaves it
    // alone when it does.
    fs.closeSync(fs.openSync(filePath, "a", 0o600));
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // The file's mode is already 0600 when it was created here.
    }
  } catch {
    // A feed that cannot be created is a feed that cannot be written; the
    // producer reports nothing and the reader waits.
  }
}

/**
 * Append one record to the feed as a JSON line. The feed's directory is
 * `ensureThinkingFeed`'s job, done once at the session's start; a record
 * that cannot be written is a record the reader does not show, and the
 * session itself is never disturbed by it.
 *
 * The ownership check runs again here, and not only in the ensure: the
 * directory outlives the ensure, so a directory another account owns — or
 * one whose entry for the session was planted — receives no record even
 * when its mode lets this process write (design D4). `uid` is the uid the
 * directory must belong to; it defaults to this process's.
 */
export function appendThinkingFeedRecord(args: {
  filePath: string;
  record: ThinkingFeedRecord;
  uid?: number;
}): void {
  try {
    if (!ownedBy(path.dirname(args.filePath), args.uid ?? defaultUid())) return;
    fs.appendFileSync(args.filePath, `${JSON.stringify(args.record)}\n`);
  } catch {
    // A record that cannot be written is a record the reader does not
    // show; the session itself is never disturbed by it.
  }
}
