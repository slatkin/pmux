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
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDirHelpers } from "./temp-dir.ts";
import {
  UPDATE_BEFORE_FINISH_REMINDER,
  MIN_TURNS_SINCE_WRITE,
  QUIET_PERIOD_MS,
  createTaskReminders,
  openTaskKey,
  openTasks,
  parseSidebarTaskStore,
  readSidebarTaskStore,
  readSidebarTaskStoreMtime,
  readSidebarTaskStorePath,
  sidebarTaskStorePath,
  type SidebarTaskItem,
  type SidebarTaskStatus,
  type TaskRemindersDeps,
} from "../pi-extension/pmux/task-reminders.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// host-env.ts has already scrubbed the live identity vars (TMUX, TMUX_PANE,
// PI_PMUX_*) from this process; each test below sets exactly what it needs.

const PANE_ENV = { TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%7" };
// What a settled turn boundary carries: the boundary's `outcome` verdict plus
// the last message. The skip reads the outcome, so the message is only here
// for realism.
const STOP = {
  outcome: "completed",
  message: { role: "assistant", stopReason: "stop" },
  turnIndex: 0,
};
const ERROR_END = {
  outcome: "error",
  message: { role: "assistant", stopReason: "error" },
  turnIndex: 0,
};
const ABORTED_END = {
  outcome: "aborted",
  message: { role: "assistant", stopReason: "aborted" },
  turnIndex: 0,
};

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
  /** The pane ids the store stat was called with; the buffer's one stat per turn end. */
  stats: string[];
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
  readStoreMtime?: TaskRemindersDeps["readStoreMtime"];
  send?: TaskRemindersDeps["send"];
}): Harness {
  const { readStore, send = () => {} } = options;
  const readStoreMtime = options.readStoreMtime ?? (() => null);
  const handler = {
    reads: [] as string[],
    stats: [] as string[],
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
    readStoreMtime: (pane) => {
      handler.stats.push(pane);
      return readStoreMtime(pane);
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

// The buffer's turn count needs at least three observed turn ends since the
// store's last write. Firing two settled turn ends with the store untouched
// is the set-up every test whose own third turn end is the interesting one.
function armTurnCount(harness: Pick<Harness, "fire">): void {
  harness.fire("turn_end", STOP);
  harness.fire("turn_end", STOP);
}

describe("the wording (D1)", () => {
  it("is byte for byte the sidebar's UPDATE_BEFORE_FINISH_REMINDER", () => {
    assert.equal(
      UPDATE_BEFORE_FINISH_REMINDER,
      "Reminder: make sure the task board is up to date.",
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
    assert.equal(openTaskKey(items), '["1","2"]');
    assert.equal(openTaskKey([item("2"), item("1")]), '["1","2"]', "the key is order-independent");
  });

  it("cannot encode two different open sets as one key", () => {
    // A comma-joined key would make ["1","2"] and the single id "1,2"
    // collide, hiding a changed set from the guard; the JSON encoding keeps
    // every shape its own key.
    assert.notEqual(openTaskKey([item("1"), item("2")]), openTaskKey([item("1,2")]));
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

  it("stats the pane store's mtime: a fresh epoch-ms number for a present file, null otherwise", () => {
    const unique = `${process.pid}-mtime`;
    const pane = `%PMUX_TASK_TEST_${unique}`;
    const path = sidebarTaskStorePath(pane);
    try {
      // No store has been written: the buffer's quiet signal is absent.
      assert.equal(readSidebarTaskStoreMtime(pane), null);
      writeFileSync(path, "{}");
      const mtime = readSidebarTaskStoreMtime(pane);
      assert.ok(mtime !== null && Number.isFinite(mtime) && Date.now() - mtime < 5_000);
    } finally {
      rmSync(path, { force: true });
    }
    assert.equal(readSidebarTaskStoreMtime(""), null, "no pane id, no mtime signal");
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
    // The turn count must reach three first: two turn ends pass it up, the
    // third fires. Both the read and the injection happened inside that
    // synchronous handler call — the pane's own store was read and the
    // injection recorded with nothing awaited in between, so the read never
    // delays the handler's return.
    armTurnCount({ fire });
    assert.deepEqual(reads, ["%7", "%7"]);
    assert.deepEqual(sent, []);
    fire("turn_end", STOP);
    assert.deepEqual(reads, ["%7", "%7", "%7"]);
    assert.deepEqual(sent, delivered(), "one steer with the wording, and no triggerTurn option");
  });

  it("a stop that does not settle completed is skipped by the outcome alone", () => {
    // The decision is the boundary's `outcome`: even a turn whose last
    // message stopped normally gets nothing when the settlement is `error`
    // or `aborted` (and anything else pi adds there in the future). The
    // buffer's stat still runs for those turn ends — they are observed
    // turn ends, and the store's contents are not read for them.
    const { fire, reads, stats, sent } = makeHarness({ readStore: () => [item("1")] });
    fire("turn_end", {
      outcome: "error",
      message: { role: "assistant", stopReason: "stop" },
      turnIndex: 0,
    });
    fire("turn_end", {
      outcome: "aborted",
      message: { role: "assistant", stopReason: "stop" },
      turnIndex: 0,
    });
    assert.deepEqual(reads, []);
    assert.deepEqual(stats, ["%7", "%7"]);
    assert.deepEqual(sent, []);
  });

  it("never reads the store at all when the pane has no TMUX_PANE", () => {
    const { fire, reads, stats, sent } = makeHarness({
      env: { TMUX: "/tmp/tmux-0/default" },
      readStore: () => [item("1")],
    });
    fire("turn_end", STOP);
    assert.deepEqual(reads, []);
    assert.deepEqual(stats, [], "with no pane there is no stat and no read");
    assert.deepEqual(sent, []);
  });

  it("a failed or aborted turn gets no steer, and the store read does not run for it", () => {
    const { fire, reads, sent } = makeHarness({ readStore: () => [item("1")] });
    fire("turn_end", ERROR_END);
    fire("turn_end", ABORTED_END);
    assert.deepEqual(reads, []);
    assert.deepEqual(sent, []);
    fire("turn_end", STOP);
    assert.deepEqual(
      sent,
      delivered(),
      "the next healthy boundary is not silenced by theirs — and the count, three turn ends across outcomes, is reached on it",
    );
  });

  it("a store with nothing open is silent, and the next boundary starts clean", () => {
    const { fire, reads, sent } = makeHarness({
      readStore: () => [item("1", "completed"), item("2", "completed")],
    });
    // The count is armed by the first two turn ends; the contents are read
    // for them regardless — completed items are in the store to be read.
    fire("turn_end", STOP);
    fire("turn_end", STOP);
    assert.deepEqual(reads, ["%7", "%7"]);
    assert.deepEqual(sent, []);
  });

  it("does not re-fire until the store's open set changes (D5, once the buffer allows a fire)", () => {
    // A set change marches with an mtime change in production — the
    // sidebar rewrites the store file on every `task-set` and
    // `task-update` — so the model moves both. Every write here is already
    // older than the quiet period, leaving the count as the only gate, and
    // each write restarts it: the reminder fires on the third turn end
    // that follows a write, for whatever set that write left open.
    let msSeq = 0;
    const oldWrite = () => Date.now() - (QUIET_PERIOD_MS + 60_000) - msSeq++ * 1000;
    let store = [item("1", "in_progress"), item("2", "pending")];
    let writeAt: number | null = oldWrite();
    const { fire, sent } = makeHarness({
      readStore: () => store,
      readStoreMtime: () => writeAt,
    });
    armTurnCount({ fire });
    fire("turn_end", STOP);
    assert.deepEqual(sent, delivered());

    fire("turn_end", STOP);
    assert.equal(sent.length, 1, "the same open set does not re-fire, however long it sits");

    // A real write: one item completes, the set drops to ["2"], the file's
    // mtime moves — and the write is once more already six minutes old,
    // so the count is what the next two turn ends pay.
    store = [item("1", "completed"), item("2", "pending")];
    writeAt = oldWrite();
    fire("turn_end", STOP); // one turn end since the write
    assert.equal(sent.length, 1, "one turn since the write: still buffered");
    fire("turn_end", STOP); // two
    assert.equal(sent.length, 1, "two turns since the write: still buffered");
    fire("turn_end", STOP); // three: the reminder fires for the changed set
    assert.equal(sent.length, 2, "the open set changed, so the reminder fires again");
    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "the changed set does not re-fire either");

    // An emptied store: its completing write is old the same way, so three
    // turn ends arm the guard with the empty set — and stay silent.
    store = [];
    writeAt = oldWrite();
    armTurnCount({ fire });
    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "an emptied store is silent");

    // A later recording is a changed set against a long-untouched store,
    // and its write too has aged: it fires on its third turn end.
    store = [item("4")];
    writeAt = oldWrite();
    armTurnCount({ fire });
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

  it("swallows a throwing injection, the clocks already restarted", () => {
    const { fire } = makeHarness({
      readStore: () => [item("1")],
      send: () => {
        throw new Error("send is down");
      },
    });
    armTurnCount({ fire });
    fire("turn_end", STOP);
  });

  it("swallows a rejected injection", async () => {
    const { fire } = makeHarness({
      readStore: () => [item("1")],
      send: () => Promise.reject(new Error("steer is down")),
    });
    armTurnCount({ fire });
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
    // The write must have aged: the buffer's quiet period holds a fresh
    // mtime out, so the file is backdated into the count-open window.
    const backdated = new Date(Date.now() - (QUIET_PERIOD_MS + 60_000));
    utimesSync(path, backdated, backdated);
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

      for (let i = 0; i < MIN_TURNS_SINCE_WRITE; i += 1) {
        for (const fn of handlers.get("turn_end") ?? []) {
          fn({
            outcome: "completed",
            message: { role: "assistant", stopReason: "stop" },
            turnIndex: i,
          });
        }
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

/**
 * The buffer's clocks (the buffer-task-reminders change): the store's
 * mtime against the turn end's now is the quiet period, and the turn ends
 * since the store's last write are the count. The tests own `Date.now()`,
 * and they shape the injected mtimes as fixed instants relative to it —
 * write, rewrite, age and injection are all modelled there, with the real
 * file case reading the file's own mtime.
 */
describe("the buffer's clocks (the store's mtime and the turn count)", () => {
  const realNow = Date.now;
  const startMs = new Date("2026-10-22T18:00:00.000Z").getTime();
  let nowMs = startMs;

  beforeEach(() => {
    nowMs = startMs;
    Date.now = () => nowMs;
  });
  afterEach(() => {
    Date.now = realNow;
  });
  const advance = (ms: number): void => {
    nowMs += ms;
  };

  it("a store written within the last five minutes stays silent, however many turn ends pass", () => {
    // The write happened a minute ago and nothing rewrites it inside the
    // test's few milliseconds: the quiet period has the whole say.
    const writeAt = nowMs - (QUIET_PERIOD_MS - 60_000);
    const { fire, sent, stats } = makeHarness({
      readStore: () => [item("1")],
      readStoreMtime: () => writeAt,
    });
    armTurnCount({ fire });
    fire("turn_end", STOP);
    assert.deepEqual(sent, [], "the list was just touched, so nothing nags yet");
    assert.equal(stats.length, 3, "every turn end is statted while the buffer holds");
  });

  it("a store untouched past the five minutes fires on the third turn end since the write", () => {
    // The write is already six minutes old, so the quiet period's gate is
    // open all along: the count alone is what the first two turn ends pay.
    const writeAt = nowMs - (QUIET_PERIOD_MS + 60_000);
    const { fire, sent } = makeHarness({
      readStore: () => [item("1")],
      readStoreMtime: () => writeAt,
    });
    fire("turn_end", STOP);
    assert.deepEqual(sent, [], "one observed turn end since the write");
    fire("turn_end", STOP);
    assert.deepEqual(sent, [], "two observed turn ends since the write");
    fire("turn_end", STOP);
    assert.deepEqual(sent, delivered(), "the third turn end since the write fires");
  });

  it("a rewrite between turn ends restarts both clocks (count and quiet)", () => {
    // A task-update lands between the second and third turn end of a
    // long-untouched store. Without the rewrite the third turn end would
    // fire against the six-minutes-old write; the rewrite restarts both
    // clocks, so the reminder waits again.
    const baseAt = nowMs - (QUIET_PERIOD_MS + 60_000); // the long-untouched write
    const rewriteAt = nowMs; // the rewrite's own mtime, a fixed instant
    let turnIndex = 0;
    const store = [item("1")];
    const { fire, sent } = makeHarness({
      readStore: () => store,
      readStoreMtime: () => (turnIndex < 2 ? baseAt : rewriteAt),
    });
    fire("turn_end", STOP); // turn 0: the old write is six minutes stale, the count is one
    fire("turn_end", STOP); // turn 1: the count is two
    assert.deepEqual(sent, []);
    turnIndex = 2;
    fire("turn_end", STOP); // turn 2: the rewrite is observed, both clocks restart
    assert.deepEqual(sent, [], "the rewrite restarted the clocks instead of firing");
    fire("turn_end", STOP); // turn 3: one turn since the rewrite
    fire("turn_end", STOP); // turn 4: two turns since it; the count alone would have fired
    assert.deepEqual(sent, [], "the count climbs from the rewrite, not from before it");
    // The rewrite's quiet period is five minutes too: one more turn end
    // once the clock outlives it, and the count satisfied, the reminder
    // finally fires — three turn ends after the rewrite, one write later.
    advance(QUIET_PERIOD_MS + 1_000);
    fire("turn_end", STOP);
    assert.deepEqual(
      sent,
      delivered(),
      "the five minutes and three turn ends since the write expired",
    );
  });

  it("a maintained list (a write between every turn end) never lets the count reach three", () => {
    // Each turn end observes a newer write's mtime — the agent touched the
    // list during every turn, each write more than five minutes old by the
    // turn that follows it, so the quiet period's gate is open all along
    // and the count, restarted by every detection, never reaches three.
    // This is the noise the buffer exists to remove.
    let turnIndex = 0;
    const mtimeAt = () => nowMs - (QUIET_PERIOD_MS + 60_000 - turnIndex * 1000);
    const { fire, sent, stats } = makeHarness({
      readStore: () => [item("1")],
      readStoreMtime: mtimeAt,
    });
    for (let i = 0; i < 8; i += 1) {
      turnIndex = i;
      fire("turn_end", STOP);
    }
    assert.deepEqual(sent, []);
    assert.equal(stats.length, 8, "all maintained turn ends are observed");
  });

  it("a real store file runs the whole buffer: fresh mtime silent, aged mtime firing", () => {
    const unique = `${process.pid}-quiet`;
    const pane = `%PMUX_TASK_TEST_${unique}`;
    const path = sidebarTaskStorePath(pane);
    try {
      writeFileSync(
        path,
        JSON.stringify({ tasks: [{ id: "1", subject: "open thing", status: "pending" }] }),
      );
      const kept = statSync(path);
      // Age the file's mtime to the quiet window's last minute (one minute
      // old): the count is armed by the two turn ends, and the third stays
      // inside the quiet period anyway.
      utimesSync(path, kept.atime, new Date(nowMs - (QUIET_PERIOD_MS - 60_000)));
      const { fire, sent } = makeHarness({
        readStore: () => readSidebarTaskStore(pane),
        readStoreMtime: () => readSidebarTaskStoreMtime(pane),
      });
      armTurnCount({ fire });
      fire("turn_end", STOP);
      assert.deepEqual(sent, [], "the file was touched a minute ago");
      // The same write, now six minutes old: the re-aging is the detected
      // rewrite, the count needs its three turn ends from it, and the
      // reminder fires.
      utimesSync(path, kept.atime, new Date(nowMs - (QUIET_PERIOD_MS + 60_000)));
      armTurnCount({ fire });
      fire("turn_end", STOP);
      assert.deepEqual(sent, delivered(), "the aged, untouched file lets the reminder through");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("an injection restarts both clocks: the count and the five minutes from now", () => {
    // The reminder fires from the count alone (a six-minutes-old write),
    // and the clocks restart at the injection's own moment: nothing fires
    // again until a newer write has aged out both.
    let writeAt = nowMs - (QUIET_PERIOD_MS + 60_000);
    let store: SidebarTaskItem[] = [item("1")];
    const { fire, sent } = makeHarness({
      readStore: () => store,
      readStoreMtime: () => writeAt,
    });
    armTurnCount({ fire });
    fire("turn_end", STOP);
    assert.deepEqual(sent, delivered());

    // The agent acts on the reminder: a write right after it, the set
    // changing to one more open item. The write's own freshness holds the
    // quiet period, and the count needs its three turn ends again.
    store = [item("1"), item("2")];
    writeAt = nowMs;
    fire("turn_end", STOP);
    fire("turn_end", STOP);
    fire("turn_end", STOP);
    assert.deepEqual(
      sent,
      delivered(),
      "the changed set waits for the five minutes and the three turns since its write",
    );
    // The write outlived quietly, so the set fires once both clocks give: the
    // count is way past three by now, and the open set differs from the last
    // injection's set.
    advance(QUIET_PERIOD_MS + 1_000);
    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "the changed set fires after its own write aged out");
    fire("turn_end", STOP);
    assert.equal(sent.length, 2, "and that set does not re-fire either (guard)");
  });
});
