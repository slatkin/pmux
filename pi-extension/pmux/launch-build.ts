/**
 * The shared pi launch builder (design D1): one module builds the pi launch
 * spec, so the pi parent and the external orchestrator cannot drift. The
 * parent contact is one tagged input (design D3), and the contact footers
 * moved here from `cli.ts` so both paths append the same bytes. The
 * supervisor keeps the `RunningSubagent` construction, whose per-run values
 * only it resolves (design D2).
 *
 * `launch.ts` stays the spec format the pane side reads; this module adds the
 * prompt and env helpers the launch needs on top of it. Role resolution is
 * here too (design D6): one function resolves every launch's role into the
 * record a resume reads, so the pi parent and the external orchestrator
 * cannot resolve a role differently.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDefinitionPaths,
  buildSubagentToolAllowlist,
  getAgentConfigDir,
  loadAgentDefaults,
  type AgentDefaults,
} from "./agent-defs.ts";
import { encodeChildEnv, resolveDenyTools, subagentMarkerEnv } from "./child-env.ts";
import { LAUNCH_SPEC_VERSION, buildPaneTitle, type LaunchSpec, type ReportMode } from "./launch.ts";
import { LAUNCH_RECORD_VERSION, type LaunchRecord } from "./launch-record.ts";
import { slugifyName } from "./slug.ts";

/** Absolute path to `pi-extension/pmux`. https://github.com/nodejs/node/issues/37845 */
export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The pane-side entry point every launch spec runs through. The send footer
 * names it; defined once from this module's own directory, so the moved
 * footer bytes cannot drift (design D3).
 */
export const SUBAGENTS_CLI_PATH = join(SUBAGENTS_DIR, "cli.ts");

/** The completion tool every pi child loads. */
const SUBAGENTS_DONE_PATH = join(SUBAGENTS_DIR, "pmux-done.ts");

/**
 * The report protocol a send-mode launch selects (design D1): the spec-env
 * marker every `file-ack-v1` behaviour reads — `send` from its process env,
 * the run wrapper from the spec env. A send-mode spec sets it; a `last`-mode
 * spec and a pi-parent launch never do, so an unmarked child keeps the
 * legacy raw-text behaviour even when the package's CLI changes under it.
 */
export const REPORT_PROTOCOL = "file-ack-v1";

/**
 * How the launch reaches its parent (design D3): one tagged input, so the pi
 * parent and the external orchestrator cannot name the contact differently.
 *
 * - `pi`: a child of this pi session. The contact carries the peer names the
 *   child gets at spawn time and the parent's roster file. The pane the child
 *   runs in is the request's own `surface`.
 * - `external`: a child of an external orchestrator (the packaged skill). The
 *   footer names the parent and the pane it launched from; the spec carries
 *   the report mode and the close-on-done grace.
 */
export type ParentContact =
  | { kind: "pi"; siblingNames: string[]; parentRosterFile?: string }
  | {
      kind: "external";
      parent: string;
      /** The pane the external orchestrator launched from. */
      callerPane: string;
      /** The report mode; the footer and the spec's `report` field follow it. */
      report: ReportMode;
      /** The close-on-done grace of the launch spec. */
      closeGraceMs: number;
    };

/** The parts of a launch request the pi builder needs (design D2). */
export interface PiLaunchRequest {
  /** Role values the spawn resolved once (design D3). */
  record: LaunchRecord;
  /** The spawning task, which the record does not keep. */
  task: string;
  /** Skill prompts for this spawn, which the record does not keep. */
  skills?: string;
  /** Spawn-only: how the task reaches the child. */
  launchBehavior?: { inheritsConversationContext: boolean; taskDelivery: "direct" | "artifact" };
  /** The target cwd's `.pi/agent` directory, when it has one. */
  localAgentDir: string | null;
  artifactDir: string;
  /** The pane the child runs in. A pi parent sets it; an external launch
   * omits it, and the run wrapper writes it from `TMUX_PANE` at runtime. */
  surface?: string;
  /** How the launch reaches its parent (design D3). */
  parentContact: ParentContact;
  /** Set when the run continues an existing session (design D5). */
  resume?: {
    /** The follow-up message; the session keeps the spawn task and role. */
    message?: string;
  };
  /** Values that change for every run; the record does not keep them (design D3). */
  run: {
    id: string;
    /** Child session file (pi). */
    sessionFile: string;
    activityFile: string;
  };
}

