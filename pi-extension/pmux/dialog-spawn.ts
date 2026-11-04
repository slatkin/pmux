/**
 * The spawn dialog (spawn-dialog capability; designs D1 and D6).
 *
 * `spawnDialogOuter` is the outer side: it checks a role the command line
 * named, opens the popup over the caller's pane through `runDialog` and
 * resolves with the outcome the host reports. pi's `/pmux-spawn` runs it
 * in-process with `startInInner` unset and starts the child itself from
 * the collected `{role, brief}`; the Claude Code `pmux-spawn` skill runs
 * `cli.ts spawn-dialog`, which sets it and prints the one result line.
 *
 * `spawnDialogInner` is the inner side: `cli.ts spawn-dialog --inner` runs
 * it in the popup. With no `--role` it lists the same role rows the role
 * editor shows; the brief step writes an empty file under
 * `<scratch>/briefs/` and hands it to `$VISUAL`, `$EDITOR` or `vi`. An
 * all-whitespace brief, an editor failure and an Escape all end in
 * `cancel`. When `--start` is passed (the Claude Code path) the inner
 * side then starts the child itself through the `start` path — `--report
 * send`, `--name` and `--role` the chosen role, `--cwd` the caller's,
 * `--parent` the caller's pane — so the start does not depend on the
 * outer side still running (design D1). The `done` record carries the
 * result line after an inner start, or `{role, brief}` for the host to
 * start.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBundledAgentsDir, listRoles } from "./agent-defs.ts";
import {
  DIALOG_STATE_ENV,
  dialogStatePath,
  markDialogOpen,
  runDialog,
  writeDialogCancel,
  writeDialogDone,
  type DialogOutcome,
  type RunDialogDeps,
} from "./dialog-host.ts";
import { errorMessage, roleRow, type RolesChoose } from "./dialog-roles.ts";
import { chooseFromList, runOnTty } from "./dialog-ui.ts";
import { UnknownRoleError } from "./launch-build.ts";
import { defaultScratchDir } from "./prune.ts";

/** The popup title (`-T`) and the role list's title line. */
export const SPAWN_DIALOG_TITLE = "pmux spawn";

/** The refusal a multi-word `--args` earns on the Claude Code path (design D7). */
export const SPAWN_ARGS_REFUSAL =
  "the pmux-spawn skill takes a role only; write the task in the brief step";

/** The `start` run's captured result, as the inner side reads it. */
export interface SpawnStartResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The `start` path the inner side calls (design D6): it gets the flags
 * after the `start` command name and the environment to run under. The
 * default lives in `cli.ts`, which turns it into `main(["start", ...])`.
 */
export type SpawnStart = (argv: string[], env: NodeJS.ProcessEnv) => Promise<SpawnStartResult>;

/** The editor run on the brief file; `runOnTty`-compatible. */
export type SpawnEditor = (path: string) => { status: number | null; error?: Error };

/**
 * Injected pieces for both sides of the spawn dialog; every default is the
 * real thing. The `RunDialogDeps` fields cover the outer side's wait, the
 * additions cover the inner side's TTY, its editor run and its `start`
 * call.
 */
export interface SpawnDialogDeps extends RunDialogDeps {
  /** The list widget; defaults to `chooseFromList` on the popup's TTY. */
  choose?: RolesChoose;
  /** The brief file's editor run; defaults to `$VISUAL`/`$EDITOR`/`vi` on the TTY. */
  runEditor?: SpawnEditor;
  /** The `start` path; the CLI injects its own `main(["start", ...])`. */
  start?: SpawnStart;
}

/** The unknown-role refusal, worded like `resolveLaunchRecord`'s. */
function unknownRoleError(role: string, cwd: string, agentDir: string): UnknownRoleError {
  const searched = [
    join(cwd, ".pi", "agents", `${role}.md`),
    join(agentDir, "agents", `${role}.md`),
    join(getBundledAgentsDir(), `${role}.md`),
  ];
  return new UnknownRoleError(`unknown role '${role}' (searched: ${searched.join(" ")})`);
}

/** The editor the brief step runs: `$VISUAL`, else `$EDITOR`, else `vi`. */
function briefEditor(env: NodeJS.ProcessEnv): string {
  return env.VISUAL || env.EDITOR || "vi";
}

/** What the inner side gathered: the role, the brief file and its scratch root. */
interface CollectedSpawn {
  role: string;
  briefPath: string;
  scratch: string;
}

