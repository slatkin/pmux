/**
 * Delivery of the tmux-agent-sidebar's update-before-finish reminder.
 *
 * The sidebar's Tasks tab wording is defined exactly once, in that
 * repository's `src/task_reminders.rs`; the constant below is a copy of its
 * `UPDATE_BEFORE_FINISH_REMINDER` (D1), pinned byte-for-byte by the wording
 * test in `test/task-reminders.test.ts` — the two repositories cannot import
 * each other, so the copy carries the source's name and the test fails
 * `pnpm test` when they drift apart.
 *
 * This module only decides when the reminder is injected: at the `turn_end`
 * whose pane's sidebar task store holds open items (D5), after a run that
 * settled `completed`, for a pi session that is not a subagent child (D4).
 * An empty store is silent at every boundary: no
 * `before_agent_start` anchor is registered, because recording tasks is a
 * human-prompted action, not a default tag (D3). The injection is one steer
 * message and never spawns a turn of its own (D6). Per registration there are
 * no timers and no global state beyond the guard, and every failure of the
 * store read or the injection is swallowed (D7): a reminder is never worth a
 * turn's interruption.
 *
 * The store is `/tmp/tmux-agent-tasks<PANE>.json`, the file the sidebar's
 * `task_store.rs` defines; the pane id is encoded the way the sidebar encodes
 * its log and store filenames (`%` becomes `_`). The extension only reads it,
 * once per settled turn, with one synchronous `readFileSync` of a small file
 * — no tmux call, no subprocess, nothing awaited (D2); a missing or unreadable
 * file reads as empty, exactly like the sidebar's own reader.
 */
import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isSubagentChild } from "./child-env.ts";

/**
 * The sidebar's update-before-finish wording, copied byte for byte. Single
 * source: the `UPDATE_BEFORE_FINISH_REMINDER` constant in the
 * tmux-agent-sidebar's `src/task_reminders.rs`; the module header and the
 * wording test carry the drift mechanism (D1).
 */
export const UPDATE_BEFORE_FINISH_REMINDER = "Reminder: make sure the task board is up to date.";

/** Status of one stored task item (`task_store.rs`'s `TaskItemStatus`). */
export type SidebarTaskStatus = "pending" | "in_progress" | "completed";

/** One task item in a pane's sidebar task store (`task_store.rs`'s `TaskItem`). */
export interface SidebarTaskItem {
  id: string;
  subject: string;
  status: SidebarTaskStatus;
}

/**
 * The pane's store path, the path `task_store.rs`'s `store_file_path`
 * builds: the pane id encoded the same way the sidebar encodes its log and
 * store filenames, so pane `%5` names the same file on both sides.
 */
export function sidebarTaskStorePath(pane: string): string {
  return `/tmp/tmux-agent-tasks${pane.replace(/%/g, "_")}.json`;
}

/**
 * Parse a store file's contents — the narrowest reader for the shape
 * `task_store.rs` writes (`tasks: [{ id, subject, status }]`, statuses
 * `pending | in_progress | completed`). Every deviation from that shape — a
 * corrupt file, a missing or non-array `tasks`, an item that is not an object
 * with a string `id`/`subject` and one of the three statuses — is the empty
 * condition, matching the sidebar's `read_tasks`, which reads a corrupt store
 * as empty.
 */
export function parseSidebarTaskStore(raw: string): SidebarTaskItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];
  const items: SidebarTaskItem[] = [];
  for (const task of tasks) {
    if (task === null || typeof task !== "object" || Array.isArray(task)) return [];
    const { id, subject, status } = task as Record<string, unknown>;
    if (typeof id !== "string" || typeof subject !== "string") return [];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    items.push({ id, subject, status });
  }
  return items;
}

/**
 * The store's open items: pending or in progress. A completed item is no
 * longer open, so it never keeps a reminder condition alive.
 */
export function openTasks(items: SidebarTaskItem[]): SidebarTaskItem[] {
  return items.filter((item) => item.status === "pending" || item.status === "in_progress");
}

