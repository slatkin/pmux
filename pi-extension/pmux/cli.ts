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
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  agentDefinitionPaths,
  buildSubagentToolAllowlist,
  loadAgentDefaults,
} from "./agent-defs.ts";
import {
  autoPrune,
  defaultScratchDir,
  pruneScratch,
  pruneSentinels,
  DEFAULT_PRUNE_MAX_AGE_DAYS,
} from "./prune.ts";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  writeLaunchSpec,
  type LaunchSpec,
} from "./launch.ts";
import { agentPrompt, createSurface, runInPane, callerPaneId } from "./tmux.ts";
import { removeExitSidecar } from "./exit-sidecar.ts";
import { resolvePlacement } from "./placement.ts";
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
import { encodeChildEnv, resolveDenyTools } from "./child-env.ts";

/** Absolute path to `pi-extension/pmux`. */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Pane-side entry point; the pane runs this file with `node`. */
const CLI_PATH = join(SUBAGENTS_DIR, "cli.ts");

/** Close-on-done grace used when `--close-grace-ms` is omitted. */
const DEFAULT_CLOSE_GRACE_MS = 5000;

/** Defaults for `wait`. */
const DEFAULT_WAIT_STATUS = TERMINAL_CHILD_STATUSES.join(",");
const DEFAULT_WAIT_TIMEOUT_S = 600;
/** Fixed poll interval for the status file. */
const WAIT_POLL_MS = 500;

/** Node version that runs `.ts` without a flag, required by the pane side. */
const MIN_NODE: readonly [number, number] = [22, 18];

