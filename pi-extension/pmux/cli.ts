/**
 * Command-line interface for launching subagents in tmux panes. The packaged
 * skill shim (`skills/pmux/launch.ts`) hands off to `main` here, and
 * the pi extension's launch sites use the same `run` wrapper.
 *
 * `start` and `resume` run in the orchestrator's session; `run` runs in the
 * child's pane and stays alive until the child exits. Everything is argv
 * arrays and typed modules — no shell anywhere.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  autoPrune,
  defaultScratchDir,
  pruneScratch,
  pruneSentinels,
  DEFAULT_PRUNE_MAX_AGE_DAYS,
} from "./prune.ts";
import {
  isReportMode,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  writeLaunchSpec,
  type ReportMode,
} from "./launch.ts";
import { agentPrompt, callerPaneId, createSurface, readPaneOption, runInPane } from "./tmux.ts";
import {
  exitSidecarPath,
  interpretExitSidecar,
  readExitSidecar,
  removeExitSidecar,
} from "./exit-sidecar.ts";
import { resolvePlacement } from "./placement.ts";
import { encodePaneText } from "./pane-input.ts";
import {
  deliverReport,
  registerReport,
  reportAcknowledged,
  type RegisteredReportFile,
} from "./report-delivery.ts";
import {
  appendReportAck,
  appendReportReceipt,
  readReportLog,
  reportReceiptPath,
} from "./report-receipt.ts";
import {
  followInbox,
  inboxDirPath,
  liveMonitorPid,
  printPendingEntries,
  pruneInboxes,
  removeInboxEntry,
  removeMonitorMarker,
  writeMonitorMarker,
} from "./report-inbox.ts";
import { submitChannel } from "./channel-endpoint.ts";
import { type ChannelUnavailableReason } from "./channel-reason.ts";
import { type InboxUnavailableReason } from "./inbox-reason.ts";
import { isReportId, reportArtifactPath } from "./report-artifact.ts";
import { runSpec, type RunSpecDeps } from "./run.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import { loadSurfaceConfig } from "./status.ts";
import {
  CHILD_STATUSES,
  isChildStatus,
  parseChildStatus,
  rawChildStatusName,
  removeChildStatus,
  statusFilePath,
  TERMINAL_CHILD_STATUSES,
  type ChildStatus,
} from "./status-file.ts";
import { slugifyName } from "./slug.ts";
import {
  SUBAGENTS_CLI_PATH,
  REPORT_PROTOCOL,
  artifactDirFor,
  buildPiLaunch,
  isFile,
  resolveLaunchRecord,
} from "./launch-build.ts";
import { getLaunchRecordFile, readLaunchRecord, writeLaunchRecord } from "./launch-record.ts";

/** Pane-side entry point; the pane runs this file with `node`. */
const CLI_PATH = SUBAGENTS_CLI_PATH;

/** Close-on-done grace used when `--close-grace-ms` is omitted. */
const DEFAULT_CLOSE_GRACE_MS = 1500;

/** Defaults for `wait`. */
const DEFAULT_WAIT_STATUS = TERMINAL_CHILD_STATUSES.join(",");
const DEFAULT_WAIT_TIMEOUT_S = 600;
/** Fixed poll interval for the status file. */
const WAIT_POLL_MS = 500;

/** Node version that runs `.ts` without a flag, required by the pane side. */
const MIN_NODE: readonly [number, number] = [22, 18];

const USAGE = [
  "Usage:",
  "  node cli.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <me> [--scratch <dir>] [--close-grace-ms <n>] [--report last|send] [--fallback]",
  "  node cli.ts send --to <pane> --text <text> [--ack-timeout <seconds>]",
  "  node cli.ts ack --session <file> --id <id>",
  "  node cli.ts inbox (--follow | --once) [--parent <pane>]",
  "  node cli.ts resume --launch <spec> --prompt <file> [--name <child>]",
  "  node cli.ts run <spec> [<prompt>]",
  "  node cli.ts last-message --session <file>",
  "  node cli.ts wait --session <file> [--signal status|sidecar] [--status <list>] [--timeout <seconds>] (--status with --signal sidecar is a usage error)",
  "  node cli.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]",
].join("\n");

