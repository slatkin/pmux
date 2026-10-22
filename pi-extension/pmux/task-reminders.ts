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
 * settled `completed`, for a pi session that is not a subagent child (D4),
 * and past its buffer — the buffer-task-reminders change. The buffer keeps
 * the reminder off while the agent is actively maintaining the list, and
 * for a short while after: the sidebar rewrites the store file on every
 * successful `task-set` and `task-update`, so the file's mtime is the
 * moment the agent last touched the list, and the reminder stays silent
 * until the file has been untouched for five minutes and three turn ends
 * have passed since that write. An injection restarts both clocks. The
 * open-set guard rides on top of the buffer: the buffer stops the
 * rapid-fire during active maintenance, the guard stops identical repeats
 * once it has expired. Decision numbers in parentheses cite the archived
 * 2026-10-22-sidebar-task-reminders design; the buffer's own decisions are
 * named in prose, since that design's D1–D7 mean other things. An empty
 * store is silent at every boundary: no
 * `before_agent_start` anchor is registered, because recording tasks is a
 * human-prompted action, not a default tag (D3). The injection is one steer
 * message and never spawns a turn of its own (D6). Per registration there are
 * no timers and no global state beyond the guard and the buffer's three
 * closure values, and every failure of the store read or the injection is
 * swallowed (D7): a reminder is never worth a turn's interruption.
 *
 * The store is `/tmp/tmux-agent-tasks<PANE>.json`, the file the sidebar's
 * `task_store.rs` defines; the pane id is encoded the way the sidebar encodes
 * its log and store filenames (`%` becomes `_`). The extension only reads it:
 * one synchronous `readFileSync` of the small file at each settled turn end,
 * plus one synchronous `statSync` of the same path per turn end for the
 * buffer — no tmux call, no subprocess, nothing awaited (D2); a missing or
 * unreadable file reads as empty, exactly like the sidebar's own reader.
 */
import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { isSubagentChild } from "./child-env.ts";

/**
 * The sidebar's update-before-finish wording, copied byte for byte. Single
 * source: the `UPDATE_BEFORE_FINISH_REMINDER` constant in the
 * tmux-agent-sidebar's `src/task_reminders.rs`; the module header and the
 * wording test carry the drift mechanism (D1).
 */
export const UPDATE_BEFORE_FINISH_REMINDER = "Reminder: make sure the task board is up to date.";

/**
 * The buffer's quiet period (the buffer-task-reminders design's D1): how
 * long the store file must have been untouched before the reminder may
 * fire. The sidebar's `task_store.rs` rewrites the store on every
 * successful `task-set` and `task-update` — a no-op update does not
 * rewrite — so the file's mtime is the moment the agent last touched the
 * list. Five minutes covers a burst of planning turns and still nudges a
 * list that has been abandoned.
 */
export const QUIET_PERIOD_MS = 5 * 60_000;

/**
 * The buffer's turn count (the buffer-task-reminders design's D2): how many
 * turn ends must pass since the store's last write before the reminder may
 * fire. Wall-clock quiet alone misleads both on a burst of short turns,
 * which stays inside the quiet period too long rather than firing, and on
 * the single long turn that outlasts it; the count catches those cases.
 */
export const MIN_TURNS_SINCE_WRITE = 3;

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
 * Read the pane's store file (D2). A pane with no store — an empty
 * pane id, a missing or unreadable file — reads as empty.
 */
export function readSidebarTaskStore(pane: string): SidebarTaskItem[] {
  if (!pane) return [];
  return readSidebarTaskStorePath(sidebarTaskStorePath(pane));
}

/**
 * The pane's store file's modification time in epoch milliseconds, or null
 * when it cannot be statted — a missing store above all, which is the
 * normal case. One synchronous `statSync` of the same path the reader uses;
 * nothing awaited. The buffer takes its quiet period and its turn count
 * from this signal: the sidebar rewrites the file on every successful
 * `task-set` and `task-update`, so a changed mtime is the observable "the
 * store was rewritten" event, and the mtime itself anchors the quiet
 * period — the file is rewritten, not appended, so the mtime moves on
 * every write.
 */