/** What the inner command line gives the dialog. */
export interface SpawnInnerArgs {
  /** The caller's cwd: the role list and the child resolve against it. */
  cwd: string;
  /** The resolved agent config directory (`-e PI_CODING_AGENT_DIR`). */
  agentDir: string;
  /** The caller's pane id: the `start` path's `--parent` and `TMUX_PANE`. */
  pane: string;
  /** A role the command already named; the dialog opens at the brief step. */
  role?: string;
  /** The launcher scratch root `briefs/` lives under; defaults to `<tmp>/pmux`. */
  scratch?: string;
  /** The inner side starts the child after the brief (the Claude Code path). */
  start?: boolean;
  /** The popup's environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The role and brief steps. With `args.role` set the dialog opens at the
 * brief step. Returns null on a cancel — an Escape, an editor failure or
 * an all-whitespace brief — and `"no-roles"` when the role list is empty.
 */
async function collectSpawn(
  args: SpawnInnerArgs,
  deps: SpawnDialogDeps,
  env: NodeJS.ProcessEnv,
): Promise<CollectedSpawn | "no-roles" | null> {
  let role = args.role;
  if (role === undefined) {
    const roles = listRoles(args.cwd, args.agentDir);
    if (roles.length === 0) return "no-roles";
    const choose = deps.choose ?? chooseFromList;
    const choice = await choose(roles.map(roleRow), { title: SPAWN_DIALOG_TITLE });
    if (choice === null) return null;
    role = roles[choice.index]!.name;
  }

  const scratch = args.scratch ?? defaultScratchDir();
  const briefsDir = join(scratch, "briefs");
  mkdirSync(briefsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const briefPath = join(briefsDir, `${role}-${stamp}.md`);
  writeFileSync(briefPath, "");

  const runEditor = deps.runEditor ?? ((path: string) => runOnTty(briefEditor(env), [path]));
  // An editor failure is a cancel, like an all-whitespace brief (spec:
  // "Brief step").
  const result = runEditor(briefPath);
  if (result.error !== undefined || result.status !== 0) return null;
  if (readFileSync(briefPath, "utf8").trim().length === 0) return null;
  return { role, briefPath, scratch };
}

/** The child pane id from the `start` command's stdout JSON. */
function startedPane(stdout: string): string | undefined {
  try {
    const data: unknown = JSON.parse(stdout);
    const pane = (data as { pane?: unknown }).pane;
    return typeof pane === "string" && pane.length > 0 ? pane : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Claude Code start (design D6): the `start` path in send mode, with
 * the role as name and role, the caller's cwd and brief file, and the
 * caller's pane as `--parent`. The env is the popup's with `TMUX_PANE` set
 * to the `--pane` value — `start` reads the caller pane from it for the
 * placement and the parent session id; the popup's own `TMUX_PANE` is
 * never used. Returns the result line for the `done` record.
 */
async function startInPopup(
  args: SpawnInnerArgs,
  collected: CollectedSpawn,
  deps: SpawnDialogDeps,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const start = deps.start;
  if (start === undefined) return "spawn failed: no start path configured";
  try {
    const result = await start(
      [
        "--report",
        "send",
        "--name",
        collected.role,
        "--role",
        collected.role,
        "--cwd",
        args.cwd,
        "--brief",
        collected.briefPath,
        "--parent",
        args.pane,
        "--scratch",
        collected.scratch,
      ],
      { ...env, TMUX_PANE: args.pane },
    );
    if (result.code === 0) {
      const pane = startedPane(result.stdout);
      return pane === undefined
        ? `started ${collected.role}`
        : `started ${collected.role} in ${pane}`;
    }
    const detail = result.stderr.trim();
    return `spawn failed: ${detail || `the start exited ${result.code}`}`;
  } catch (error) {
    return `spawn failed: ${errorMessage(error)}`;
  }
}

/**
 * Run the spawn dialog inside the popup: write `open`, collect the role
 * and the brief, and write `done` or `cancel`. Throws when the state-file
 * env is missing — the outer side's `open` deadline treats a thrown inner
 * as a failed popup. A failure after `open` becomes a `done` record whose
 * line carries the error, so the user sees it instead of a silent cancel.
 */
export async function spawnDialogInner(
  args: SpawnInnerArgs,
  deps: SpawnDialogDeps = {},
): Promise<void> {
  const env = args.env ?? process.env;
  const statePath = dialogStatePath(env);
  if (statePath === null) {
    throw new Error(`the inner dialog needs ${DIALOG_STATE_ENV} in its environment`);
  }
  markDialogOpen(statePath);

  let collected: CollectedSpawn | "no-roles" | null;
  try {
    collected = await collectSpawn(args, deps, env);
  } catch (error) {
    writeDialogDone(statePath, { line: `spawn failed: ${errorMessage(error)}` });
    return;
  }
  if (collected === null) {
    writeDialogCancel(statePath);
    return;
  }
  if (collected === "no-roles") {
    writeDialogDone(statePath, { line: "no roles found" });
    return;
  }
  // Without `--start` the host starts the child from the collected values.
  if (args.start !== true) {
    writeDialogDone(statePath, { role: collected.role, brief: collected.briefPath });
    return;
  }
  const line = await startInPopup(args, collected, deps, env);
  writeDialogDone(statePath, { line });
}

/** What a host command gives the outer side. */
export interface SpawnOuterArgs {
  /** The caller's cwd: the popup's start directory and the roles' project root. */
  cwd: string;
  /** The resolved agent config directory, passed to the popup env. */
  agentDir: string;
  /** The caller's environment (holds `TMUX`, `TMUX_PANE`, `PATH`, `VISUAL`…). */
  env: NodeJS.ProcessEnv;
  /** A role the command named; the dialog opens at the brief step for it. */
  role?: string;
  /** The inner side starts the child (the Claude Code path); unset collects only (pi). */
  startInInner?: boolean;
  /** The Claude Code path's wait limit; unset waits with no limit (pi). */
  stopAfterMs?: number;
}

/**
 * Open the spawn dialog in a popup over the caller's pane and resolve with
 * its outcome: a `done` whose result is the inner start's line (Claude
 * Code) or the collected `{role, brief}` (pi), a `cancel`, or `still-open`
 * after `stopAfterMs`. A named role that resolves to no role is refused
 * with the existing unknown-role message before any popup opens, and
 * nothing starts.
 */
export async function spawnDialogOuter(
  args: SpawnOuterArgs,
  deps: RunDialogDeps = {},
): Promise<DialogOutcome> {
  if (args.role !== undefined) {
    const known = listRoles(args.cwd, args.agentDir).some((role) => role.name === args.role);
    if (!known) throw unknownRoleError(args.role, args.cwd, args.agentDir);
  }
  const innerArgs = [
    "spawn-dialog",
    "--inner",
    "--cwd",
    args.cwd,
    "--agent-dir",
    args.agentDir,
    "--pane",
    args.env.TMUX_PANE ?? "",
  ];
  if (args.role !== undefined) innerArgs.push("--role", args.role);
  if (args.startInInner === true) innerArgs.push("--start");
  return runDialog(
    {
      title: SPAWN_DIALOG_TITLE,
      innerArgs,
      cwd: args.cwd,
      agentDir: args.agentDir,
      env: args.env,
      ...(args.stopAfterMs !== undefined ? { stopAfterMs: args.stopAfterMs } : {}),
    },
    deps,
  );
}

/** What the host's start call returns; `supervisor.spawn`'s `RunningSubagent` fits. */
export interface SpawnedChild {
  name: string;
  surface: string;
}

/**
 * The pi side's start: `/pmux-spawn` wires it to `supervisor.spawn` with
 * the handler's ctx and the configured surface fallback — the same call
 * `pmux_spawn` makes (design D6).
 */
export type PiSpawnStart = (params: {
  name: string;
  task: string;
  agent: string;
}) => Promise<SpawnedChild>;

/** The pieces `/pmux-spawn` injects; `outer` defaults to the real dialog. */
export interface PiSpawnDeps {
  /** The child start; the host wires `supervisor.spawn`. */
  spawn: PiSpawnStart;
  /** The dialog outer side; defaults to `spawnDialogOuter` (collect only, no limit). */
  outer?: (args: SpawnOuterArgs) => Promise<DialogOutcome>;
}

/** The display name a role earns, as the old `/pmux-spawn` made it. */
function spawnDisplayName(role: string): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

/**
 * pi's `/pmux-spawn` (designs D6 and D9). With `<role> <task>` it starts
 * the child at once and opens no popup; otherwise it opens the spawn
 * dialog — the role list with no role, the brief step with one — and
 * starts the child from the collected `{role, brief}`. Returns the one
 * result line for `ctx.ui.notify`: "started <name> in <pane>", "nothing
 * started", or the inner side's own line ("no roles found", "spawn
 * failed: …"). An unknown role throws `UnknownRoleError` — the outer
 * side's refusal before any popup for a role alone, the supervisor's for
 * a role with a task. The command sends the agent no message.
 */
export async function piSpawnCommand(
  argsText: string,
  host: { cwd: string; agentDir: string; env: NodeJS.ProcessEnv },
  deps: PiSpawnDeps,
): Promise<string> {
  const trimmed = argsText.trim();
  const space = trimmed.indexOf(" ");
  const role = space === -1 ? trimmed : trimmed.slice(0, space);
  const task = space === -1 ? "" : trimmed.slice(space + 1).trim();

  // A role and a task start at once: the `pmux_spawn` path, no popup.
  if (role !== "" && task !== "") {
    const running = await deps.spawn({ name: spawnDisplayName(role), task, agent: role });
    return `started ${running.name} in ${running.surface}`;
  }

  // pi collects in the popup and starts the child itself: no `--start`, no
  // wait limit (design D6).
  const outer = deps.outer ?? spawnDialogOuter;
  const outcome = await outer({
    cwd: host.cwd,
    agentDir: host.agentDir,
    env: host.env,
    ...(role !== "" ? { role } : {}),
  });
  if (outcome.kind === "cancel") return "nothing started";
  if (outcome.kind === "still-open") return outcome.line;
  // A `line` record is the inner side's own answer (a failure or an empty
  // role list); a `{role, brief}` record is the host's start.
  const result = outcome.result;
  if (typeof result.line === "string" && result.line.length > 0) return result.line;
  const collectedRole = result.role;
  const brief = result.brief;
  if (typeof collectedRole !== "string" || typeof brief !== "string") {
    throw new Error("the dialog's done record holds no role or brief");
  }
  const running = await deps.spawn({
    name: spawnDisplayName(collectedRole),
    task: readFileSync(brief, "utf8"),
    agent: collectedRole,
  });
  return `started ${running.name} in ${running.surface}`;
}