/** The launch's resolved cwd values (the record carries only the effective cwd). */
export interface ResolvedLaunchPaths {
  /** The cwd the child starts in; null leaves the caller's cwd. */
  effectiveCwd: string | null;
  /** The effective cwd's own `.pi/agent` directory. */
  localAgentDir: string | null;
  /** The session directory's `.pi/agent` root: the effective cwd's, or the
   * global agent config dir.
   */
  effectiveAgentDir: string;
}

/** The pi parent's per-call values on top of the role's (design D6). */
export interface LaunchRecordOverrides {
  /** The child's display name; the record field, not a role value. */
  name: string;
  model?: string;
  /** Run the role on its `model-fallback` instead (design D1); conflicting
   * with `model` (design D2). */
  fallback?: boolean;
  tools?: string;
  skills?: string;
  /** Per-call cwd; a relative value resolves against the launch's anchor
   * (the resolveSubagentPaths rule). */
  cwd?: string;
  /** Explicit per-call value; `null` leaves the role value to decide. */
  interactive?: boolean | null;
  /** Role instructions supplied on the call when the role body leaves a gap. */
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
}

/** The role resolution one launch does: the record, the definition it came
 * from, the skills the launch prompt uses, and the cwd values the launch
 * layout needs.
 */
export interface ResolvedLaunchRole {
  record: LaunchRecord;

  /** The role definition, when one loaded: null when `role` is absent or
   * did not resolve. */
  definition: AgentDefaults | null;
  /** Effective skill prompts of the launch (overrides win over the role's). */
  skills?: string;
  paths: ResolvedLaunchPaths;
}

/** True when the path names an existing file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve the launch's cwd values: a per-call cwd wins over the role's own
 * `cwd:`, and a relative one resolves against the anchor the caller chose —
 * the two launch paths never shared one: the pi parent anchors at
 * `process.cwd()`, the external path at its `--cwd` value.
 */
export function resolveSubagentPaths(
  cwd: string | undefined,
  definition: AgentDefaults | null,
  baseCwd: string,
): ResolvedLaunchPaths {
  const rawCwd = cwd ?? definition?.cwd ?? null;
  const cwdIsFromAgent = !cwd && definition?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : baseCwd;
  const effectiveCwd = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : join(cwdBase, rawCwd)) : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

/**
 * A subagent is interactive (user-driven, long-running) unless it opted out:
 * an explicit `interactive:` wins over `auto-exit:`, whose inverse is the
 * default. Agents that auto-exit are autonomous and the parent session is
 * woken on stall events; agents that do not are user-driven and stall pings
 * are noise. No role values at all (a bare spawn) reads as interactive.
 */
export function resolveInteractiveDefault(definition: AgentDefaults | null): boolean {
  if (definition?.interactive != null) return definition.interactive;
  return !(definition?.autoExit ?? false);
}

/** The error an unresolved role throws: only this one is caught and turned
 * into an error result (design D1); every other throw must surface directly.
 */
export class UnknownRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownRoleError";
  }
}

/**
 * Resolve one launch's role into the record a later resume reads (design D6).
 * `strict` fails before any file is written when the role does not resolve or
 * has an empty model and no override supplies one; an external launch sets it
 * because its role name comes from a `--role` flag. `requireRole` fails only
 * the unresolved role — the pi parent sets it, because its schema requires
 * `agent` (design D1), and a role with no `model:` still launches on pi's
 * default model. Under either flag, a blank value names nothing and fails:
 * the schema's `Type.String()` has no minLength, so an empty `agent` reaches
 * this check instead of the schema.
 *
 * A `fallback` launch runs the role's `model-fallback` through the record's
 * one `model` field (design D1). Its two errors (design D2) join the ones
 * above, all before any pane or file exists: `fallback` with `model`, and
 * `fallback` on a role without the key. With `fallback`, the strict
 * empty-model check applies to `model-fallback`, so a role with only
 * `model-fallback` starts.
 */