/** Lexicographic id order, spelled out so the key's stability is explicit. */
function byId(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The store's open set as one stable key: the sorted open ids, JSON-encoded —
 * encoding, not joining, is what keeps `"1,2"` and `["1", "2"]` different
 * keys. The D5 guard compares this key per turn end, so a reminder fires
 * again only after the store's open set changed — the store updates the
 * reminder asks for.
 */
export function openTaskKey(items: SidebarTaskItem[]): string {
  return JSON.stringify(
    openTasks(items)
      .map((item) => item.id)
      .sort(byId),
  );
}

/**
 * Read a store file at a path. A missing, unreadable or malformed file reads
 * as empty, never as an error — exactly like the sidebar's own reader.
 */
export function readSidebarTaskStorePath(path: string): SidebarTaskItem[] {
  try {
    return parseSidebarTaskStore(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Read the pane's sidebar task store (D2). A pane with no store — an empty
 * pane id, a missing or unreadable file — reads as empty.
 */
export function readSidebarTaskStore(pane: string): SidebarTaskItem[] {
  if (!pane) return [];
  return readSidebarTaskStorePath(sidebarTaskStorePath(pane));
}

/** The two things the module is given, so tests drive it without pi: the store reader and the steer send. */
export interface TaskRemindersDeps {
  /**
   * Read one pane's store. Called at most once per settled `turn_end`, and
   * a pane the module has no condition for is never read at all.
   */
  readStore(pane: string): SidebarTaskItem[];
  /**
   * The injection call, bound to the registering pi by the caller. Declared
   * void like the real `sendUserMessage`; a caller whose `sendUserMessage`
   * returns a promise passes it through, so the handler can swallow a
   * rejected promise and a thrown failure the same way.
   */
  send(text: string, options: { deliverAs: "steer" }): void;
}

export function createTaskReminders(
  env: NodeJS.ProcessEnv,
  deps: TaskRemindersDeps,
): {
  register(pi: ExtensionAPI): void;
} {
  // The D5 guard: the open-set key at the last injection. An injection sets
  // it; a later turn end with a changed open set resets it. Nothing else
  // writes it, and it lives only in this closure, like the sidebar events'
  // run-scoped captures — no timers, no global state, so `/reload` safety is
  // unchanged (D7).
  let remindedOpenKey: string | null = null;

  return {
    register(pi: ExtensionAPI): void {
      pi.on("turn_end", (event: TurnEndEvent) => {
        // A subagent child's attention is owned by its parent; its turn ends
        // reach the parent through the exit sidecar and `pmux_done` (D4).
        if (isSubagentChild(env)) return;

        // A settlement that is not `completed` — `error` or `aborted` — ends
        // the run without the steer read; a steer sent for it would only land
        // on the next prompt (the context alert's own skip rule, D5). The
        // boundary's `outcome` carries the verdict, so the skip needs no
        // second stop-reason classifier of its own to keep in step.
        if (event.outcome !== "completed") return;

        // Outside tmux there is no pane and no store; the store read never
        // runs for one (the spec's "no store at all").
        const pane = env.TMUX_PANE;
        if (!pane) return;

        // One synchronous read; a failing reader is the empty condition,
        // never an error (D7).
        let items: SidebarTaskItem[];
        try {
          items = deps.readStore(pane);
        } catch {
          return;
        }

        const openKey = openTaskKey(items);
        // The guard (D5): an identical open set to the last injection means
        // the reminder is already before the agent, so it does not re-fire
        // until the store's open set changes. Every change — including a
        // set that drops to empty — resets the guard.
        if (openKey === remindedOpenKey) return;
        remindedOpenKey = openKey;

        // An open set that is empty is the "empty" condition: silent, with
        // the guard now reset for the next turn start (D3). The JSON key of
        // an empty set is `"[]"`.
        if (openKey === "[]") return;

        // D6: one steer, queued to the turn the agent next runs; no run is
        // started for it. A thrown or rejected send is swallowed (D7).
        try {
          Promise.resolve(deps.send(UPDATE_BEFORE_FINISH_REMINDER, { deliverAs: "steer" })).catch(
            () => {},
          );
        } catch {
          // A broken injection must leave the turn exactly as it would run
          // without the module.
        }
      });
    },
  };
}
