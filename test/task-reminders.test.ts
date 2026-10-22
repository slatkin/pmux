/**
 * The sidebar-task-reminders module, driven without pi: the handlers are
 * registered on a fake ExtensionAPI and fired with fake events, and the store
 * reader and the steer send are injected, so the wording, the firing
 * condition, the guard and the never-disturbs rule are all pinned without a
 * sidebar, without tmux and without a store on disk.
 *
 * The one test that uses the real reader end to end writes the store file the
 * sidebar's `task_store.rs` really defines, at the pane id it really encodes,
 * and removes it again (readable through the true path); everything else
 * stays on the injected or path-level reader.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDirHelpers } from "./temp-dir.ts";
import {
  UPDATE_BEFORE_FINISH_REMINDER,
  createTaskReminders,
  isEmptyStore,
  openTaskKey,
  openTasks,
  parseSidebarTaskStore,
  readSidebarTaskStore,
  readSidebarTaskStorePath,
  sidebarTaskStorePath,
  type SidebarTaskItem,
  type SidebarTaskStatus,
  type TaskRemindersDeps,
} from "../pi-extension/pmux/task-reminders.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// A suite run inside a real pi/tmux pane inherits live identity vars. The
// factory reads the env it is handed, so this only guards the one index-level
// test below, which wires process.env for real.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("LUVUS_") ||
    key.startsWith("PI_LUVUS_") ||
    key.startsWith("PI_PMUX_") ||
    key === "TMUX" ||
    key === "TMUX_PANE"
  ) {
    delete process.env[key];
  }
}

const PANE_ENV = { TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%7" };
const STOP = { message: { role: "assistant", stopReason: "stop" }, turnIndex: 0 };
const ERROR_END = { message: { role: "assistant", stopReason: "error" }, turnIndex: 0 };
const ABORTED_END = { message: { role: "assistant", stopReason: "aborted" }, turnIndex: 0 };

const item = (id: string, status: SidebarTaskStatus = "pending"): SidebarTaskItem => ({
  id,
  subject: `task ${id}`,
  status,
});

/** The reminder delivery, as the harness records it. */
const delivered = (text = UPDATE_BEFORE_FINISH_REMINDER) => [
  { text, options: { deliverAs: "steer" } },
];

interface Harness {
  fire(event: string, data?: unknown): void;
  /** The pane ids the store reader was called with. */
  reads: string[];
  /** The injections: text and options, exactly as the dep received them. */
  sent: Array<{ text: string; options: unknown }>;
  /** Anything appended to the session output (must stay empty). */
  appends: unknown[];
  /** The event names the registration anchored. */
  anchored: string[];
}

