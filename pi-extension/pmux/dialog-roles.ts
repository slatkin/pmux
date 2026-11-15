/**
 * The role editor dialog (role-editor capability; designs D1, D2, D5 and D6).
 *
 * `rolesDialogOuter` is the outer side: it opens the popup over the caller's
 * pane through `runDialog` and returns the one result line the host prints —
 * the pi `/pmux-roles` handler shows it through `ctx.ui.notify`, the Claude
 * Code `pmux-roles` skill prints it on stdout.
 *
 * `rolesDialogInner` is the inner side: `cli.ts roles --inner` runs it in the
 * popup. It reads `enabledModels` and the model list once, then runs an
 * editor loop over three screens: the role list, the role panel and the
 * model picker. The panel stages `model`, `model-fallback` and `thinking`
 * edits for one role; `s` writes them in one atomic save and `s`/Escape
 * return to the role list, which stays open for the next role. Escape in the
 * role list ends the open. The outcome goes to the state file: `done` with
 * every save line, or `cancel` when the open saved nothing. Each save is
 * recorded in the `open` record's `progress`, so a killed popup still
 * reports the saves it made.
 */
import { join } from "node:path";
import {
  enabledScope,
  listModels,
  listRoles,
  readEnabledModels,
  writeRoleKeys,
  ROLE_KEYS,
  THINKING_LEVELS,
  type RoleChanges,
  type RoleInfo,
  type RoleKey,
} from "./agent-defs.ts";
import {
  dialogStatePath,
  markDialogOpen,
  markDialogProgress,
  runDialog,
  writeDialogCancel,
  writeDialogDone,
  DIALOG_STATE_ENV,
  type RunDialogDeps,
} from "./dialog-host.ts";
import {
  chooseFromList,
  chooseFromPanel,
  chooseFromPicker,
  initPanelState,
  initPickerState,
  panelChanges,
  stagePanelValue,
  ABSENT_MARK,
  type ListChoice,
  type ListDialogOptions,
  type PanelDialogOptions,
  type PanelState,
  type PickerDialogOptions,
  type PickerState,
} from "./dialog-ui.ts";

/** The popup title (`-T`) and each list's title line. */
export const ROLES_DIALOG_TITLE = "pmux roles";

export { THINKING_LEVELS };

/** The value-list row that deletes the key (kept for the size hint). */
const REMOVE_CHOICE = "(remove)";

/** The list-widget shape the inner side reads the role list through. */
export type RolesChoose = (
  items: readonly string[],
  options?: ListDialogOptions,
) => Promise<ListChoice | null>;

/** The role panel screen, as the tests inject it. */
export type RolesPanel = (state: PanelState, options?: PanelDialogOptions) => Promise<PanelState>;

/** The model picker screen, as the tests inject it. */
export type RolesPick = (state: PickerState, options?: PickerDialogOptions) => Promise<PickerState>;

/**
 * Injected pieces for both sides of the roles dialog; every default is the
 * real thing. The `RunDialogDeps` fields cover the outer side's wait, the
 * `choose`/`panel`/`pick` fields the inner side's three screens, and
 * `listModels` the `pi --list-models` call.
 */
