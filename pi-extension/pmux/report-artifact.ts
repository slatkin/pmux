/**
 * The `<session>.<id>.report.md` report artifacts — host independent, like
 * `exit-sidecar.ts` and `status-file.ts`.
 *
 * Under the `file-ack-v1` report protocol the report body goes to a durable
 * file before any pane input: `send` writes the text it received to
 * `<session>.<id>.report.md`, and only the pointer — the report's ID, its
 * path, the `ack` command and a visibility token — is typed into the
 * parent's pane. The file outlives every transport failure: a pointer that
 * never lands still leaves the report on disk, and the run wrapper
 * re-delivers the same file under the same ID.
 */
import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";

/** The suffix a report artifact — and its abandoned temporary — carries. */
export const REPORT_ARTIFACT_SUFFIX = ".report.md";

/** The shape of a report ID: 16 random bytes as 32 lowercase hex characters. */
export const REPORT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The prefix the pointer's visibility marker carries. */
export const VISIBILITY_TOKEN_PREFIX = "pmux-eom-";

/** True when the value is a well-formed report ID. */
export function isReportId(value: unknown): value is string {
  return typeof value === "string" && REPORT_ID_PATTERN.test(value);
}

/** Mint a fresh report ID. */
export function newReportId(): string {
  return randomBytes(16).toString("hex");
}

/** Mint a fresh visibility token: the same 32-hex shape as a report ID. */
export function newVisibilityToken(): string {
  return randomBytes(16).toString("hex");
}

/** The artifact path a report ID gets next to its session file. */
export function reportArtifactPath(sessionFile: string, id: string): string {
  return `${sessionFile}.${id}${REPORT_ARTIFACT_SUFFIX}`;
}

export interface ReportArtifact {
  /** The minted report ID. */
  id: string;
  /** The path the report body was written to. */
  reportPath: string;
}

/**
 * Write a report body to a fresh artifact. The write goes to
 * `<session>.<id>.tmp-<random>.report.md` with the `wx` flag and is then
 * renamed over the artifact name, so a reader either sees the whole report
 * or nothing. The temporary name keeps the `.report.md` suffix so prune
 * reclaims a write abandoned between the create and the rename. The file
 * holds the body exactly as received — no pane-input encoding — and is
 * immutable afterwards: each write mints a fresh ID, so concurrent and
 * repeated reports never share a file.
 *
 * Throws on failure: a report that cannot be written must refuse the send
 * before the pane is touched.
 */
export function writeReportArtifact(sessionFile: string, body: string): ReportArtifact {
  const id = newReportId();
  const reportPath = reportArtifactPath(sessionFile, id);
  const tmp = `${sessionFile}.${id}.tmp-${process.pid}-${randomBytes(6).toString("hex")}${REPORT_ARTIFACT_SUFFIX}`;
  writeFileSync(tmp, body, { flag: "wx" });
  // A failed rename leaves the temporary behind; its `.report.md` suffix
  // routes it to prune, which reclaims it past the retention.
  renameSync(tmp, reportPath);
  return { id, reportPath };
}

/** Quote one path for the shell command embedded in a pointer. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ReportPointer {
  /** The one-line pointer text typed into the parent's pane. */
  text: string;
  /**
   * The fresh 32-hex visibility token the text ends with
   * (`[pmux-eom-<token>]`). The notification record stores it, and the
   * verified submission polls the screen for it.
   */
  token: string;
}

/**
 * Build the pointer that stands in for a report in the parent's pane. It is
 * one line holding no report body: the report ID, the shell-quoted path to
 * read, the shell-quoted `ack` command to run after reading, and a fresh
 * visibility token that proves this attempt reached the screen. The report
 * ID stays stable across retries while every call mints a new token, so a
 * re-delivery can prove the new pointer appeared even when an earlier one is
 * still on screen.
 */
export function buildReportPointer(args: {
  /** The report ID. */
  id: string;
  /** The artifact path the pointer names. */
  reportPath: string;
  /** The session file the `ack` command names. */
  sessionFile: string;
  /** The path of the package's `cli.ts`. */
  cliPath: string;
}): ReportPointer {
  const token = newVisibilityToken();
  const text =
    `pmux report ${args.id}. Read ${shellQuote(args.reportPath)}, then run: ` +
    `node ${shellQuote(args.cliPath)} ack --session ${shellQuote(args.sessionFile)} ` +
    `--id ${args.id}. Acknowledge only after reading. ` +
    `[${VISIBILITY_TOKEN_PREFIX}${token}]`;
  return { text, token };
}