function makeHarness(options: {
  env?: NodeJS.ProcessEnv;
  readStore: TaskRemindersDeps["readStore"];
  send?: TaskRemindersDeps["send"];
}): Harness {
  const { readStore, send = () => {} } = options;
  const handler = {
    reads: [] as string[],
    sent: [] as Array<{ text: string; options: unknown }>,
    appends: [] as unknown[],
    anchored: [] as string[],
  };
  const handlers = new Map<string, Array<(event?: unknown) => void>>();
  createTaskReminders(options.env ?? PANE_ENV, {
    readStore: (pane) => {
      handler.reads.push(pane);
      return readStore(pane);
    },
    send: (text, steerOptions) => {
      handler.sent.push({ text, options: steerOptions });
      return send(text, steerOptions);
    },
  }).register({
    on: (event: string, fn: (event?: unknown) => void) => {
      handler.anchored.push(event);
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    appendEntry: (...parts: unknown[]) => {
      handler.appends.push(parts);
    },
  } as never);
  return {
    ...handler,
    fire(event: string, data?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(data);
    },
  };
}

describe("the wording (D1)", () => {
  it("is byte for byte the sidebar's UPDATE_BEFORE_FINISH_REMINDER", () => {
    assert.equal(
      UPDATE_BEFORE_FINISH_REMINDER,
      "Open tasks remain: before finishing your turn, update their statuses with task-update <id> <status>.",
    );
  });

  it("stays one short single line, as the source's own test requires", () => {
    assert.ok(!UPDATE_BEFORE_FINISH_REMINDER.includes("\n"), "a reminder is one line");
    assert.ok(
      UPDATE_BEFORE_FINISH_REMINDER.length <= 120,
      "a reminder stays short enough to inject verbatim",
    );
  });
});

describe("the store reader (D2)", () => {
  const { withTempDir } = tempDirHelpers("pmux-task-reminders-");

  it("encodes the pane id the way task_store.rs does", () => {
    assert.equal(sidebarTaskStorePath("%5"), "/tmp/tmux-agent-tasks_5.json");
    assert.equal(sidebarTaskStorePath("%a%b"), "/tmp/tmux-agent-tasks_a_b.json");
    assert.equal(
      sidebarTaskStorePath("%PMUX_TASK_TEST_1"),
      "/tmp/tmux-agent-tasks_PMUX_TASK_TEST_1.json",
    );
  });

  it("parses the shape task_store.rs writes and reads every deviation as empty", () => {
    assert.deepEqual(
      parseSidebarTaskStore(
        JSON.stringify({
          tasks: [
            { id: "1", subject: "Fix the login bug", status: "pending" },
            { id: "2", subject: "Write the docs", status: "in_progress" },
          ],
        }),
      ),
      [
        { id: "1", subject: "Fix the login bug", status: "pending" },
        { id: "2", subject: "Write the docs", status: "in_progress" },
      ],
    );
    for (const deviation of ["not json at all", "[]", '"x"', "null", "no_tasks: {}"]) {
      assert.deepEqual(parseSidebarTaskStore(deviation), [], `${deviation} reads as empty`);
    }
    for (const deviation of [
      '{"no_tasks": []}',
      '{"tasks": null}',
      '{"tasks": "pending"}',
      '{"tasks": ["x"]}',
      '{"tasks": [null]}',
      '{"tasks": [{"id": 1, "subject": "s", "status": "pending"}]}',
      '{"tasks": [{"id": "1", "subject": 2, "status": "pending"}]}',
      '{"tasks": [{"id": "1", "subject": "s", "status": "weird"}]}',
      '{"tasks": [{"id": "1", "status": "pending"}]}',
      '{"tasks": [{"id": "1", "subject": "s"}]}',
    ]) {
      assert.deepEqual(parseSidebarTaskStore(deviation), [], `${deviation} reads as empty`);
    }
    // Unknown fields are not a deviation: the Rust reader is serde, which
    // ignores them, so the narrowest reader mirrors that.
    assert.deepEqual(
      parseSidebarTaskStore(
        '{"tasks": [{"id": "1", "subject": "s", "status": "pending", "extra": true}], "extra": 1}',
      ),
      [{ id: "1", subject: "s", status: "pending" }],
    );
  });

  it("keeps only the open statuses in the open set", () => {
    const items = [item("1", "pending"), item("2", "in_progress"), item("3", "completed")];
    assert.deepEqual(openTasks(items), [item("1"), item("2", "in_progress")]);
    assert.deepEqual(openTaskKey(items), "1,2");
    assert.deepEqual(openTaskKey([item("2"), item("1")]), "1,2", "the key is order-independent");
  });

  it("names the empty predicate", () => {
    assert.equal(isEmptyStore([]), true);
    assert.equal(isEmptyStore([item("1")]), false);
    assert.equal(isEmptyStore(parseSidebarTaskStore("not json at all")), true);
  });

  it("reads a readable, missing and unreadable file at a path", () => {
    withTempDir((dir) => {
      const path = join(dir, "tasks.json");
      assert.deepEqual(readSidebarTaskStorePath(join(dir, "missing.json")), []);
      writeFileSync(
        path,
        JSON.stringify({ tasks: [{ id: "7", subject: "Ship it", status: "pending" }] }),
      );
      assert.deepEqual(readSidebarTaskStorePath(path), [
        { id: "7", subject: "Ship it", status: "pending" },
      ]);
      chmodSync(path, 0o000);
      assert.deepEqual(readSidebarTaskStorePath(path), [], "an unreadable file reads as empty");
    });
  });

  it("reads the pane's store through the true path, from its pane id alone", () => {
    const unique = `${process.pid}-read`;
    const pane = `%PMUX_TASK_TEST_${unique}`;
    const path = sidebarTaskStorePath(pane);
    try {
      writeFileSync(
        path,
        JSON.stringify({ tasks: [{ id: "1", subject: "recorded", status: "in_progress" }] }),
      );
      assert.deepEqual(readSidebarTaskStore(pane), [
        { id: "1", subject: "recorded", status: "in_progress" },
      ]);
    } finally {
      rmSync(path, { force: true });
    }
    assert.deepEqual(readSidebarTaskStore(`%PMUX_TASK_TEST_${process.pid}-missing`), []);
    assert.deepEqual(readSidebarTaskStore(""), [], "no pane id, no store condition");
  });
});

describe("the settlement anchor", () => {
  it("registers exactly the turn_end anchor: no before_agent_start, no timers", () => {
    const { anchored, appends, sent } = makeHarness({ readStore: () => [] });
    assert.deepEqual(anchored, ["turn_end"]);
    assert.deepEqual(sent, []);
    assert.deepEqual(appends, []);
  });

  it("injects the reminder, once, through the steer channel, at a turn end with open items", () => {
    const store = [item("1", "pending"), item("2", "in_progress"), item("3", "completed")];
    const { fire, reads, sent } = makeHarness({ readStore: () => store });
    fire("turn_end", STOP);
    assert.deepEqual(reads, ["%7"], "the read is the pane's own store, synchronously");
    assert.deepEqual(sent, delivered(), "one steer with the wording, and no triggerTurn option");
  });

  it("never reads the store at all when the pane has no TMUX_PANE", () => {
    const { fire, reads, sent } = makeHarness({
      env: { TMUX: "/tmp/tmux-0/default" },
      readStore: () => [item("1")],
    });
    fire("turn_end", STOP);
    assert.deepEqual(reads, []);
    assert.deepEqual(sent, []);
  });

  it("a failed or aborted turn gets no steer, and the store read does not run for it", () => {
    const { fire, reads, sent } = makeHarness({ readStore: () => [item("1")] });
    fire("turn_end", ERROR_END);
    fire("turn_end", ABORTED_END);
    assert.deepEqual(reads, []);
    assert.deepEqual(sent, []);
    fire("turn_end", STOP);
    assert.deepEqual(sent, delivered(), "the next healthy turn end is not silenced by theirs");
  });

  it("a store with nothing open is silent, and the next boundary starts clean", () => {
    const { fire, reads, sent } = makeHarness({
      readStore: () => [item("1", "completed"), item("2", "completed")],
    });
    fire("turn_end", STOP);
    fire("turn_end", STOP);
    assert.deepEqual(reads, ["%7", "%7"]);
    assert.deepEqual(sent, []);
  });

  it("does not re-fire until the store's open set changes (D5)", () => {
    let store = [item("1", "in_progress"), item("2", "pending")];
    const { fire, sent } = makeHarness({ readStore: () => store });
    fire("turn_end", STOP);
    assert.deepEqual(sent, delivered());

    fire("turn_end", STOP);
    assert.equal(sent.length, 1, "the same open set does not re-fire");

    store = [item("1", "completed"), item("2", "pending")];
    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "the open set changed, so the reminder fires again");

    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "the changed set does not re-fire either");

    store = [];
    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "an emptied store is silent");

    store = [item("4")];
    fire("turn_end", STOP);
    assert.equal(
      sent.length,
      3,
      "a later recording is a changed set, so the reminder fires for it",
    );
  });

  it("a subagent child stays quiet, whatever the store holds (D4)", () => {
    const { fire, reads, sent } = makeHarness({
      env: { ...PANE_ENV, PI_PMUX_SESSION: "/tmp/child.jsonl" },
      readStore: () => [item("1")],
    });
    fire("turn_end", STOP);
    assert.deepEqual(reads, []);
    assert.deepEqual(sent, []);
  });
});