export interface RolesDialogDeps extends RunDialogDeps {
  /** The list widget; defaults to `chooseFromList` on the popup's TTY. */
  choose?: RolesChoose;
  /** The role panel; defaults to `chooseFromPanel` on the popup's TTY. */
  panel?: RolesPanel;
  /** The model picker; defaults to `chooseFromPicker` on the popup's TTY. */
  pick?: RolesPick;
  /** The model list; defaults to `pi --list-models` through `resolvePiCommand`. */
  listModels?: () => string[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One row of the role list, divided onto two lines: the identity (name and
 * source) on the first, the three editable values on the second. The spawn
 * dialog's role step shows the same rows (spec: "Role step").
 */
export function roleRow(role: RoleInfo): string {
  const mark = (value: string | undefined): string => value ?? ABSENT_MARK;
  return `${role.name}  [${role.source}]\n  model: ${mark(role.model)}  model-fallback: ${mark(role.modelFallback)}  thinking: ${mark(role.thinking)}`;
}

/**
 * The size hints the role editor's outer side computes from the content it
 * knows: the width covers the title, the role rows' divided lines and the
 * fixed choices (the keys, the thinking levels, the remove choice); the
 * height covers the role list plus the list chrome. The model id lists and
 * the footer lines are unknown here and wrap inside the popup instead.
 */
export function rolesSizeHints(cwd: string, agentDir: string): { width: number; height: number } {
  const rows = listRoles(cwd, agentDir).map(roleRow);
  const lines = rows.flatMap((row) => row.split("\n"));
  const fixed = [ROLES_DIALOG_TITLE, ...ROLE_KEYS, ...THINKING_LEVELS, REMOVE_CHOICE];
  const width = Math.max(...fixed.map((line) => line.length), ...lines.map((line) => line.length));
  return { width, height: 2 + lines.length };
}

/**
 * One save's line (design D6): the role, each changed key with its new value
 * or its removal in the fixed key order, and the file written.
 */
function saveLine(role: string, changes: RoleChanges, target: string): string {
  const parts: string[] = [];
  for (const key of ROLE_KEYS) {
    if (!(key in changes)) continue;
    const value = changes[key] ?? null;
    parts.push(value === null ? `removed ${key}` : `${key} = ${value}`);
  }
  return `${role}: ${parts.join(", ")} (${target})`;
}

/** What the editor loop reads besides the screens. */
interface EditorContext {
  cwd: string;
  agentDir: string;
  statePath: string;
  /** The `provider/model` list, or null when `pi --list-models` failed. */
  models: string[] | null;
  modelsError: string | null;
  /** The models `enabledModels` selects, in its order. */
  enabled: string[];
  choose: RolesChoose;
  panel: RolesPanel;
  pick: RolesPick;
}

/**
 * Run the editor loop (design D2): the role list, then the role panel, then
 * the model picker and back. A save writes the staged changes in one
 * `writeRoleKeys` call and records its line as progress; a discard returns
 * to the role list with nothing written. The role list is re-read after
 * every save, so the new values and a `user` copy show at once. Resolves
 * with the done line, or null when the open saved nothing.
 */
async function collectRoleEdits(context: EditorContext): Promise<string | null> {
  const { cwd, agentDir, statePath, models, modelsError, enabled } = context;
  const saved: string[] = [];
  const doneLine = (): string | null => (saved.length > 0 ? saved.join("; ") : null);
  // The model list's error rides the role list's footer, as it always has.
  const roleListOptions: ListDialogOptions = {
    title: ROLES_DIALOG_TITLE,
    ...(modelsError !== null ? { footer: modelsError } : {}),
  };

  for (;;) {
    const roles = listRoles(cwd, agentDir);
    if (roles.length === 0) return saved.length > 0 ? saved.join("; ") : "no roles found";
    const roleChoice = await context.choose(roles.map(roleRow), roleListOptions);
    if (roleChoice === null) return doneLine();
    const role = roles[roleChoice.index]!;

    // A built-in role's first save creates the user copy: the panel says so
    // before the save (spec: "Copy notice before the save").
    const copyPath =
      role.source === "built-in" ? join(agentDir, "agents", `${role.name}.md`) : undefined;
    const panelOptions: PanelDialogOptions = {
      ...(copyPath !== undefined ? { copyPath } : {}),
      ...(modelsError !== null ? { modelsError } : {}),
    };
    let panel = initPanelState({
      role: role.name,
      source: role.source,
      values: role,
      hasModels: models !== null,
    });

    for (;;) {
      const shown = await context.panel(panel, panelOptions);
      if (shown.outcome.type === "discard") break;
      if (shown.outcome.type === "pick") {
        const key: RoleKey = shown.outcome.key;
        const staged = shown.rows.find((row) => row.key === key)?.staged ?? null;
        const picked = await context.pick(
          initPickerState(enabled, models ?? [], staged ?? undefined),
          { title: `${role.name}: ${key}` },
        );
        // Escape in the picker returns to the panel with the row unchanged.
        panel = stagePanelValue(
          shown,
          key,
          picked.list.outcome.type === "chosen" ? picked.list.outcome.item : staged,
        );
        continue;
      }
      // A save with nothing staged writes no file and returns to the list.
      const changes = panelChanges(shown);
      if (Object.keys(changes).length === 0) break;
      const target = writeRoleKeys(role, changes, { agentDir });
      saved.push(saveLine(role.name, changes, target));
      markDialogProgress(statePath, saved);
      break;
    }
  }
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
 * Run the role editor inside the popup: write `open`, run the loop, write
 * `done` (every save line) or `cancel`. Throws when the state-file env is
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

  let models: string[] | null;
  let modelsError: string | null = null;
  try {
    models = (deps.listModels ?? (() => listModels({ env })))();
  } catch (error) {
    models = null;
    modelsError = errorMessage(error);
  }
  // The setting and the scope are read once per open: `pi --list-models`
  // and the settings files do not change while the panel is up.
  const enabled = enabledScope(readEnabledModels(args.cwd, args.agentDir) ?? [], models ?? []);

  let line: string | null;
  try {
    line = await collectRoleEdits({
      cwd: args.cwd,
      agentDir: args.agentDir,
      statePath,
      models,
      modelsError,
      enabled,
      choose: deps.choose ?? chooseFromList,
      panel: deps.panel ?? chooseFromPanel,
      pick: deps.pick ?? chooseFromPicker,
    });
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
 * result line to report: the inner side's line on `done`, the recorded save
 * lines (or the cancelled line) on `cancel`, or the still-open line after
 * `stopAfterMs`. Throws when no popup can open (outside tmux, a
 * `display-popup` error, no `open` state).
 */
export async function rolesDialogOuter(
  args: RolesOuterArgs,
  deps: RunDialogDeps = {},
): Promise<string> {
  const { width, height } = rolesSizeHints(args.cwd, args.agentDir);
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
      width,
      height,
      ...(args.stopAfterMs !== undefined ? { stopAfterMs: args.stopAfterMs } : {}),
    },
    deps,
  );
  if (outcome.kind === "done") {
    const line = outcome.result.line;
    return typeof line === "string" && line.length > 0 ? line : "done";
  }
  if (outcome.kind === "cancel") {
    // A killed popup still reports the saves it made (design D5).
    return outcome.progress !== undefined && outcome.progress.length > 0
      ? outcome.progress.join("; ")
      : "role editor closed; no role file changed";
  }
  return outcome.line;
}
