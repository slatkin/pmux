/**
 * The pi-event → thinking-feed wiring (design D3), driven without pi: the
 * handlers are registered on a fake ExtensionAPI and fired with fake
 * events. The feed file is real, in a temporary runtime directory, so the
 * records on disk are exactly what the sidebar reads.
 */
import "./host-env.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createThinkingFeed,
  type ThinkingFeedDeps,
} from "../pi-extension/pmux/thinking-feed-events.ts";
import type { ThinkingFeedRecord } from "../pi-extension/pmux/thinking-feed.ts";
import { thinkingFeedPath } from "../pi-extension/pmux/thinking-feed-file.ts";
import { feedShape } from "./thinking-feed-shape.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-thinking-events-");

type Handler = (event?: unknown, ctx?: unknown) => void;

/** A fake pi: `on` collects the handlers, `fire` invokes them. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
  };
  const fire = (event: string, data?: unknown, ctx?: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn(data, ctx);
  };
  return { pi, fire };
}

function ctxFor(sessionId: string) {
  return { cwd: "/work/app", sessionManager: { getSessionId: () => sessionId } };
}

const thinking = (type: string, extra: Record<string, unknown> = {}) => ({
  assistantMessageEvent: { type, ...extra },
});

/** A registered feed whose runtime directory is `runtime`. */
function harness(runtime: string, deps: Partial<ThinkingFeedDeps> = {}) {
  const env: NodeJS.ProcessEnv = {
    TMUX_PANE: "%7",
    XDG_RUNTIME_DIR: runtime,
    ...deps.env,
  };
  const { pi, fire } = fakePi();
  createThinkingFeed({ ...deps, env }).register(pi as never);
  const feedFile = (sessionId: string) => {
    const file = thinkingFeedPath({ env, sessionId });
    assert.ok(file);
    return file;
  };
  const records = (sessionId: string): ThinkingFeedRecord[] =>
    fs
      .readFileSync(feedFile(sessionId), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { env, fire, feedFile, records };
}

describe("the thinking feed wiring", () => {
  test("a session in a tmux pane writes start, delta and end records", () => {
    withTempDir((runtime) => {
      // The wiring never looks the sidebar binary up: the feed is written
      // whether or not pmux-explorer is installed, so an absent binary and
      // a PATH that holds no sidebar change nothing.
      const { fire, records, feedFile } = harness(runtime, {
        env: { PMUX_EXPLORER_BIN: "/nonexistent/pmux-explorer", PATH: "/nonexistent" },
      });
      fire("session_start", undefined, ctxFor("s1"));
      assert.equal(fs.statSync(path.dirname(feedFile("s1"))).mode & 0o777, 0o700);
      assert.equal(fs.statSync(feedFile("s1")).mode & 0o777, 0o600);

      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_delta", { delta: "hello " }));
      fire("message_update", thinking("thinking_end", { content: "hello world" }));
      fire("session_shutdown");

      const written = records("s1");
      assert.deepEqual(
        written.map((record) => record.kind),
        ["start", "delta", "end"],
      );
      assert.equal(written[0]!.text, undefined);
      assert.equal(written[1]!.text, "hello ");
      assert.equal(written[2]!.text, "hello world");
      assert.equal(new Set(written.map((record) => record.producer)).size, 1);
    });
  });

  test("a new session_start switches to the new id's file", () => {
    withTempDir((runtime) => {
      const { fire, records, feedFile } = harness(runtime);
      fire("session_start", undefined, ctxFor("abc"));
      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_delta", { delta: "old" }));
      fire("session_start", undefined, ctxFor("def"));
      // The switch flushed the pending delta into the old file.
      assert.deepEqual(feedShape(records("abc")), ["start", "delta:old"]);
      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_delta", { delta: "new" }));
      fire("message_update", thinking("thinking_end", { content: "new" }));
      fire("session_shutdown");
      // Later thinking lands in the new file; the old one gets no more.
      assert.equal(records("abc").length, 2);
      assert.equal(records("def").length, 3);
      assert.ok(fs.existsSync(feedFile("def")));
    });
  });

  test("session_shutdown flushes the pending delta", () => {
    withTempDir((runtime) => {
      const { fire, records } = harness(runtime);
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_delta", { delta: "pending" }));
      // The 50 ms flush has not fired; shutdown must write the buffer.
      fire("session_shutdown");
      assert.deepEqual(feedShape(records("s1")), ["delta:pending"]);
    });
  });

  test("no TMUX_PANE: no feed directory or file is created", () => {
    withTempDir((runtime) => {
      const { fire } = harness(runtime, { env: { TMUX_PANE: "" } });
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_start"));
      fire("session_shutdown");
      assert.equal(fs.existsSync(path.join(runtime, "pmux-thinking")), false);
    });
  });

  test("PMUX_EXPLORER=0: no feed directory or file is created", () => {
    withTempDir((runtime) => {
      const { fire } = harness(runtime, { env: { PMUX_EXPLORER: "0" } });
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_start"));
      fire("session_shutdown");
      assert.equal(fs.existsSync(path.join(runtime, "pmux-thinking")), false);
    });
  });

  test("a session id that resolves to no path gets no producer", () => {
    withTempDir((runtime) => {
      const { fire } = harness(runtime);
      fire("session_start", undefined, ctxFor("../escape"));
      fire("message_update", thinking("thinking_start"));
      fire("session_shutdown");
      assert.equal(fs.existsSync(path.join(runtime, "pmux-thinking")), false);
    });
  });
});

describe("a feed failure never disturbs the session", () => {
  test("a throwing append raises nothing into pi", () => {
    withTempDir((runtime) => {
      const { fire } = harness(runtime, {
        append: () => {
          throw new Error("disk full");
        },
      });
      assert.doesNotThrow(() => {
        fire("session_start", undefined, ctxFor("s1"));
        fire("message_update", thinking("thinking_start"));
        fire("message_update", thinking("thinking_delta", { delta: "x" }));
        fire("message_update", thinking("thinking_end", { content: "x" }));
        fire("session_shutdown");
      });
    });
  });

  test("a directory that cannot be created raises nothing into pi", () => {
    // XDG_RUNTIME_DIR is an existing regular file: mkdir below it fails.
    withTempDir((blocker) => {
      const file = path.join(blocker, "not-a-dir");
      fs.writeFileSync(file, "");
      const { pi, fire } = fakePi();
      createThinkingFeed({
        env: { TMUX_PANE: "%7", XDG_RUNTIME_DIR: file },
      }).register(pi as never);
      assert.doesNotThrow(() => {
        fire("session_start", undefined, ctxFor("s1"));
        fire("message_update", thinking("thinking_start"));
        fire("message_update", thinking("thinking_delta", { delta: "x" }));
        fire("session_shutdown");
      });
      assert.equal(fs.existsSync(path.join(file, "pmux-thinking")), false);
    });
  });
});