const CLI_OPTIONS = {
  name: { type: "string" },
  role: { type: "string" },
  cwd: { type: "string" },
  brief: { type: "string" },
  parent: { type: "string" },
  scratch: { type: "string" },
  "close-grace-ms": { type: "string" },
  report: { type: "string" },
  fallback: { type: "boolean" },
  to: { type: "string" },
  text: { type: "string" },
  id: { type: "string" },
  "ack-timeout": { type: "string" },
  launch: { type: "string" },
  prompt: { type: "string" },
  session: { type: "string" },
  signal: { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  "max-age-days": { type: "string" },
  "dry-run": { type: "boolean" },
  follow: { type: "boolean" },
  once: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface CliValues {
  name?: string;
  role?: string;
  cwd?: string;
  brief?: string;
  parent?: string;
  scratch?: string;
  "close-grace-ms"?: string;
  report?: string;
  fallback?: boolean;
  to?: string;
  text?: string;
  id?: string;
  "ack-timeout"?: string;
  launch?: string;
  prompt?: string;
  session?: string;
  signal?: string;
  status?: string;
  timeout?: string;
  "max-age-days"?: string;
  "dry-run"?: boolean;
  follow?: boolean;
  once?: boolean;
  help?: boolean;
}

/** Injected process pieces; the defaults are the real process. */
export interface CliDeps {
  /** Process environment for the commands; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** JSON, sentinel and usage sink; defaults to `process.stdout.write`. */
  stdout?: (text: string) => void;
  /** Warning sink; defaults to `process.stderr.write`. */
  stderr?: (text: string) => void;
  /** Close grace timer; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Config path holding the `surface` default; defaults to the extension config. */
  configPath?: string;
  /**
   * The channel endpoint client; defaults to the real `submitChannel`. The
   * report delivery offers the parent's channel first (design D3).
   */
  submitChannel?: typeof submitChannel;
}

function required(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`missing ${flag}`);
  return value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Require a tmux pane: the launch must know which pane to split from.
 */
function assertHostEnv(env: NodeJS.ProcessEnv): void {
  if (!(env.TMUX && env.TMUX_PANE)) {
    throw new Error("must run inside a tmux pane (TMUX and TMUX_PANE must be set)");
  }
}

/** Refuse a node too old to run the `.ts` pane-side entry without a flag. */
function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return;
  throw new Error(`node >= ${MIN_NODE.join(".")} is required (running ${process.versions.node})`);
}

/**
 * Scratch file stem from a child name. The name is free text, but it becomes
 * part of the launch-spec path, which must pass the pane token rule, so only
 * characters that survive every supported shell are kept.
 */
function scratchBase(name: string, id: string): string {
  const slug = slugifyName(name, {
    lowercase: false,
    keepUnderscore: true,
    collapse: false,
  });
  return `${slug}-${id}`;
}

/** Parse `--close-grace-ms`, defaulting to `DEFAULT_CLOSE_GRACE_MS`. */
function closeGraceMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CLOSE_GRACE_MS;
  const grace = Number(value);
  if (!Number.isFinite(grace) || grace < 0) {
    throw new Error(`--close-grace-ms must be a non-negative number: ${value}`);
  }
  return grace;
}

/**
 * The `--report` flag of `start`. A missing flag means the default `last`
 * mode; an unknown value is a usage error (the caller exits 2 and the
 * message goes to stderr).
 */
function reportMode(
  value: string | undefined,
  writeErr: (text: string) => void,
): ReportMode | null {
  if (value === undefined) return "last";
  if (isReportMode(value)) return value;
  writeErr(`invalid --report value: ${value} (expected last or send)\n`);
  return null;
}