describe("delivery never disturbs the session (D6, D7)", () => {
  it("swallows a failing store read", () => {
    const { fire, sent, appends } = makeHarness({
      readStore: () => {
        throw new Error("disk on fire");
      },
    });
    fire("turn_end", STOP);
    assert.deepEqual(sent, []);
    assert.deepEqual(appends, [], "nothing went to the session output");
  });

  it("reads the store synchronously: the read and the injection both happen inside fire", () => {
    const { fire, reads, sent } = makeHarness({ readStore: () => [item("1")] });
    fire("turn_end", STOP);
    assert.deepEqual(reads, ["%7"]);
    assert.deepEqual(sent, delivered(), "delivered without awaiting anything");
  });

  it("swallows a throwing injection", () => {
    const { fire } = makeHarness({
      readStore: () => [item("1")],
      send: () => {
        throw new Error("send is down");
      },
    });
    fire("turn_end", STOP);
  });

  it("swallows a rejected injection", async () => {
    const { fire } = makeHarness({
      readStore: () => [item("1")],
      send: () => Promise.reject(new Error("steer is down")),
    });
    fire("turn_end", STOP);
    // The rejection is caught by the handler's own promise chain; settle one
    // turn of the microtask queue so an escaping rejection would fail here.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

describe("the index.ts registration (D7)", () => {
  it("delivers through the real reader and the real pi seam", async () => {
    const unique = `${process.pid}-index`;
    const pane = `%PMUX_TASK_TEST_${unique}`;
    const path = sidebarTaskStorePath(pane);
    const store = { tasks: [{ id: "1", subject: "recorded", status: "in_progress" }] };
    writeFileSync(path, JSON.stringify(store));
    const savedPane = process.env.TMUX;
    const savedPaneId = process.env.TMUX_PANE;
    process.env.TMUX = "/tmp/tmux-0/default";
    process.env.TMUX_PANE = pane;
    const handlers = new Map<string, Array<(event?: unknown) => void>>();
    const sentMessages = new Array<{ message: string; opts?: unknown }>();
    const appends = new Array<unknown>();
    try {
      const mod = await import(
        `${pathToFileURL(join(REPO_ROOT, "pi-extension", "pmux", "index.ts")).href}?tasks=${unique}`
      );
      mod.default({
        on: (event: string, fn: (event?: unknown) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        getAllTools: () => [],
        sendUserMessage: (message: string, opts?: unknown) => {
          sentMessages.push({ message, opts });
        },
        appendEntry: (...parts: unknown[]) => {
          appends.push(parts);
        },
      } as never);

      for (const fn of handlers.get("turn_end") ?? []) {
        fn({ message: { role: "assistant", stopReason: "stop" }, turnIndex: 0 });
      }
    } finally {
      for (const fn of handlers.get("session_shutdown") ?? []) fn(undefined);
      rmSync(path, { force: true });
      delete process.env.TMUX_PANE;
      if (savedPane === undefined) delete process.env.TMUX;
      else process.env.TMUX = savedPane;
      if (savedPaneId === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = savedPaneId;
    }
    assert.deepEqual(sentMessages, [
      { message: UPDATE_BEFORE_FINISH_REMINDER, opts: { deliverAs: "steer" } },
    ]);
    assert.deepEqual(appends, [], "nothing went to the session output");
  });
});
