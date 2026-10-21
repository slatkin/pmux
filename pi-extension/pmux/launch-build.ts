/**
 * The shared pi launch builder (design D1): one module builds the pi launch
 * spec, so the pi parent and the external orchestrator cannot drift. The
 * parent contact is one tagged input (design D3), and the contact footers
 * moved here from `cli.ts` so both paths append the same bytes. The
 * supervisor keeps the `RunningSubagent` construction, whose per-run values
 * only it resolves (design D2).
 *
 * `launch.ts` stays the spec format the pane side reads; this module adds the
 * prompt and env helpers the launch needs on top of it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSubagentToolAllowlist } from "./agent-defs.ts";
import { encodeChildEnv } from "./child-env.ts";
import { LAUNCH_SPEC_VERSION, buildPaneTitle, type LaunchSpec, type ReportMode } from "./launch.ts";
import type { LaunchRecord } from "./launch-record.ts";
import { slugifyName } from "./slug.ts";

/** Absolute path to `pi-extension/pmux`. https://github.com/nodejs/node/issues/37845 */
export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The pane-side entry point every launch spec runs through. The send footer
 * names it; defined once from this module's own directory, so the moved
 * footer bytes cannot drift (design D3).
 */
export const SUBAGENTS_CLI_PATH = join(SUBAGENTS_DIR, "cli.ts");

/**
 * How the launch reaches its parent (design D3): one tagged input, so the pi
 * parent and the external orchestrator cannot name the contact differently.
 *
 * - `pi`: a child of this pi session. The contact carries the peer names the
 *   child gets at spawn time, the parent's roster file, and the pane the
 *   child runs in (the child env names it as the surface).
 * - `external`: a child of an external orchestrator (the packaged skill). The
 *   footer names the parent and the pane it launched from; the spec carries
 *   the report mode and the close-on-done grace.
 */
export type ParentContact =
  | { kind: "pi"; siblingNames: string[]; parentRosterFile?: string; surface: string }
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
    ? "Complete your task autonomously. Call pmux_done when finished."
    : "Complete your task. When finished, call the pmux_done tool. The user can interact with you at any time.";
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
  return env;
}

/**
 * The parent-contact footer appended to the brief. There is no send channel
 * back to the parent, so the report is the child's last assistant message.
 */
export function parentFooter(parent: string, pane: string): string {
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
export function sendFooter(parent: string, cliPath: string): string {
  return `Your parent is the tmux pane ${parent}.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node ${cliPath} send --to ${parent} --text '<text>'.

If this session auto-exits, it closes the first time you stop generating: the moment you end a turn without calling a tool, the session closes. Whether it does or not, do ALL of the following before you stop:
1. Finish the task.
2. Send your final report: node ${cliPath} send --to ${parent} --text '<verdict / commit SHA / files changed / verification / deviations / open questions>'
   This is what wakes the orchestrator with your report — without it, it only learns that you exited.
   The report text may be long, may contain quotes and may span several lines — reading it from a file into the argument is fine; only the target pane matters. A line break arrives as the two characters \\n, so the orchestrator still reads the whole report as one message.
3. Then call the pmux_done tool to close your session.

If you are blocked, send your question with the send command and stop. The session closes; the parent resumes it with the answer. Do not try to reach the parent any other way.
If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered — send your report with the send command first, then call pmux_done.`;
}

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

  const identity = record.rolePrompt ?? null;

  // Send mode is the one exemption (AGENTS.md): the report is a bash command,
  // so the child must keep the bash tool on both sides. The allowlist below
  // gains it and the denied set loses it (`PI_DENY_TOOLS` wins over `--tools`).
  const denied = new Set(record.denyTools);
  if (parentContact.kind === "external" && parentContact.report === "send") {
    denied.delete("bash");
  }

  // Build pi argv (no shell: every value stays exactly one argument).
  const piArgs: string[] = ["--session", run.sessionFile];

  const subagentDonePath = join(SUBAGENTS_DIR, "pmux-done.ts");
  piArgs.push("-e", subagentDonePath);

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
      "context",
      `${slugifyName(record.name, { hyphenate: false }) || "subagent"}-sysprompt`,
      identity,
    );
    piArgs.push(flag, syspromptPath);
  }

  // The tools: the recorded allowlist with the control tools appended. Send
  // mode adds bash, matching the removal from the denied set above.
  const toolAllowlist =
    parentContact.kind === "external" && parentContact.report === "send"
      ? buildSubagentToolAllowlist(record.tools, ["bash"])
      : buildSubagentToolAllowlist(record.tools);
  if (toolAllowlist) {
    piArgs.push("--tools", toolAllowlist);
  }

  // Env: denied tools + subagent identity. A pi parent adds the surface, the
  // roster and the config-dir propagation (the target cwd's own .pi/agent/
  // wins); an external parent adds only the external-parent marker (design
  // D3) — its wrapper writes the surface from `TMUX_PANE` at runtime.
  const spawnEnv =
    parentContact.kind === "external"
      ? buildSpawnEnvParts({
          name: record.name,
          agent: record.agent,
          autoExit: record.autoExit,
          subagentSessionFile: run.sessionFile,
          id: run.id,
          activityFile: run.activityFile,
          denySet: denied,
          externalParent: true,
        })
      : buildSpawnEnvParts({
          name: record.name,
          agent: record.agent,
          autoExit: record.autoExit,
          subagentSessionFile: run.sessionFile,
          id: run.id,
          activityFile: run.activityFile,
          denySet: denied,
          surface: parentContact.surface,
          parentRosterFile: parentContact.parentRosterFile,
          codingAgentDir:
            request.localAgentDir && existsSync(request.localAgentDir)
              ? request.localAgentDir
              : process.env.PI_CODING_AGENT_DIR,
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
      isResume ? "pmux-resume" : "context",
      slugifyName(record.name, { hyphenate: false }) || (isResume ? "resume" : "subagent"),
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
        "pmux-resume",
        slugifyName(record.name, { hyphenate: false }) || "resume",
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
      summaryInstruction: record.autoExit
        ? "Your FINAL assistant message should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one."
        : "Your FINAL assistant message (before calling pmux_done or before the user exits) should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one.",
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
        "context",
        slugifyName(record.name, { hyphenate: false }) || "subagent",
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
