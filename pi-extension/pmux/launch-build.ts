/**
 * The shared pi launch builder (design D1): one module builds the pi launch
 * spec, so the pi parent and the external orchestrator cannot drift. The
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
import { LAUNCH_SPEC_VERSION, buildPaneTitle, type LaunchSpec } from "./launch.ts";
import type { LaunchRecord } from "./launch-record.ts";
import { slugifyName } from "./slug.ts";

/** Absolute path to `pi-extension/pmux`. https://github.com/nodejs/node/issues/37845 */
export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

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
  /** The pane the child runs in: it names the surface in the child env. */
  surface: string;
  /** Names the child can reach with `pmux_message` at spawn time. */
  siblingNames: string[];
  parentRosterFile?: string;
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
  surface: string;
  codingAgentDir?: string;
  denySet: Set<string>;
  parentRosterFile?: string;
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
  });
  if (params.codingAgentDir) env.PI_CODING_AGENT_DIR = params.codingAgentDir;
  return env;
}

/**
 * Build the pi launch spec for one run (design D2): the argv, the env, and the
 * prompt files. The `RunningSubagent` is the supervisor's; it needs the
 * per-run surface, start time and entry count that live outside this request.
 */
export function buildPiLaunch(request: PiLaunchRequest): LaunchSpec {
  const { record, run } = request;
  const resume = request.resume;

  const identity = record.rolePrompt ?? null;
  const systemPromptMode = record.systemPromptMode;

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

  const toolAllowlist = buildSubagentToolAllowlist(record.tools);
  if (toolAllowlist) {
    piArgs.push("--tools", toolAllowlist);
  }

  // Env: denied tools + subagent identity + config dir propagation.
  // If the target cwd has its own .pi/agent/, that wins; else propagate the
  // current/global agent dir.
  const codingAgentDir =
    request.localAgentDir && existsSync(request.localAgentDir)
      ? request.localAgentDir
      : process.env.PI_CODING_AGENT_DIR;
  const spawnEnv = buildSpawnEnvParts({
    name: record.name,
    agent: record.agent,
    autoExit: record.autoExit,
    subagentSessionFile: run.sessionFile,
    id: run.id,
    activityFile: run.activityFile,
    surface: request.surface,
    codingAgentDir,
    denySet: new Set(record.denyTools),
    parentRosterFile: request.parentRosterFile,
  });

  if (resume) {
    // The session keeps the spawn task and role. A resume adds only the follow-up
    // message, behind the peers the child can reach at resume time.
    if (resume.message) {
      const promptPath = writeRunContextFile(
        request.artifactDir,
        "pmux-resume",
        slugifyName(record.name, { hyphenate: false }) || "resume",
        `${buildLaunchMessagingHint(request.siblingNames)}\n\n${resume.message}`,
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
      messagingHint: buildLaunchMessagingHint(request.siblingNames),
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
  };
}
