/**
 * The role editor dialog (role-editor capability; designs D1, D4 and D5).
 *
 * `rolesDialogOuter` is the outer side: it opens the popup over the caller's
 * pane through `runDialog` and returns the one result line the host prints —
 * the pi `/pmux-roles` handler shows it through `ctx.ui.notify`, the Claude
 * Code `pmux-roles` skill prints it on stdout.
 *
 * `rolesDialogInner` is the inner side: `cli.ts roles --inner` runs it in the
 * popup. It lists the roles `listRoles` resolves for the caller's cwd, then
 * the key choice (`model`, `model-fallback`, `thinking`), then the value
 * list — the `provider/model` pairs `pi --list-models` prints for the model
 * keys, the fixed thinking levels for `thinking`, and a remove choice on
 * each. For a built-in role the value step's confirm line announces that the
 * edit creates a user copy, before the first write. The outcome goes to the
 * state file: `done` with the result line, or `cancel`.
 *
 * The model list is fetched once per dialog; when `pi --list-models` fails
 * the dialog shows its error on the list footers and the model keys are not
 * editable.
 */
import { join } from "node:path";
import { listModels, listRoles, writeRoleKey, type RoleInfo } from "./agent-defs.ts";
import {
  dialogStatePath,
  markDialogOpen,
  runDialog,
  writeDialogCancel,
  writeDialogDone,
  DIALOG_STATE_ENV,
  type RunDialogDeps,
} from "./dialog-host.ts";
import { chooseFromList, type ListChoice, type ListDialogOptions } from "./dialog-ui.ts";

/** The popup title (`-T`) and each list's title line. */
export const ROLES_DIALOG_TITLE = "pmux roles";

/** The thinking values the spec fixes (`pi --help`'s list). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Every key the editor may change. */
const ROLE_KEYS = ["model", "model-fallback", "thinking"] as const;

/** The keys whose values `pi --list-models` supplies. */
const MODEL_KEYS: ReadonlySet<string> = new Set(["model", "model-fallback"]);

/** The value-list row that deletes the key. */
const REMOVE_CHOICE = "(remove)";

/** The mark a row shows when a frontmatter value is absent. */
const ABSENT_MARK = "—";

/** The list-widget shape the inner side reads keys through. */
export type RolesChoose = (
  items: readonly string[],
  options?: ListDialogOptions,
) => Promise<ListChoice | null>;

/**
 * Injected pieces for both sides of the roles dialog; every default is the
 * real thing. The `RunDialogDeps` fields cover the outer side's wait, the
 * two additions cover the inner side's TTY and `pi --list-models` call.
 */