export function readSidebarTaskStoreMtime(pane: string): number | null {
  if (!pane) return null;
  try {
    return statSync(sidebarTaskStorePath(pane)).mtimeMs;
  } catch {
    return null;
  }
}

/** The store reader, the store stat and the steer send, so tests drive it without pi. */
export interface TaskRemindersDeps {
  /**
   * Read one pane's store. Called at most once per completed settled
   * `turn_end`, and a pane the module has no condition for is never read
   * at all.
   */
  readStore(pane: string): SidebarTaskItem[];
  /**
   * The pane's store file's mtime in epoch ms, or null when the file cannot
   * be statted. Called for every turn end the module observes, including
   * ones that settle in error or were aborted — they are still turn ends
   * for the buffer's count, and a store rewritten during such a turn is
   * anchored by its mtime — which is why this runs before the settlement
   * filter and the contents are not read for those turns.
   */
  readStoreMtime(pane: string): number | null;
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

  // The buffer's state, in this closure next to the guard — no timers, no
  // global state, so `/reload` safety is unchanged (D7). Three values: the
  // anchor the quiet period counts from (the store's last write as the
  // module observed it, or the last injection, which restarts the clock),
  // the turn ends observed since that anchor, and the mtime the stat last
  // returned, a changed mtime being the observable write event. `0` as the
  // anchor means never written.
  let lastStoreWriteMs = 0;
  let turnsSinceWrite = 0;
  let seenMtimeMs: number | null = null;

  return {
    register(pi: ExtensionAPI): void {
      pi.on("turn_end", (event: TurnEndEvent) => {
        // A subagent child's attention is owned by its parent; its turn ends
        // reach the parent through the exit sidecar and `pmux_done` (D4).
        if (isSubagentChild(env)) return;

        // Outside tmux there is no pane and no store; the store read never
        // runs for one (the spec's "no store at all").
        const pane = env.TMUX_PANE;
        if (!pane) return;

        // The buffer's bookkeeping runs before the settlement filter: a
        // turn that ends in error or was aborted is still a turn end for
        // the count, and a store rewritten during such a turn is anchored
        // by its mtime here instead of being discovered a turn late.
        const mtimeMs = deps.readStoreMtime(pane);
        if (mtimeMs !== null && mtimeMs !== seenMtimeMs) {
          // The store was rewritten since the last observed turn end: the
          // agent touched the list, so both buffer clocks restart. (The
          // anchor moves to the write's own moment, the mtime. An injection
          // also restarts both clocks, at its own point in time.)
          lastStoreWriteMs = mtimeMs;
          turnsSinceWrite = 0;
        }
        seenMtimeMs = mtimeMs;
        turnsSinceWrite += 1;

        // A settlement that is not `completed` — `error` or `aborted` — ends
        // the run without the steer read; a steer sent for it would only land
        // on the next prompt (the context alert's own skip rule, D5). The
        // boundary's `outcome` carries the verdict, so the skip needs no
        // second stop-reason classifier of its own to keep in step.
        if (event.outcome !== "completed") return;

        // One synchronous read; a failing reader is the empty condition,
        // never an error (D7).
        let items: SidebarTaskItem[];
        try {
          items = deps.readStore(pane);
        } catch {
          return;
        }

        const openKey = openTaskKey(items);

        // The buffer, quiet period first, then the turn count, both
        // required (the buffer-task-reminders design's D3): the mtime check
        // is cheap and is enough in the common case, the count catches the
        // turns where wall-clock time misleads. A turn end the buffer holds
        // out returns here without re-arming the guard below, so an open
        // set that changed under the buffer still fires for it at expiry —
        // arming from a buffered turn end would silence the reminder for
        // that set forever.
        if (lastStoreWriteMs !== 0 && Date.now() - lastStoreWriteMs < QUIET_PERIOD_MS) return;
        if (turnsSinceWrite < MIN_TURNS_SINCE_WRITE) return;

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
        // The injection restarts both buffer clocks (the spec's "an
        // injection resets the turn count and the quiet period"): the
        // quiet period counts from now, the count from this turn end. The
        // restart is unconditional — a delivery failure is swallowed, not
        // retried from here, and the guard is already armed for the same
        // open set either way.
        lastStoreWriteMs = Date.now();
        turnsSinceWrite = 0;
      });
    },
  };
}