/** `start`: resolve a role, write the launch spec and run it in a new pane. */
function startCommand(values: CliValues, deps: CliDeps, report: ReportMode): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));

  const name = required("--name", values.name);
  const role = required("--role", values.role);
  const cwd = required("--cwd", values.cwd);
  const brief = required("--brief", values.brief);
  const parent = required("--parent", values.parent);

  if (!isDirectory(cwd)) throw new Error(`cwd is not a directory: ${cwd}`);
  if (!isFile(brief)) throw new Error(`brief is not a file: ${brief}`);
  assertNodeVersion();
  assertHostEnv(env);

  // The role resolves once, into the record a resume reads (design D6): the
  // unknown-role and empty-model errors keep today's text and still happen
  // before any file is written. The anchor is the target directory — the
  // external path's own anchor (AGENTS.md: `.pi/agents/` in the child's cwd
  // first) — so a role placed there resolves. The per-call cwd is resolved
  // once here, against the launcher's own cwd, so a relative --cwd joins
  // once and the search stays where it belongs.
  const targetCwd = resolve(cwd);
  // The flag is a launch override like the report mode: the record holds the
  // model launch time chose, so a resume needs no flag of its own.
  const { record, definition } = resolveLaunchRecord({
    role,
    anchor: targetCwd,
    overrides: { name, cwd: targetCwd, fallback: values.fallback === true },
    strict: true,
  });
  // The role is known only here, so the placement resolves here: the role's
  // `surface:` wins over the configured default.
  const placement = resolvePlacement(definition?.surface, loadSurfaceConfig(deps.configPath));

  const graceMs = closeGraceMs(values["close-grace-ms"]);
  const id = randomBytes(4).toString("hex");
  const base = scratchBase(name, id);
  const scratch = resolve(values.scratch ?? defaultScratchDir());
  const specPath = join(scratch, `${base}.json`);
  const sessionFile = join(scratch, `${base}.jsonl`);
  const callerPane = callerPaneId(env);

  // The token rule runs before anything is created, so an unsafe scratch path
  // fails without leaving an empty pane behind. The prompt path travels inside
  // the spec args (design D5), so the pane line never sees a `%` id.
  const paneLine = paneCommandLine(CLI_PATH, specPath);

  // The parent session id (design D5): the caller pane's sidebar id when it
  // has one, the caller pane id otherwise. A failed or empty read must not
  // stop the launch; the id goes into the record, so a resume uses the same
  // artifact directory.
  const parentSessionId = readPaneOption(callerPane, "@pane_session_id") ?? callerPane;
  const artifactDir = artifactDirFor(scratch, parentSessionId);

  mkdirSync(scratch, { recursive: true });
  autoPrune(scratch);
  if (values.scratch === undefined) {
    try {
      pruneSentinels(sentinelDir(env), { maxAgeMs: 86_400_000 });
    } catch {
      // Best effort; the launch continues.
    }
  }
  const briefText = readFileSync(brief, "utf8");

  // The launch record sits beside the session file (design D6), with the
  // external-only values a later resume needs (designs D5 and D7).
  writeLaunchRecord(getLaunchRecordFile(sessionFile), {
    ...record,
    parentSessionId,
    closeGraceMs: graceMs,
  });

  // The shared builder (designs D3 and D4): it writes the brief-plus-footer
  // prompt and the role body under `artifacts/<id>/context/` and builds the
  // spec with the prompt path, the external-parent marker and the close grace.
  const spec = buildPiLaunch({
    record,
    task: briefText,
    localAgentDir: null,
    artifactDir,
    parentContact: {
      kind: "external",
      parent,
      callerPane,
      report,
      closeGraceMs: graceMs,
    },
    run: { id, sessionFile, activityFile: join(scratch, `${base}.activity.json`) },
  });
  writeLaunchSpec(specPath, spec);

  // A new run must not read the status of an earlier run, nor its exit.
  removeChildStatus(sessionFile);
  removeExitSidecar(sessionFile);

  const pane = createSurface(name, placement, callerPane);
  runInPane(pane, paneLine);

  write(JSON.stringify({ pane, session: sessionFile, launch: specPath }) + "\n");
  return 0;
}

/** `resume`: rebuild the launch spec from its record and run it in a new pane. */
function resumeCommand(values: CliValues, deps: CliDeps): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const launchPath = required("--launch", values.launch);
    const promptPath = required("--prompt", values.prompt);
    if (!isFile(launchPath)) throw new Error(`launch spec is not a file: ${launchPath}`);
    if (!isFile(promptPath)) throw new Error(`prompt is not a file: ${promptPath}`);
    assertHostEnv(env);

    // The record holds the role values `start` resolved (design D6). A spec
    // whose session file has no valid record came from an older version, and
    // only `start` can write the record, so the resume refuses.
    const spec = readLaunchSpec(launchPath);
    const record = readLaunchRecord(getLaunchRecordFile(spec.sessionFile));
    if (record === null) {
      throw new Error(
        `no launch record at ${getLaunchRecordFile(spec.sessionFile)}: this launch spec cannot be resumed; run start again`,
      );
    }
    // The external footer names the parent, so the rebuilt spec needs one: a
    // spec without a parent belongs to a pi parent, whose children resume
    // through `pmux_resume`.
    if (spec.parent === undefined) {
      throw new Error(
        "the launch spec holds no parent: a child of a pi parent is resumed with pmux_resume",
      );
    }

    // The artifact id is the one `start` used (designs D5 and D7). A record
    // without the field (a non-external launch) falls back to the caller pane.
    const scratch = dirname(launchPath);
    const callerPane = callerPaneId(env);
    const parentSessionId = record.parentSessionId ?? callerPane;
    const artifactDir = artifactDirFor(scratch, parentSessionId);

    // Per-run values are created again for every run, as the pi parent's
    // resume does: a fresh child id and its own activity file.
    const id = randomBytes(4).toString("hex");
    const activityFile = join(scratch, `${scratchBase(record.name, id)}.activity.json`);

    // The placement resolves from the record's role surface, else the
    // configured default.
    const placement = resolvePlacement(record.surface, loadSurfaceConfig(deps.configPath));

    // The rebuilt spec (design D7): the same role values, the spec's parent,
    // report mode and close grace, and the prompt text as the resume message.
    // The builder writes the prompt file under `artifacts/<id>/pmux-resume/`
    // and appends the report-mode footer, so the child receives the message
    // and its report instructions as one artifact.
    const message = readFileSync(promptPath, "utf8");
    const rebuilt = buildPiLaunch({
      record,
      task: message,
      localAgentDir: null,
      artifactDir,
      parentContact: {
        kind: "external",
        parent: spec.parent,
        callerPane,
        report: spec.report,
        closeGraceMs: record.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
      },
      resume: { message },
      run: { id, sessionFile: spec.sessionFile, activityFile },
    });
    writeLaunchSpec(launchPath, rebuilt);

    // The launch spec carries the session file; the status of the earlier run
    // must not survive into this one, nor its exit.
    removeChildStatus(spec.sessionFile);
    removeExitSidecar(spec.sessionFile);

    // `--name` renames the pane and, for a tab, its window; the rebuilt spec
    // keeps the record's name.
    const pane = createSurface(values.name ?? rebuilt.name, placement, callerPane);
    runInPane(pane, paneCommandLine(CLI_PATH, launchPath));

    write(JSON.stringify({ pane, launch: launchPath }) + "\n");
    return 0;
  } catch (error) {
    return usageFailure(error, writeErr);
  }
}