export interface RolesDialogDeps extends RunDialogDeps {
  /** The list widget; defaults to `chooseFromList` on the popup's TTY. */
  choose?: RolesChoose;
  /** The model list; defaults to `pi --list-models` through `resolvePiCommand`. */
  listModels?: () => string[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One row of the role list: name, source and the three editable values.
 * The spawn dialog's role step shows the same rows (spec: "Role step").
 */
export function roleRow(role: RoleInfo): string {
  const mark = (value: string | undefined): string => value ?? ABSENT_MARK;
  return `${role.name}  [${role.source}]  model: ${mark(role.model)}  model-fallback: ${mark(role.modelFallback)}  thinking: ${mark(role.thinking)}`;
}

/**
 * The inner side's list sequence. Returns the result line for the `done`
 * record, or null when the user cancelled. `models` is null (with
 * `modelsError` set) when `pi --list-models` failed: the error rides the
 * list footers and the model keys leave the key list.
 */
async function collectRoleEdit(
  args: { cwd: string; agentDir: string },
  choose: RolesChoose,
  models: string[] | null,
  modelsError: string | null,
): Promise<string | null> {
  const roles = listRoles(args.cwd, args.agentDir);
  if (roles.length === 0) return "no roles found";

  const roleChoice = await choose(roles.map(roleRow), {
    title: ROLES_DIALOG_TITLE,
    ...(modelsError !== null ? { footer: modelsError } : {}),
  });
  if (roleChoice === null) return null;
  const role = roles[roleChoice.index]!;

  const keys = ROLE_KEYS.filter((key) => models !== null || !MODEL_KEYS.has(key));
  const keyChoice = await choose([...keys], {
    title: `${role.name}: choose a key`,
    ...(modelsError !== null ? { footer: modelsError } : {}),
  });
  if (keyChoice === null) return null;
  const key = keyChoice.item;

  const base = key === "thinking" ? [...THINKING_LEVELS] : (models ?? []);
  // A built-in role's first write copies the package file to the user's
  // agents directory (design D4): the confirm line says so before Enter.
  const valueChoice = await choose([...base, REMOVE_CHOICE], {
    title: `${role.name}: ${key}`,
    footer:
      role.source === "built-in"
        ? `edits create a user copy: ${join(args.agentDir, "agents", `${role.name}.md`)}`
        : (modelsError ?? undefined),
  });
  if (valueChoice === null) return null;

  const value = valueChoice.item === REMOVE_CHOICE ? null : valueChoice.item;
  const target = writeRoleKey(role, key, value, { agentDir: args.agentDir });
  return value === null
    ? `${role.name}: removed ${key} (${target})`
    : `${role.name}: ${key} = ${value} (${target})`;
}

/** What the inner command line gives the dialog. */
export interface RolesInnerArgs {
  /** The caller's cwd: the role list resolves against its `.pi/agents/`. */
  cwd: string;
  /** The resolved agent config directory (`-e PI_CODING_AGENT_DIR`). */
  agentDir: string;
  /** The caller's pane id; the roles dialog does not use it (the spawn dialog does). */
  pane?: string;
  /** The popup's environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the role editor inside the popup: write `open`, run the lists, write
 * `done` (the result line) or `cancel`. Throws when the state-file env is
 * missing — the outer side's `open` deadline treats a thrown inner as a
 * failed popup. A failure after `open` becomes a `done` record whose line
 * carries the error, so the user sees it instead of a silent cancel.
 */
export async function rolesDialogInner(
  args: RolesInnerArgs,
  deps: RolesDialogDeps = {},
): Promise<void> {
  const env = args.env ?? process.env;
  const statePath = dialogStatePath(env);
  if (statePath === null) {
    throw new Error(`the inner dialog needs ${DIALOG_STATE_ENV} in its environment`);
  }
  markDialogOpen(statePath);

  const choose = deps.choose ?? chooseFromList;
  let models: string[] | null;
  let modelsError: string | null = null;
  try {
    models = (deps.listModels ?? (() => listModels({ env })))();
  } catch (error) {
    models = null;
    modelsError = errorMessage(error);
  }

  let line: string | null;
  try {
    line = await collectRoleEdit(args, choose, models, modelsError);
  } catch (error) {
    writeDialogDone(statePath, { line: `role edit failed: ${errorMessage(error)}` });
    return;
  }
  if (line === null) writeDialogCancel(statePath);
  else writeDialogDone(statePath, { line });
}

/** What a host command gives the outer side. */
export interface RolesOuterArgs {
  /** The caller's cwd: the popup's start directory and the roles' project root. */
  cwd: string;
  /** The resolved agent config directory, passed to the popup env. */
  agentDir: string;
  /** The caller's environment (holds `TMUX`, `TMUX_PANE`, `PATH`, `VISUAL`…). */
  env: NodeJS.ProcessEnv;
  /** The Claude Code path's wait limit; unset waits with no limit (pi). */
  stopAfterMs?: number;
}

/**
 * Open the role editor in a popup over the caller's pane and return the
 * result line to report: the inner side's line on `done`, a cancelled line
 * on `cancel`, or the still-open line after `stopAfterMs`. Throws when no
 * popup can open (outside tmux, a `display-popup` error, no `open` state).
 */
export async function rolesDialogOuter(
  args: RolesOuterArgs,
  deps: RunDialogDeps = {},
): Promise<string> {
  const outcome = await runDialog(
    {
      title: ROLES_DIALOG_TITLE,
      innerArgs: [
        "roles",
        "--inner",
        "--cwd",
        args.cwd,
        "--agent-dir",
        args.agentDir,
        "--pane",
        args.env.TMUX_PANE ?? "",
      ],
      cwd: args.cwd,
      agentDir: args.agentDir,
      env: args.env,
      ...(args.stopAfterMs !== undefined ? { stopAfterMs: args.stopAfterMs } : {}),
    },
    deps,
  );
  if (outcome.kind === "done") {
    const line = outcome.result.line;
    return typeof line === "string" && line.length > 0 ? line : "done";
  }
  if (outcome.kind === "cancel") return "role editor closed; no role file changed";
  return outcome.line;
}