const USAGE = [
  "Usage:",
  "  node cli.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <me> [--scratch <dir>] [--close-grace-ms <n>] [--report last|send]",
  "  node cli.ts send --to <pane> --text <text>",
  "  node cli.ts resume --launch <spec> --prompt <file> [--name <child>]",
  "  node cli.ts run <spec> [<prompt>]",
  "  node cli.ts last-message --session <file>",
  "  node cli.ts wait --session <file> [--status <list>] [--timeout <seconds>]",
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
  to: { type: "string" },
  text: { type: "string" },
  launch: { type: "string" },
  prompt: { type: "string" },
  session: { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  "max-age-days": { type: "string" },
  "dry-run": { type: "boolean" },
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
  to?: string;
  text?: string;
  launch?: string;
  prompt?: string;
  session?: string;
  status?: string;
  timeout?: string;
  "max-age-days"?: string;
  "dry-run"?: boolean;
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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

/**
 * The parent-contact footer appended to the brief. There is no send channel
 * back to the parent, so the report is the child's last assistant message.
 */
function parentFooter(parent: string, pane: string): string {
  return `Your parent is a session named ${parent} (pane ${pane}).
Plain text printed in your own pane is never seen. Your last assistant message is the report the parent reads.

So do ALL of the following before you stop:
1. Finish the task.
2. Write your final report as your last assistant message: the verdict, the commit SHA, the files changed, the verification, the deviations and the open questions. Put the verdict first.
3. Then call the pmux_done tool to close your session.

If you are blocked, write your question as your last assistant message and stop. The session closes; the parent resumes it with the answer. Do not use caller_ping or pmux_message to reach the parent.
If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered.`;
}

/**
 * The send-mode parent-contact footer: the report is typed into the parent's
 * pane with the `send` command. The auto-exit claim is conditional because a
 * role without `auto-exit: true` keeps running and gets the completion nudge.
 */
function sendFooter(parent: string, cliPath: string): string {
  return `Your parent is the tmux pane ${parent}.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node ${cliPath} send --to ${parent} --text '<text>'.

If this session auto-exits, it closes the first time you stop generating: the moment you end a turn without calling a tool, the session closes. Whether it does or not, do ALL of the following before you stop:
1. Finish the task.
2. Send your final report: node ${cliPath} send --to ${parent} --text '<verdict / commit SHA / files changed / verification / deviations / open questions>'
   This is what wakes the orchestrator with your report — without it, it only learns that you exited.
   The report text may be long or contain quotes — pass it however is convenient (for example read it from a file into the argument); only the target pane matters.
3. Then call the pmux_done tool to close your session.

If you are blocked, send your question with the send command and stop. The session closes; the parent resumes it with the answer. Do not try to reach the parent any other way.
If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered — send your report with the send command first, then call pmux_done.`;
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
function reportMode(values: CliValues, writeErr: (text: string) => void): "last" | "send" | null {
  const requested = values.report;
  if (requested === undefined || requested === "last") return "last";
  if (requested === "send") return "send";
  writeErr(`invalid --report value: ${requested} (expected last or send)\n`);
  return null;
}

/** `start`: resolve a role, write the launch spec and run it in a new pane. */
function startCommand(values: CliValues, deps: CliDeps, report: "last" | "send"): number {
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

  const rolePaths = agentDefinitionPaths(role, cwd);
  const definition = loadAgentDefaults(role, cwd);
  if (definition === null) {
    throw new Error(`unknown role '${role}' (searched: ${rolePaths.join(" ")})`);
  }
  if (!definition.model) {
    const rolePath = rolePaths.find(isFile) ?? rolePaths[0];
    throw new Error(`role '${role}' has an empty model (${rolePath})`);
  }
  // The role is known only here, so the placement resolves here: the role's
  // `surface:` wins over the configured default.
  const placement = resolvePlacement(definition.surface, loadSurfaceConfig(deps.configPath));

  const graceMs = closeGraceMs(values["close-grace-ms"]);
  const id = randomBytes(4).toString("hex");
  const base = scratchBase(name, id);
  const scratch = resolve(values.scratch ?? defaultScratchDir());
  const specPath = join(scratch, `${base}.json`);
  const promptPath = join(scratch, `${base}.prompt.md`);
  const rolePromptPath = join(scratch, `${base}.role.md`);
  const sessionFile = join(scratch, `${base}.jsonl`);

  // The token rule runs before anything is created, so an unsafe scratch path
  // fails without leaving an empty pane behind.
  const paneLine = paneCommandLine(CLI_PATH, specPath, promptPath);

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
  writeFileSync(rolePromptPath, definition.body ? `${definition.body}\n` : "");
  const footer =
    report === "send" ? sendFooter(parent, CLI_PATH) : parentFooter(parent, callerPaneId(env));
  writeFileSync(promptPath, `${briefText}\n${footer}\n`);
  // In send mode the report is a bash command, so the child must keep the
  // bash tool on both sides: the allowlist gains it and the denied set loses
  // it (`PI_DENY_TOOLS` wins over `--tools`).
  const denied = resolveDenyTools(definition);
  if (report === "send") denied.delete("bash");
  const specEnv = encodeChildEnv({
    name,
    agent: role,
    sessionFile,
    id,
    activityFile: join(scratch, `${base}.activity.json`),
    externalParent: true,
    autoExit: definition.autoExit === true,
    denyTools: [...denied],
  });

  const spec: LaunchSpec = {
    version: LAUNCH_SPEC_VERSION,
    name,
    cwd,
    env: specEnv,
    command: "pi",
    args: [
      "--session",
      sessionFile,
      "-e",
      join(SUBAGENTS_DIR, "pmux-done.ts"),
      "--model",
      definition.thinking ? `${definition.model}:${definition.thinking}` : definition.model,
      "--append-system-prompt",
      rolePromptPath,
      "--tools",
      buildSubagentToolAllowlist(definition.tools, report === "send" ? ["bash"] : []),
      "--name",
      name,
    ],
    sessionFile,
    title: buildPaneTitle(name, briefText),
    closeOnDone: { graceMs },
    parent,
    ...(report === "send" ? { report: "send" as const } : {}),
    ...(definition.surface !== undefined ? { surface: definition.surface } : {}),
  };
  writeLaunchSpec(specPath, spec);

  // A new run must not read the status of an earlier run, nor its exit.
  removeChildStatus(sessionFile);
  removeExitSidecar(sessionFile);

  const pane = createSurface(name, placement, callerPaneId(env));
  runInPane(pane, paneLine);

  write(JSON.stringify({ pane, session: sessionFile, launch: specPath }) + "\n");
  return 0;
}

/** `resume`: run an existing launch spec in a new pane with a new prompt. */
function resumeCommand(values: CliValues, deps: CliDeps): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));

  const launchPath = required("--launch", values.launch);
  const promptPath = required("--prompt", values.prompt);
  if (!isFile(launchPath)) throw new Error(`launch spec is not a file: ${launchPath}`);
  if (!isFile(promptPath)) throw new Error(`prompt is not a file: ${promptPath}`);
  assertHostEnv(env);

  const spec = readLaunchSpec(launchPath);
  // The placement resolves here too, from the role surface stored in the spec.
  const placement = resolvePlacement(spec.surface, loadSurfaceConfig(deps.configPath));
  // A resume reuses the spec unchanged, so its session and close grace carry
  // over; only the prompt and the pane are new.
  // `start` appends the parent-contact footer; a resume must too, or the child
  // has no instruction to send its report (the orchestrator then never wakes).
  let sentPrompt = promptPath;
  if (spec.parent !== undefined) {
    sentPrompt = `${promptPath}.resume.md`;
    const footer =
      spec.report === "send"
        ? sendFooter(spec.parent, CLI_PATH)
        : parentFooter(spec.parent, callerPaneId(env));
    writeFileSync(sentPrompt, `${readFileSync(promptPath, "utf8")}\n${footer}\n`);
  }
  const paneLine = paneCommandLine(CLI_PATH, launchPath, sentPrompt);

  // The launch spec carries the session file; the status of the earlier run
  // must not survive into this one, nor its exit.
  removeChildStatus(spec.sessionFile);
  removeExitSidecar(spec.sessionFile);

  const pane = createSurface(values.name ?? spec.name, placement, callerPaneId(env));
  runInPane(pane, paneLine);

  write(JSON.stringify({ pane, launch: launchPath }) + "\n");
  return 0;
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
 */
function writeReportReceipt(env: NodeJS.ProcessEnv, to: string, text: string): void {
  const session = env.PI_PMUX_SESSION;
  if (!session) return;
  try {
    appendFileSync(
      `${session}.sent`,
      `${JSON.stringify({ at: new Date().toISOString(), to, bytes: text.length })}\n`,
    );
  } catch {
    // Best effort; the delivery already happened.
  }
}

/** `send`: deliver one report line into a pane (paste, then Enter). */
function sendCommand(values: CliValues, deps: CliDeps): number {
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const to = required("--to", values.to);
    const text = required("--text", values.text);
    agentPrompt(to, text);
    writeReportReceipt(deps.env ?? process.env, to, text);
    return 0;
  } catch (error) {
    // A usage error must leave stdout empty and stay out of the entry
    // wrapper, so it is caught here instead of bubbling up.
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`cli.ts: ${message}\n`);
    return 1;
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
 * `wait`: poll `<session>.status` until it holds one of the wanted statuses.
 * A missing file counts as no status yet. Exit 0 prints the status line,
 * exit 2 is a timeout (it prints the last line seen, or `{"status":null}`),
 * exit 1 is a usage error. The loop reads a file only; no host is involved.
 */
async function waitCommand(values: CliValues, deps: CliDeps): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    const sessionPath = required("--session", values.session);
    const wanted = new Set(waitStatuses(values.status));
    const timeoutSeconds = waitTimeoutSeconds(values.timeout);

    const statusPath = statusFilePath(sessionPath);
    const deadline = Date.now() + timeoutSeconds * 1000;
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
          write(`${last}\n`);
          return 0;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(WAIT_POLL_MS, remaining));
    }

    write(`${last ?? JSON.stringify({ status: null })}\n`);
    writeErr(
      last === null
        ? `timeout after ${timeoutSeconds}s: no status was seen\n`
        : `timeout after ${timeoutSeconds}s: last status was ${rawChildStatusName(last)}\n`,
    );
    return 2;
  } catch (error) {
    // A usage error must leave stdout empty, so it is caught here instead of
    // bubbling to the entry wrapper.
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`cli.ts: ${message}\n`);
    return 1;
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
    return resumeCommand(values as CliValues, deps);
  }
  if (command === "start") {
    const report = reportMode(values as CliValues, writeErr);
    return report === null ? 2 : startCommand(values as CliValues, deps, report);
  }
  if (command === "run") return runCommand(positionals.slice(1), deps);
  if (command === "send") return sendCommand(values as CliValues, deps);
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
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`cli.ts: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
