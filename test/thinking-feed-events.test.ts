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
import os from "node:os";
import path from "node:path";

import {
  createThinkingFeed,
  type ThinkingFeedDeps,
} from "../pi-extension/pmux/thinking-feed-events.ts";
import type { ThinkingFeedRecord } from "../pi-extension/pmux/thinking-feed.ts";
import { thinkingFeedPath } from "../pi-extension/pmux/thinking-feed-file.ts";

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

/** A registered feed in a temporary runtime directory. */
function harness(deps: Partial<ThinkingFeedDeps> = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-feed-events-"));
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
  const cleanup = () => fs.rmSync(runtime, { recursive: true, force: true });
  return { runtime, env, fire, feedFile, records, cleanup };
}

describe("the thinking feed wiring", () => {
  test("a session in a tmux pane writes start, delta and end records", () => {
    const { fire, records, feedFile, cleanup } = harness();
    try {
      fire("session_start", undefined, ctxFor("s1"));
      assert.equal(fs.statSync(path.dirname(feedFile("s1"))).mode & 0o777, 0o700);
      assert.equal(fs.statSync(feedFile("s1")).mode & 0o777, 0o600);

      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_delta", { delta: "hello " }));
      fire("message_update", thinking("thinking_end", { content: "hello world" }));
      fire("session_shutdown");

      const kinds = records("s1").map((record) => record.kind);
      assert.deepEqual(kinds, ["start", "delta", "end"]);
      const [start, delta, end] = records("s1");
      assert.equal(start!.text, undefined);
      assert.equal(delta!.text, "hello ");
      assert.equal(end!.text, "hello world");
      assert.equal(new Set(records("s1").map((record) => record.producer)).size, 1);
    } finally {
      cleanup();
    }
  });

  test("a new session_start switches to the new id's file", () => {
    const { fire, records, feedFile, cleanup } = harness();
    try {
      fire("session_start", undefined, ctxFor("abc"));
      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_delta", { delta: "old" }));
      fire("session_start", undefined, ctxFor("def"));
      // The switch flushed the pending delta into the old file.
      assert.deepEqual(
        records("abc").map((record) => `${record.kind}:${record.text ?? ""}`),
        ["start:", "delta:old"],
      );
      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_delta", { delta: "new" }));
      fire("message_update", thinking("thinking_end", { content: "new" }));
      fire("session_shutdown");
      // Later thinking lands in the new file; the old one gets no more.
      assert.equal(records("abc").length, 2);
      assert.equal(records("def").length, 3);
      assert.ok(fs.existsSync(feedFile("def")));
    } finally {
      cleanup();
    }
  });

  test("session_shutdown flushes pending text", () => {
    const { fire, records, cleanup } = harness();
    try {
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_delta", { delta: "pending" }));
      // The 50 ms flush has not fired; shutdown must write the buffer.
      fire("session_shutdown");
      assert.deepEqual(
        records("s1").map((record) => `${record.kind}:${record.text ?? ""}`),
        ["delta:pending"],
      );
    } finally {
      cleanup();
    }
  });

  test("an empty thinking end carries no text", () => {
    const { fire, records, cleanup } = harness();
    try {
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_end", { content: "" }));
      const end = records("s1").find((record) => record.kind === "end");
      assert.ok(end);
      assert.equal("text" in end, false);
    } finally {
      cleanup();
    }
  });

  test("no TMUX_PANE: no feed directory or file is created", () => {
    const { runtime, env, fire, cleanup } = harness({ env: { TMUX_PANE: "" } });
    try {
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_start"));
      fire("session_shutdown");
      assert.equal(fs.existsSync(path.join(runtime, "pmux-thinking")), false);
      assert.equal(env.TMUX_PANE, "");
    } finally {
      cleanup();
    }
  });

  test("PMUX_EXPLORER=0: no feed directory or file is created", () => {
    const { runtime, fire, cleanup } = harness({ env: { PMUX_EXPLORER: "0" } });
    try {
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_start"));
      fire("session_shutdown");
      assert.equal(fs.existsSync(path.join(runtime, "pmux-thinking")), false);
    } finally {
      cleanup();
    }
  });

  test("a session id that resolves to no path gets no producer", () => {
    const { runtime, fire, cleanup } = harness();
    try {
      fire("session_start", undefined, ctxFor("../escape"));
      fire("message_update", thinking("thinking_start"));
      fire("session_shutdown");
      assert.equal(fs.existsSync(path.join(runtime, "pmux-thinking")), false);
    } finally {
      cleanup();
    }
  });

  test("the feed is written when no pmux-explorer binary is found", () => {
    // The wiring never looks the binary up: an environment with no
    // PMUX_EXPLORER_BIN and no sidebar on PATH writes the same.
    const { fire, records, cleanup } = harness({
      env: { PMUX_EXPLORER_BIN: "/nonexistent/pmux-explorer", PATH: "/nonexistent" },
    });
    try {
      fire("session_start", undefined, ctxFor("s1"));
      fire("message_update", thinking("thinking_start"));
      fire("message_update", thinking("thinking_end", { content: "done" }));
      fire("session_shutdown");
      assert.deepEqual(
        records("s1").map((record) => record.kind),
        ["start", "end"],
      );
    } finally {
      cleanup();
    }
  });
});

describe("a feed failure never disturbs the session", () => {
  test("a throwing append raises nothing into pi", () => {
    const { fire, cleanup } = harness({
      append: () => {
        throw new Error("disk full");
      },
    });
    try {
      assert.doesNotThrow(() => {
        fire("session_start", undefined, ctxFor("s1"));
        fire("message_update", thinking("thinking_start"));
        fire("message_update", thinking("thinking_delta", { delta: "x" }));
        fire("message_update", thinking("thinking_end", { content: "x" }));
        fire("session_shutdown");
      });
    } finally {
      cleanup();
    }
  });

  test("a directory that cannot be created raises nothing into pi", () => {
    // XDG_RUNTIME_DIR is an existing regular file: mkdir below it fails.
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-feed-blocker-"));
    const file = path.join(blocker, "not-a-dir");
    fs.writeFileSync(file, "");
    try {
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
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true });
    }
  });
});