/**
 * `run`: the pane-side wrapper. Resolve `pi` in this pane (so the pane's PATH
 * applies) and hand the spec to `runSpec`, which returns the exit code.
 */
async function runCommand(positionals: string[], deps: CliDeps): Promise<number> {
  const specPath = positionals[0];
  if (!specPath) throw new Error("missing <spec>");
  const promptPath = positionals[1];

  const spec = readLaunchSpec(specPath);
  const resolved =
    spec.command === "pi" ? resolvePiCommand({ env: deps.env ?? process.env }) : [spec.command];
  const command = resolved[0];
  const runDeps: RunSpecDeps = {
    env: deps.env,
    stdout: deps.stdout,
    stderr: deps.stderr,
    sleep: deps.sleep,
    // The send-mode wake-up names this CLI for reading the child's session.
    cliPath: CLI_PATH,
  };
  return runSpec(
    { ...spec, command, args: [...resolved.slice(1), ...spec.args] },
    promptPath,
    runDeps,
  );
}

/** Sentinel root, overridable for tests so they never touch the real tmp folder. */
function sentinelDir(env: NodeJS.ProcessEnv): string {
  return env.PI_PMUX_SENTINEL_DIR ?? tmpdir();
}

/** Parse `--max-age-days`, defaulting to `DEFAULT_PRUNE_MAX_AGE_DAYS`. */
function pruneMaxAgeDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PRUNE_MAX_AGE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--max-age-days must be a non-negative number: ${value}`);
  }
  return days;
}

/** `prune`: delete launcher files older than the retention. */
function pruneCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const scratch = resolve(values.scratch ?? defaultScratchDir());
  const maxAgeDays = pruneMaxAgeDays(values["max-age-days"]);
  const dryRun = values["dry-run"] === true;
  const maxAgeMs = maxAgeDays * 86_400_000;
  const files = pruneScratch(scratch, { maxAgeMs, dryRun });
  const sentinels = pruneSentinels(sentinelDir(deps.env ?? process.env), {
    maxAgeMs: 86_400_000,
    dryRun,
  });
  const inboxes = pruneInboxes({ env: deps.env ?? process.env, maxAgeMs, dryRun });
  write(
    JSON.stringify({
      scratch,
      maxAgeDays,
      dryRun,
      scanned: files.scanned,
      deleted: files.deleted,
      deletedBytes: files.deletedBytes,
      sentinelScanned: sentinels.scanned,
      sentinelDeleted: sentinels.deleted,
      inboxScanned: inboxes.inboxes,
      inboxEntriesDeleted: inboxes.entriesDeleted,
      inboxDirsDeleted: inboxes.dirsDeleted,
    }) + "\n",
  );
  return 0;
}

/**
 * Best-effort report receipt. Inside a child the environment carries
 * `PI_PMUX_SESSION`, so every delivered report appends one JSON line to
 * `<session>.sent`; the pane-side wrapper counts those lines to decide
 * whether it must wake the parent. The count is form-independent — it does
 * not care how the child quoted or built the send invocation. A failed
 * receipt write never fails the send; losing one only risks a spurious
 * wake-up.
 *
 * It returns the absolute path of the receipt file, or null when there is
 * no receipt: outside a child there is no session file, and a failed write
 * leaves none behind. The path is what the `send` command prints, so the
 * child can see that the delivery was recorded.
 */
function writeReportReceipt(env: NodeJS.ProcessEnv, to: string, text: string): string | null {
  const session = env.PI_PMUX_SESSION;
  if (!session) return null;
  const written = appendReportReceipt(session, {
    at: new Date().toISOString(),
    to,
    bytes: Buffer.byteLength(text, "utf8"),
  });
  return written ? resolve(reportReceiptPath(session)) : null;
}

/** Defaults for the marked `send`'s ack wait (design D6). */
const DEFAULT_ACK_TIMEOUT_S = 15;

/** An operational `ack` failure: exit 2, not the usage-error exit 1. */
class ReportAckFailure extends Error {}

/**
 * Parse `--ack-timeout` for the marked `send` (design D6). The default is
 * `DEFAULT_ACK_TIMEOUT_S`; `0` checks the log once. A negative or non-finite
 * value is a usage error, named like the other flag errors.
 */
function parseAckTimeoutSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ACK_TIMEOUT_S;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`--ack-timeout must be a non-negative number of seconds: ${value}`);
  }
  return seconds;
}

/** The fields the structured failure line of a refused send carries. */
interface SendRefusalFields {
  notification: "not-submitted" | "unknown";
  enterAttempted: boolean;
  error?: string;
  id: string;
  to: string;
  bytes: number;
  report: string;
  receipt: string;
  /** Why the channel fell back; a refusal only ever follows a fallback. */
  channelError?: ChannelUnavailableReason;
  /** Why the inbox was unavailable; a refusal always follows that check. */
  inboxError?: InboxUnavailableReason;
}

/** Print the structured failure line of a refused send; the caller exits 2. */
function writeSendRefusalLine(write: (text: string) => void, fields: SendRefusalFields): void {
  write(
    JSON.stringify({
      sent: false,
      notification: fields.notification,
      acknowledged: false,
      id: fields.id,
      to: fields.to,
      bytes: fields.bytes,
      report: resolve(fields.report),
      receipt: fields.receipt,
      notificationRecorded: false,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.channelError !== undefined ? { channelError: fields.channelError } : {}),
      ...(fields.inboxError !== undefined ? { inboxError: fields.inboxError } : {}),
      enterAttempted: fields.enterAttempted,
    }) + "\n",
  );
}

/**
 * `send` under the marked protocol (design D6): the report becomes a durable
 * artifact and a `report` registration before any pane input (design D2),
 * only the one-line pointer is submitted through the verified path, and the
 * command waits up to `--ack-timeout` for the parent's `ack`.
 *
 * Any successful submission exits 0: `acknowledged:false` means the parent
 * is busy, not a failure — the wrapper re-delivers the report at exit. A
 * refusal or an unknown Enter outcome exits 2 with the structured failure
 * line on stdout and the operational error on stderr. The artifact and its
 * registration always survive, so even a refused send remains re-deliverable.
 */
async function sendMarkedCommand(values: CliValues, deps: CliDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const to = required("--to", values.to);
    const text = required("--text", values.text);
    const ackTimeoutSeconds = parseAckTimeoutSeconds(values["ack-timeout"]);
    // The same lookup the mode gate and the legacy receipt use, so a
    // production run without injected deps still finds the child's env.
    const session = env.PI_PMUX_SESSION;
    if (!session) {
      throw new Error(
        "send under the report protocol needs PI_PMUX_SESSION: run this command inside a pmux child",
      );
    }

    // The artifact and its registration come first (design D2): a failure
    // here must refuse the send before the pane is touched.
    let registered: RegisteredReportFile;
    try {
      registered = registerReport({ sessionFile: session, to, text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeErr(
        `cli.ts: refused before any pane input: could not write or register the report: ${message}\n`,
      );
      return 2;
    }
    const receipt = resolve(reportReceiptPath(session));
    // The ack wait shares the injected timer, so a test compresses it; a
    // real run uses a real `setTimeout` (design D6: any successful
    // submission exits 0 after the wait, whatever it decided).
    const delivery = await deliverReport(
      {
        sessionFile: session,
        to,
        id: registered.id,
        reportPath: registered.reportPath,
        bytes: registered.bytes,
        cliPath: CLI_PATH,
        ackTimeoutSeconds,
        from: env.PI_PMUX_NAME ?? "unnamed",
      },
      {
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
        ...(deps.submitChannel !== undefined ? { submitChannel: deps.submitChannel } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      },
    );
    if (delivery.submitted) {
      // `acknowledged:false` is the parent being busy (design D6): the
      // wrapper re-delivers at exit, so the child must not retry.
      write(
        JSON.stringify({
          sent: true,
          notification: "submitted",
          acknowledged: delivery.acknowledged,
          id: registered.id,
          to,
          bytes: registered.bytes,
          report: resolve(registered.reportPath),
          receipt,
          notificationRecorded: delivery.notificationRecorded,
          via: delivery.via,
          ...(delivery.channelError !== undefined ? { channelError: delivery.channelError } : {}),
          ...(delivery.inboxError !== undefined ? { inboxError: delivery.inboxError } : {}),
        }) + "\n",
      );
      return 0;
    }
    writeErr(`cli.ts: could not submit the report: ${delivery.error ?? delivery.status}\n`);
    writeSendRefusalLine(write, {
      notification: delivery.status === "not-submitted" ? "not-submitted" : "unknown",
      enterAttempted: delivery.enterAttempted,
      error: delivery.error,
      ...(delivery.channelError !== undefined ? { channelError: delivery.channelError } : {}),
      ...(delivery.inboxError !== undefined ? { inboxError: delivery.inboxError } : {}),
      id: registered.id,
      to,
      bytes: registered.bytes,
      report: registered.reportPath,
      receipt,
    });
    return 2;
  } catch (error) {
    return usageFailure(error, writeErr);
  }
}

/**
 * `send`: the protocol gate (design D1). `PI_PMUX_REPORT_PROTOCOL` picks
 * the transport: a marked child runs the `file-ack-v1` flow
 * (`sendMarkedCommand`), an unmarked one (or any other marker value) keeps
 * the legacy raw-text send (`sendLegacyCommand`).
 *
 * `--ack-timeout` is rejected before the legacy leg runs — under the legacy
 * protocol the flag would be a silent no-op, so the caller must drop it or
 * mark the child.
 */
async function sendCommand(values: CliValues, deps: CliDeps): Promise<number> {
  if ((deps.env ?? process.env).PI_PMUX_REPORT_PROTOCOL === REPORT_PROTOCOL) {
    return sendMarkedCommand(values, deps);
  }
  if (values["ack-timeout"] !== undefined) {
    return usageFailure(
      new Error(
        "--ack-timeout is a report-protocol flag: it needs PI_PMUX_REPORT_PROTOCOL=file-ack-v1",
      ),
      deps.stderr ?? ((text: string) => process.stderr.write(text)),
    );
  }
  return sendLegacyCommand(values, deps);
}

/**
 * `send` under the legacy protocol (design D1's other leg): deliver one
 * report into a pane as one input (type it, then Enter). The report is
 * encoded so it reaches the parent as one input: a raw newline would end the
 * line in the parent's pane, and the rest of the report would arrive as
 * separate input. The command answers, because the caller is an agent:
 * silence reads as failure, and an agent that cannot read the result either
 * guesses or probes the parent with a second message. The line names the
 * pane it typed into, the size of the text it sent and the receipt it wrote.
 */
function sendLegacyCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const to = required("--to", values.to);
    const text = required("--text", values.text);
    agentPrompt(to, encodePaneText(text));
    const receipt = writeReportReceipt(deps.env ?? process.env, to, text);
    write(
      JSON.stringify({
        sent: true,
        to,
        bytes: Buffer.byteLength(text, "utf8"),
        receipt,
      }) + "\n",
    );
    return 0;
  } catch (error) {
    return usageFailure(error, writeErr);
  }
}

/**
 * Report one command failure on stderr and return the usage-error exit code.
 *
 * A usage error must leave stdout empty and stay out of the entry wrapper,
 * so each command catches it instead of letting it bubble up.
 */
function usageFailure(error: unknown, writeErr: (text: string) => void): number {
  const message = error instanceof Error ? error.message : String(error);
  writeErr(`cli.ts: ${message}\n`);
  return 1;
}

/**
 * Retire the acknowledged report's inbox entry (report-inbox, "Entry
 * lifecycle"). The entry lives in the inbox of the pane the report went to,
 * which the report's registration names. A missing entry or a failed removal
 * is not an error: the reader's own sweep retires what this leaves behind.
 */
function retireInboxEntry(env: NodeJS.ProcessEnv, sessionFile: string, id: string): void {
  const to = readReportLog(sessionFile).reports.find((report) => report.id === id)?.to;
  if (to === undefined) return;
  const dir = inboxDirPath({ env, targetPane: to });
  if (dir === null) return;
  try {
    removeInboxEntry(dir, id);
  } catch {
    // The reader's sweep retires it.
  }
}

/**
 * `ack`: append the read receipt for one report (design D7). The ID must be
 * well formed and its report file must exist; a repeat ack appends nothing
 * and reports `alreadyAcknowledged:true`. Unlike the notification
 * bookkeeping, a failed append is operational failure: exit 2, never a
 * claimed success.
 */
function ackCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const session = required("--session", values.session);
    const id = required("--id", values.id);
    if (!isReportId(id)) {
      throw new Error(`--id must be a report id of 32 lowercase hex characters: ${id}`);
    }
    if (!isFile(reportArtifactPath(session, id))) {
      throw new ReportAckFailure(`no report file for ${id}: ${reportArtifactPath(session, id)}`);
    }
    const alreadyAcknowledged = reportAcknowledged(session, id);
    if (!alreadyAcknowledged && !appendReportAck(session, id)) {
      throw new ReportAckFailure(
        `could not append the ack record to ${reportReceiptPath(session)}`,
      );
    }
    retireInboxEntry(deps.env ?? process.env, session, id);
    write(
      JSON.stringify({
        acked: true,
        alreadyAcknowledged,
        id,
        session: resolve(session),
        receipt: resolve(reportReceiptPath(session)),
      }) + "\n",
    );
    return 0;
  } catch (error) {
    if (error instanceof ReportAckFailure) {
      writeErr(`cli.ts: ${error.message}\n`);
      return 2;
    }
    return usageFailure(error, writeErr);
  }
}

/**
 * `inbox`: the parent's report monitor (report-inbox, "Inbox follow command").
 * `--once` prints the pending entries and exits 0 with no marker. `--follow`
 * writes the live marker, prints the backlog and every new or re-delivered
 * entry, and runs until SIGINT or SIGTERM, when it removes its marker and exits
 * 0. A second follower on a live inbox exits 1 and names the live pid.
 */
async function inboxCommand(values: CliValues, deps: CliDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    if ((values.follow === true) === (values.once === true)) {
      throw new Error("inbox needs exactly one of --follow or --once");
    }
    const parent = values.parent ?? env.TMUX_PANE;
    if (!parent) throw new Error("missing --parent: TMUX_PANE is unset, so no pane to follow");
    const dir = inboxDirPath({ env, targetPane: parent });
    if (dir === null) throw new Error("no inbox: TMUX is unset");
    const print = (line: string): void => write(`${line}\n`);
    if (values.once === true) {
      printPendingEntries(dir, new Map(), print);
      return 0;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const live = liveMonitorPid(dir);
    if (live !== null) throw new Error(`an inbox monitor is already running (pid ${live})`);
    writeMonitorMarker(dir, process.pid);
    const follower = followInbox({ dir, write: print });
    await new Promise<void>((done) => {
      const stop = (): void => {
        follower.stop();
        removeMonitorMarker(dir, process.pid);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        done();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  } catch (error) {
    return usageFailure(error, writeErr);
  }
}

/** `last-message`: print a session's last assistant message. */
function lastMessageCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const sessionPath = required("--session", values.session);
  const text = findLastAssistantMessage(getNewEntries(sessionPath, 0));
  write(`${text ?? "(no assistant message)"}\n`);
  return 0;
}

/** Parse `--status` as a comma-separated list of the accepted names. */
function waitStatuses(value: string | undefined): ChildStatus[] {
  const names = (value ?? DEFAULT_WAIT_STATUS).split(",");
  const statuses: ChildStatus[] = [];
  for (const name of names) {
    if (!isChildStatus(name)) {
      throw new Error(`unknown --status name: ${name} (expected ${CHILD_STATUSES.join(", ")})`);
    }
    statuses.push(name);
  }
  return statuses;
}

/** Parse `--signal`, defaulting to `status`. */
function waitSignal(value: string | undefined): "status" | "sidecar" {
  if (value === undefined) return "status";
  if (value === "status" || value === "sidecar") return value;
  throw new Error(`invalid --signal value: ${value} (expected status or sidecar)`);
}

/** Parse `--timeout` as a positive number of seconds. */
function waitTimeoutSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_S;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout must be a positive number of seconds: ${value}`);
  }
  return seconds;
}

