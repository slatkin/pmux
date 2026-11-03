/**
 * The spawn dialog (spawn-dialog capability; designs D1 and D6).
 *
 * `spawnDialogOuter` is the outer side: it checks a role the command line
 * named, opens the popup over the caller's pane through `runDialog` and
 * resolves with the outcome the host reports.
 *
 * `spawnDialogInner` is the inner side: `cli.ts spawn-dialog --inner` runs
 * it in the popup. With no `--role` it lists the same role rows the role
 * editor shows; the brief step writes an empty file under
 * `<scratch>/briefs/` and hands it to `$VISUAL`, `$EDITOR` or `vi`. An
 * all-whitespace brief, an editor failure and an Escape all end in
 * `cancel`. The `done` record carries the collected `{role, brief}` for
 * the host to start the child.
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

/** The editor run on the brief file; `runOnTty`-compatible. */
export type SpawnEditor = (path: string) => { status: number | null; error?: Error };

/**
 * Injected pieces for both sides of the spawn dialog; every default is the
 * real thing. The `RunDialogDeps` fields cover the outer side's wait, the
 * additions cover the inner side's TTY and its editor run.
 */
export interface SpawnDialogDeps extends RunDialogDeps {
  /** The list widget; defaults to `chooseFromList` on the popup's TTY. */
  choose?: RolesChoose;
  /** The brief file's editor run; defaults to `$VISUAL`/`$EDITOR`/`vi` on the TTY. */
  runEditor?: SpawnEditor;
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
  /** The caller's pane id. */
  pane: string;
  /** A role the command already named; the dialog opens at the brief step. */
  role?: string;
  /** The launcher scratch root `briefs/` lives under; defaults to `<tmp>/pmux`. */
  scratch?: string;
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
  // The host starts the child from the collected values.
  writeDialogDone(statePath, { role: collected.role, brief: collected.briefPath });
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
  /** The Claude Code path's wait limit; unset waits with no limit (pi). */
  stopAfterMs?: number;
}

/**
 * Open the spawn dialog in a popup over the caller's pane and resolve with
 * its outcome: a `done` whose result is the collected `{role, brief}`, a
 * `cancel`, or `still-open` after `stopAfterMs`. A named role that
 * resolves to no role is refused with the existing unknown-role message
 * before any popup opens, and nothing starts.
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