export function resolveLaunchRecord(params: {
  role?: string;
  /** The cwd role resolution and a relative per-call cwd resolve against:
   * the pi parent passes `process.cwd()`, the external path its `--cwd`
   * value. Exactly one caller-chosen anchor, so neither path can change
   * what the other resolves.
   */
  anchor: string;
  /** The per-call values on top of the role's. */
  overrides: LaunchRecordOverrides;
  /** Fail loudly on a blank role, an unknown role, or an empty effective
   * model. */
  strict?: boolean;
  /** Fail loudly on a blank or unresolved role, without `strict`'s
   * empty-model check (design D1: the spawn requires the role to exist
   * only). */
  requireRole?: boolean;
}): ResolvedLaunchRole {
  const overrides = params.overrides;
  // The conflict is caller input, not role state: it reads before the role
  // even loads (design D2).
  if (overrides.fallback === true && overrides.model !== undefined) {
    throw new Error("fallback conflicts with model: pass one");
  }
  const definition = params.role ? loadAgentDefaults(params.role, params.anchor) : null;

  const fallback = overrides.fallback === true;
  // The model that applies (designs D1 and D2): a fallback launch runs the
  // role's `model-fallback`; every other launch keeps the call's model over
  // the role's. The conflict error above makes `overrides.model`
  // unreachable in the fallback branch.
  const effectiveModel = fallback
    ? definition?.modelFallback
    : (overrides.model ?? definition?.model);

  if (params.strict || params.requireRole) {
    // A blank value names nothing: the schema has no minLength, so the
    // missing-value case lands here instead of a task-only launch.
    if (!params.role?.trim()) {
      throw new UnknownRoleError("agent must name an agent role (see pmux_list).");
    }
    const rolePaths = agentDefinitionPaths(params.role, params.anchor);
    if (definition === null) {
      throw new UnknownRoleError(
        `unknown role '${params.role}' (searched: ${rolePaths.join(" ")})`,
      );
    }
    // With `fallback` the applied model is the role's `model-fallback`, and
    // its absence is the error below; a blank key reads as absent (design
    // D3). Without it, the strict empty-model check keeps today's shape.
    if (fallback && !definition?.modelFallback) {
      const rolePath = rolePaths.find(isFile) ?? rolePaths[0];
      throw new Error(`role '${params.role}' has no model-fallback (${rolePath})`);
    }
    if (params.strict && !fallback && !definition.model && overrides.model === undefined) {
      const rolePath = rolePaths.find(isFile) ?? rolePaths[0];
      throw new Error(`role '${params.role}' has an empty model (${rolePath})`);
    }
  }

  const paths = resolveSubagentPaths(overrides.cwd, definition, params.anchor);
  // The role body is the role; the call's system prompt only fills a gap, and
  // for a Claude Code child it wins (that backend kept the old precedence).
  // This is the only place the precedence lives: the record carries the
  // result, so a later resume and every launch path read the same bytes.
  const rolePrompt =
    definition?.cli === "claude"
      ? (overrides.systemPrompt ?? definition.body)
      : (definition?.body ?? overrides.systemPrompt);
  const effectiveTools = overrides.tools ?? definition?.tools;
  const effectiveSkills = overrides.skills ?? definition?.skills;

  const record: LaunchRecord = {
    version: LAUNCH_RECORD_VERSION,
    // The backend follows the role's `cli:` value; the supervisor's backend
    // table is keyed by this name.
    backend: definition?.cli === "claude" ? "claude" : "pi",
    name: overrides.name,
    ...(params.role ? { agent: params.role } : {}),
    ...(paths.effectiveCwd ? { cwd: paths.effectiveCwd } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    // Only the role's `thinking:` exists: no call value.
    ...(definition?.thinking ? { thinking: definition.thinking } : {}),
    ...(effectiveTools ? { tools: effectiveTools } : {}),
    ...(rolePrompt ? { rolePrompt } : {}),
    ...(definition?.systemPromptMode
      ? { systemPromptMode: definition.systemPromptMode }
      : overrides.systemPromptMode
        ? { systemPromptMode: overrides.systemPromptMode }
        : {}),
    // The record holds the role's surface only, so a later resume keeps
    // the same placement.
    ...(definition?.surface ? { surface: definition.surface } : {}),
    denyTools: [...resolveDenyTools(definition)],
    autoExit: definition?.autoExit ?? false,
    interactive:
      overrides.interactive === undefined || overrides.interactive === null
        ? resolveInteractiveDefault(definition)
        : overrides.interactive,
  };

  return {
    record,
    definition,
    skills: effectiveSkills,
    paths,
  };
}

/** The run-context folders the launcher itself writes into (design D4):
 * spawn-task and system-prompt files under `context`, resume-message files
 * under `pmux-resume`. These are the launcher's own artifact names; prune.ts
 * imports them, so the cleanup and the writer cannot name the folders
 * differently. */
export const LAUNCH_CONTEXT_FOLDER = "context";
export const LAUNCH_RESUME_FOLDER = "pmux-resume";

/** The file-name stamp every launcher-written run-context file ends with:
 * `<stem>-<19-char timestamp>.md`, the format `writeRunContextFile` puts on
 * every file it creates. prune.ts keys the artifact cleanup on it. */
export const LAUNCHER_ARTIFACT_FILE = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/;

/** The per-parent artifact directory the launcher writes its run-context
 * files into; prune.ts walks the same tree. */
export function artifactDirFor(scratch: string, id: string): string {
  return join(scratch, "artifacts", id);
}

/** The run-context file stem: the record name, slugified, falling back to
 * `fallback` when the record has no name (each launch kind keeps its own). */
function contextStem(record: LaunchRecord, fallback: string): string {
  return slugifyName(record.name, { hyphenate: false }) || fallback;
}

/** Write one run's context file under the artifact directory and return its path. */
export function writeRunContextFile(
  artifactDir: string,
  folder: string,
  stem: string,
  content: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(artifactDir, folder, `${stem}-${timestamp}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

export function buildSubagentTaskPrompt(params: {
  task: string;
  roleBlock: string;
  modeHint: string;
  summaryInstruction: string;
  messagingHint: string;
  inheritsConversationContext: boolean;
}): string {
  return params.inheritsConversationContext
    ? `${params.task}\n\n${params.messagingHint}`
    : `${params.roleBlock}\n\n${params.modeHint}\n\n${params.messagingHint}\n\n${params.task}\n\n${params.summaryInstruction}`;
}

/** The launch-prompt line naming the peers a fresh subagent can message. */
export function buildLaunchMessagingHint(siblingNames: string[]): string {
  const names = [...new Set(["parent", ...siblingNames])];
  const list = names.map((name) => `\`${name}\``).join(", ");
  return `You can message ${list} with pmux_message; it does not end your session.`;
}

/** Task hint shown to the child: auto-exit agents are now told to exit explicitly too. */
export function resolveModeHint(autoExit?: boolean): string {
  return autoExit
    ? "Complete your task autonomously, then call pmux_done."
    : "Complete your task, then call the pmux_done tool. The user can interact with you at any time.";
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/** Env for a freshly spawned pi subagent, in launch-spec form. */
export function buildSpawnEnvParts(params: {
  name: string;
  agent?: string;
  autoExit?: boolean;
  subagentSessionFile: string;
  id: string;
  activityFile: string;
  /** The pane the child runs in. A pi parent sets it; an external one omits
   * it, and the run wrapper writes it from `TMUX_PANE` at runtime. */
  surface?: string;
  codingAgentDir?: string;
  denySet: Set<string>;
  parentRosterFile?: string;
  /** Marks a child whose parent is an external orchestrator (design D3). */
  externalParent?: boolean;
  /** The parent's env, for the subagent-depth increment and the marker-list
   * merge. Defaults to `process.env` inside `subagentMarkerEnv`. */
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** The report protocol marker of a send-mode launch (design D1). */
  reportProtocol?: string;
}): Record<string, string> {
  const env = encodeChildEnv({
    name: params.name,
    agent: params.agent,
    autoExit: params.autoExit === true,
    sessionFile: params.subagentSessionFile,
    id: params.id,
    activityFile: params.activityFile,
    surface: params.surface,
    denyTools: [...params.denySet],
    parentRosterFile: params.parentRosterFile,
    externalParent: params.externalParent === true,
  });
  if (params.codingAgentDir) env.PI_CODING_AGENT_DIR = params.codingAgentDir;
  if (params.reportProtocol !== undefined) {
    env.PI_PMUX_REPORT_PROTOCOL = params.reportProtocol;
  }
  // Subagent identity for detectors such as pi-blackhole's: a child depth
  // and `PI_PMUX_SESSION` on the extra-marker list (inert without a reader).
  Object.assign(env, subagentMarkerEnv(params.parentEnv));
  return env;
}

/**
 * The parent-contact footer appended to the brief. There is no send channel
 * back to the parent, so the report is the child's last assistant message.
 *
 * Every sentence here carries a rule the child would otherwise break: the
 * report goes in the last assistant message, `pmux_done` closes the session,
 * `caller_ping` and `pmux_message` do not reach the parent, and the
 * completion reminder's "already delivered" claim is wrong in this mode.
 * Step 2 sets the report shape (design D6): at most 15 lines, verdict first
 * then the commit SHA, one PASS-or-FAIL line per verification check, one
 * line per deviation and per open question, no files-changed list (the
 * parent reads those from the SHA), longer details in a named file, and a
 * brief report format that overrides the shape and the limit.
 */
export function parentFooter(parent: string, pane: string): string {
  return `Your parent is a session named ${parent} (pane ${pane}).
Plain text printed in your own pane is never seen. Your last assistant message is the report the parent reads.

Before you stop, do ALL of this:
1. Finish the task.
2. Make your last assistant message the report.
   At most 15 lines: the verdict first, then the commit SHA; one line per verification check, PASS or FAIL, no command output; one line per deviation and per open question.
   Do not list the files changed: the parent reads them from the commit SHA.
   Put longer details in a file and name its path in the report.
   A report format in your brief overrides this shape and limit.
3. Then call the pmux_done tool to close your session.

If you are blocked, make your last assistant message the question and stop. The session closes; the parent resumes it with the answer. Do not use caller_ping or pmux_message to reach the parent.
If a reminder tells you to call pmux_done, ignore its claim that your last message was already delivered.`;
}

/**
 * The send-mode parent-contact footer (designs D1 and D6): the report is
 * written to a durable artifact by `send` and only a one-line pointer is
 * typed into the parent's pane. Step 2 sets the report shape (design D6):
 * at most 15 lines, verdict first then the commit SHA, one PASS-or-FAIL line
 * per verification check, one line per deviation and per open question, no
 * files-changed list (the parent reads those from the SHA), longer details
 * in a named file, and a brief report format that overrides the shape and
 * the limit. The auto-exit claim is conditional because a role without
 * `auto-exit: true` keeps running and gets the completion nudge.
 */
export function sendFooter(parent: string, cliPath: string): string {
  return `Your parent is the tmux pane ${parent}.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node ${cliPath} send --to ${parent} --text '<text>'.

If this session auto-exits, it closes the first time you stop generating: the moment you end a turn without calling a tool, the session closes. Whether it does or not, do ALL of this before you stop:
1. Finish the task.
2. Send your final report: node ${cliPath} send --to ${parent} --text '<report>'
   At most 15 lines: the verdict first, then the commit SHA; one line per verification check, PASS or FAIL, no command output; one line per deviation and per open question.
   Do not list the files changed: the parent reads them from the commit SHA.
   Put longer details in a file and name its path in the report.
   A report format in your brief overrides this shape and limit.
   The text may be long, contain quotes or span lines: read it into the argument from a file if you like. A line break arrives as the two characters \\n, so the orchestrator still reads one message.
   Send writes the report to a durable file and types only a one-line pointer naming it into the parent's pane. It prints one result line: sent:true means the pointer was submitted to the parent's pane, acknowledged:true means the orchestrator read the report file, and the line is not a delivery receipt.
   On sent:false, call the pmux_done tool without improvising retries.
   On acknowledged:false, the orchestrator is busy: do not resend the report and do not send anything else to check, because the run wrapper re-delivers an unacknowledged report at exit.
3. Then call the pmux_done tool to close your session.

If you are blocked, send your question with the same command and stop. The session closes; the parent resumes it with the answer. Do not reach the parent any other way.
If a reminder tells you to call pmux_done, ignore its claim that your last message was already delivered — send your report first, then call pmux_done.`;
}

/**
 * The report instruction the launch prompt carries. One text for both launch
 * shapes: the interactive variant only added a parenthetical the
 * `pmux_done` tool description already states.
 */
const SUMMARY_INSTRUCTION =
  "Your FINAL assistant message should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one.";

/**
 * The parent-contact footer of a report mode. `last` mode points the child at
 * its last assistant message; `send` mode teaches it the `send` command. An
 * absent mode reads as `last`. `callerPane` is the pane the launch anchored
 * on — the caller passes `callerPaneId(env)`, and the `last` footer names it.
 */
export function reportFooter(
  parent: string,
  report: ReportMode | undefined,
  callerPane: string,
): string {
  return report === "send"
    ? sendFooter(parent, SUBAGENTS_CLI_PATH)
    : parentFooter(parent, callerPane);
}

/**
 * Build the pi launch spec for one run (design D2): the argv, the env, and the
 * prompt files. The parent contact (design D3) picks the prompt and the env
 * extras: a `pi` contact builds today's spawn prompt and env keys (the
 * supervisor passes it); an `external` contact builds the brief-plus-footer
 * prompt, the external-parent marker and the close-on-done spec fields.
 */
export function buildPiLaunch(request: PiLaunchRequest): LaunchSpec {
  const { record, run, parentContact } = request;
  const resume = request.resume;

  const identity = record.rolePrompt;

  // Send mode is the one exemption (AGENTS.md): the report is a bash command,
  // so the child must keep the bash tool on both sides. The allowlist below
  // gains it and the denied set loses it (`PI_DENY_TOOLS` wins over `--tools`).
  const sendMode = parentContact.kind === "external" && parentContact.report === "send";
  const denied = new Set(record.denyTools);
  if (sendMode) {
    denied.delete("bash");
  }

  // Build pi argv (no shell: every value stays exactly one argument).
  const piArgs: string[] = ["--session", run.sessionFile];

  piArgs.push("-e", SUBAGENTS_DONE_PATH);

  if (record.model) {
    const model = record.thinking ? `${record.model}:${record.thinking}` : record.model;
    piArgs.push("--model", model);
  }

  // Pass the role prompt as a system prompt via file to avoid shell escaping
  // issues with multiline content. Pi's --append-system-prompt and
  // --system-prompt auto-detect file paths and read their contents. A pi
  // session does not store these flags, so a resume writes the file again.
  // An external parent always launches in append mode (design D4): its role
  // body appends too, and an empty role body writes no file and passes no flag.
  const systemPromptMode = parentContact.kind === "external" ? "append" : record.systemPromptMode;
  if (systemPromptMode && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const syspromptPath = writeRunContextFile(
      request.artifactDir,
      LAUNCH_CONTEXT_FOLDER,
      `${contextStem(record, "subagent")}-sysprompt`,
      identity,
    );
    piArgs.push(flag, syspromptPath);
  }

  // The tools: the recorded allowlist with the control tools appended. Send
  // mode adds bash, matching the removal from the denied set above.
  const toolAllowlist = sendMode
    ? buildSubagentToolAllowlist(record.tools, ["bash"])
    : buildSubagentToolAllowlist(record.tools);
  if (toolAllowlist) {
    piArgs.push("--tools", toolAllowlist);
  }

  // Env: denied tools + subagent identity. A pi parent adds the surface, the
  // roster and the config-dir propagation (the target cwd's own .pi/agent/
  // wins); an external parent adds only the external-parent marker (design
  // D3) — its wrapper writes the surface from `TMUX_PANE` at runtime.
  const piMode = parentContact.kind === "pi";
  const spawnEnv = buildSpawnEnvParts({
    name: record.name,
    agent: record.agent,
    autoExit: record.autoExit,
    subagentSessionFile: run.sessionFile,
    id: run.id,
    activityFile: run.activityFile,
    denySet: denied,
    // Send mode alone selects the report protocol (design D1).
    ...(sendMode ? { reportProtocol: REPORT_PROTOCOL } : {}),
    ...(piMode
      ? {
          surface: request.surface,
          parentRosterFile: parentContact.parentRosterFile,
          // The target cwd's own .pi/agent/ wins over the parent's.
          codingAgentDir:
            request.localAgentDir && existsSync(request.localAgentDir)
              ? request.localAgentDir
              : process.env.PI_CODING_AGENT_DIR,
        }
      : { externalParent: true }),
  });

  if (parentContact.kind === "external") {
    // Today's external bytes (design D3): the follow-up text or the brief, the
    // newline that joined it to the footer, the footer, and the trailing
    // newline of today's prompt file. The footer replaces the launch hints and
    // the summary instruction: the `last` footer forbids `pmux_message`, and
    // the pi messaging hint recommends it. The prompt is always the artifact
    // (design D4), and its path lives inside the spec args (design D5), where
    // the pane token rule cannot see the `%` of an id.
    const footer = reportFooter(
      parentContact.parent,
      parentContact.report,
      parentContact.callerPane,
    );
    const isResume = resume?.message !== undefined;
    const promptPath = writeRunContextFile(
      request.artifactDir,
      isResume ? LAUNCH_RESUME_FOLDER : LAUNCH_CONTEXT_FOLDER,
      contextStem(record, isResume ? "resume" : "subagent"),
      isResume ? `${resume?.message}\n${footer}\n` : `${request.task}\n${footer}\n`,
    );
    // The recorded `--name` stays where today's external launch put it.
    piArgs.push("--name", record.name, `@${promptPath}`);
  } else if (resume) {
    // The session keeps the spawn task and role. A resume adds only the follow-up
    // message, behind the peers the child can reach at resume time.
    if (resume.message) {
      const promptPath = writeRunContextFile(
        request.artifactDir,
        LAUNCH_RESUME_FOLDER,
        contextStem(record, "resume"),
        `${buildLaunchMessagingHint(parentContact.siblingNames)}\n\n${resume.message}`,
      );
      piArgs.push(`@${promptPath}`);
    }
  } else {
    const launchBehavior = request.launchBehavior;
    if (!launchBehavior) throw new Error("A spawn launch needs a launch behavior");

    // Only full-context fork mode inherits prior conversation state.
    // Blank-session modes need the wrapper instructions and artifact-backed handoff.
    const identityInSystemPrompt = systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = buildSubagentTaskPrompt({
      task: request.task,
      roleBlock,
      modeHint: resolveModeHint(record.autoExit),
      summaryInstruction: SUMMARY_INSTRUCTION,
      messagingHint: buildLaunchMessagingHint(parentContact.siblingNames),
      inheritsConversationContext: launchBehavior.inheritsConversationContext,
    });

    // Pass task and skill prompts to the sub-agent.
    // Only full-context fork mode gets a direct task argument because it already
    // inherits the parent conversation. Blank-session modes use artifact-backed
    // handoff so the wrapper instructions arrive as the initial user message.
    let taskArg: string;
    if (launchBehavior.taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      const artifactPath = writeRunContextFile(
        request.artifactDir,
        LAUNCH_CONTEXT_FOLDER,
        contextStem(record, "subagent"),
        fullTask,
      );
      taskArg = `@${artifactPath}`;
    }

    piArgs.push(
      ...buildPiPromptArgs({
        effectiveSkills: request.skills,
        taskDelivery: launchBehavior.taskDelivery,
        taskArg,
      }),
    );
  }

  return {
    version: LAUNCH_SPEC_VERSION,
    name: record.name,
    ...(record.cwd ? { cwd: record.cwd } : {}),
    env: spawnEnv,
    command: "pi",
    args: piArgs,
    sessionFile: run.sessionFile,
    title: buildPaneTitle(record.name, resume?.message ?? request.task),
    ...(parentContact.kind === "external"
      ? {
          parent: parentContact.parent,
          closeOnDone: { graceMs: parentContact.closeGraceMs },
          ...(record.surface ? { surface: record.surface } : {}),
          ...(parentContact.report === "send" ? { report: "send" as const } : {}),
        }
      : {}),
  };
}