/**
 * Sleep until the next poll, or until the deadline passes. Returns false when
 * the deadline passed, so the caller stops polling.
 */
async function waitForNextPoll(
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  await sleep(Math.min(WAIT_POLL_MS, remaining));
  return true;
}

/** The sinks and the timer a wait command uses. */
interface WaitDeps {
  write: (text: string) => void;
  writeErr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/** The timeout a wait command runs under. */
interface WaitTimeout {
  /** The moment the wait gives up. */
  deadline: number;
  /** The timeout in seconds, for the timeout message. */
  seconds: number;
}

/** Resolve the wait sinks from the injected deps. */
function resolveWaitDeps(deps: CliDeps): WaitDeps {
  return {
    write: deps.stdout ?? ((text: string) => process.stdout.write(text)),
    writeErr: deps.stderr ?? ((text: string) => process.stderr.write(text)),
    sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/**
 * `wait --signal sidecar`: poll `<session>.exit` until the file appears. The
 * file's presence alone is the signal, so a malformed sidecar still counts
 * and `interpretExitSidecar` maps an unknown payload to `done`. The sidecar
 * is never removed: the wrapper (`cli.ts run`) reads the same file after the
 * child exits.
 */
async function waitForSidecar(
  sessionPath: string,
  timeout: WaitTimeout,
  deps: WaitDeps,
): Promise<number> {
  const sidecarPath = exitSidecarPath(sessionPath);
  const sidecarAbsPath = resolve(sidecarPath);
  for (;;) {
    if (existsSync(sidecarPath)) {
      const result = interpretExitSidecar(readExitSidecar(sessionPath));
      deps.write(JSON.stringify({ ...result, sidecar: sidecarAbsPath }) + "\n");
      return 0;
    }
    if (!(await waitForNextPoll(timeout.deadline, deps.sleep))) break;
  }
  deps.write(`${JSON.stringify({ sidecar: null })}\n`);
  deps.writeErr(
    `timeout after ${timeout.seconds}s: no exit sidecar was seen (a sidecar, if any, would have been printed; wait never removes it)\n`,
  );
  return 2;
}

/**
 * `wait --signal status`: poll `<session>.status` until it holds one of the
 * wanted statuses. A missing file counts as no status yet.
 */
async function waitForStatus(
  sessionPath: string,
  wanted: Set<ChildStatus>,
  timeout: WaitTimeout,
  deps: WaitDeps,
): Promise<number> {
  const statusPath = statusFilePath(sessionPath);
  let last: string | null = null;
  for (;;) {
    try {
      last = readFileSync(statusPath, "utf8");
    } catch {
      // A missing file is no status yet.
    }
    if (last !== null) {
      // Parse the buffer that was read, not a second read of the file: the
      // child can flip the status between two reads, and the printed line
      // must be the one that matched.
      const record = parseChildStatus(last);
      if (record && wanted.has(record.status)) {
        deps.write(`${last}\n`);
        return 0;
      }
    }
    if (!(await waitForNextPoll(timeout.deadline, deps.sleep))) break;
  }
  deps.write(`${last ?? JSON.stringify({ status: null })}\n`);
  deps.writeErr(
    last === null
      ? `timeout after ${timeout.seconds}s: no status was seen\n`
      : `timeout after ${timeout.seconds}s: last status was ${rawChildStatusName(last)}\n`,
  );
  return 2;
}

/**
 * `wait`: poll a session's completion signal until it holds the wanted exit.
 * The two signals live in `waitForStatus` and `waitForSidecar`.
 *
 * Waiting is strictly read-only: the sidecar is never removed here. The
 * wrapper (`cli.ts run`) reads the same file after the child exits, so a
 * waiting parent that deleted it would break the close-on-done block.
 *
 * Exit 0 prints one JSON line (with the signal file's absolute path), exit 2
 * is a timeout, exit 1 is a usage error. The loop reads files only; no host
 * is involved.
 */
async function waitCommand(values: CliValues, deps: CliDeps): Promise<number> {
  const wait = resolveWaitDeps(deps);
  try {
    const sessionPath = required("--session", values.session);
    const signal = waitSignal(values.signal);
    // Judged by flag presence, not by the resolved default: `--status`
    // defaults to `done,blocked`, so a check on the value would make every
    // sidecar wait a usage error. Child statuses mean nothing to a sidecar.
    if (signal === "sidecar" && values.status !== undefined) {
      throw new Error("--status is a status-wait flag; drop it for --signal sidecar");
    }
    const timeoutSeconds = waitTimeoutSeconds(values.timeout);
    const timeout: WaitTimeout = {
      deadline: Date.now() + timeoutSeconds * 1000,
      seconds: timeoutSeconds,
    };

    if (signal === "sidecar") {
      return await waitForSidecar(sessionPath, timeout, wait);
    }
    const wanted = new Set(waitStatuses(values.status));
    return await waitForStatus(sessionPath, wanted, timeout, wait);
  } catch (error) {
    return usageFailure(error, wait.writeErr);
  }
}

/**
 * Run one CLI invocation and return the code the process should exit with.
 * Failures throw; the shim and the direct-entry wrapper turn them into a
 * message on stderr and a non-zero exit.
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const { values, positionals } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
  });
  const command = positionals[0];

  if (values.help === true || command === "help") {
    write(`${USAGE}\n`);
    return 0;
  }
  if (command === undefined) {
    writeErr(`${USAGE}\n`);
    return 2;
  }
  if (command === "resume") {
    // The mode is a launch property, so a flag here would be a silent no-op:
    // the spec still says `last` while the orchestrator believes `send`.
    if (values.report !== undefined) {
      writeErr("invalid --report for resume: the launch spec holds the mode (use start)\n");
      return 1;
    }
    // The model is a launch property too (design D6): the launch record holds
    // the model launch time resolved, flag or no flag, so a flag here would
    // be a silent no-op.
    if (values.fallback === true) {
      writeErr("invalid --fallback for resume: the launch record holds the model (use start)\n");
      return 1;
    }
    return resumeCommand(values as CliValues, deps);
  }
  if (command === "start") {
    // Exit-code convention, per the external-orchestration spec ("Requirement:
    // Start a subagent" / "Resume a subagent" / "Send a report" / "Wait for a
    // child"): `start` reports an invalid FLAG VALUE with exit 2 — `--report`
    // names a value the caller must fix before any side effect — while `wait`,
    // `resume` and `send` report a USAGE error (a missing or unusable flag)
    // with exit 1. The codes are pinned per command; they are not unified.
    const report = reportMode((values as CliValues).report, writeErr);
    return report === null ? 2 : startCommand(values as CliValues, deps, report);
  }
  if (command === "run") return runCommand(positionals.slice(1), deps);
  if (command === "send") return sendCommand(values as CliValues, deps);
  if (command === "ack") return ackCommand(values as CliValues, deps);
  if (command === "inbox") return inboxCommand(values as CliValues, deps);
  if (command === "last-message") return lastMessageCommand(values as CliValues, deps);
  if (command === "wait") return await waitCommand(values as CliValues, deps);
  if (command === "prune") return pruneCommand(values as CliValues, deps);
  throw new Error(`unknown subcommand: ${command}\n${USAGE}`);
}

/**
 * True when this module is the process entry, not an import from the shim.
 * Symlinks are resolved: an ESM loader that resolved a symlink would
 * otherwise leave the CLI silent.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(CLI_PATH);
  } catch {
    return resolve(entry) === CLI_PATH;
  }
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.exitCode = usageFailure(error, (text) => process.stderr.write(text));
    },
  );
}
