/**
 * The session's thinking feed wiring (design D3): one producer per
 * session, rebuilt at every `session_start` for that session's feed file,
 * fed by pi's thinking message events, and closed at shutdown.
 *
 * The feed follows the sidebar's two guards — the session runs in a tmux
 * pane and the sidebar switch is on — but not the sidebar's binary
 * lookup: the file is written whether or not pmux-explorer is installed.
 * Every feed failure is swallowed: a feed that cannot be created or
 * written must never raise an error into pi, delay a turn, or show a
 * message.
 *
 * The module holds the session's producer in the factory's closure — per
 * registration, no timers of its own, no global state, so `/reload`
 * safety is unchanged.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sidebarGuardsEnabled } from "./sidebar.ts";
import {
  createThinkingFeedProducer,
  type ThinkingFeedProducer,
  type ThinkingFeedRecord,
} from "./thinking-feed.ts";
import {
  appendThinkingFeedRecord,
  ensureThinkingFeed,
  thinkingFeedPath,
} from "./thinking-feed-file.ts";

export interface ThinkingFeedDeps {
  /**
   * The process environment; carries the guards (`TMUX_PANE`,
   * `PMUX_EXPLORER`) and the feed directory's `XDG_RUNTIME_DIR`.
   */
  env: NodeJS.ProcessEnv;
  /** Record append; `appendThinkingFeedRecord` by default. */
  append?: (filePath: string, record: ThinkingFeedRecord) => void;
}

export function createThinkingFeed(deps: ThinkingFeedDeps): { register(pi: ExtensionAPI): void } {
  const append =
    deps.append ??
    ((filePath: string, record: ThinkingFeedRecord): void => {
      appendThinkingFeedRecord({ filePath, record });
    });

  /** The live session's producer; none before the first `session_start` or when the guards fail. */
  let producer: ThinkingFeedProducer | null = null;

  return {
    register(pi: ExtensionAPI): void {
      pi.on("session_start", (_event, ctx) => {
        // A new session id gets its own feed: the previous producer is
        // flushed and dropped before the new file is opened, so the old
        // file gets no more records.
        producer?.close();
        producer = null;
        if (!sidebarGuardsEnabled(deps.env)) return;
        let filePath: string | null = null;
        try {
          filePath = thinkingFeedPath({
            env: deps.env,
            sessionId: ctx.sessionManager.getSessionId(),
          });
        } catch {
          // A session id pi cannot give is a feed that cannot be named.
        }
        if (filePath === null) return;
        // The ensure swallows its own failures: a feed that cannot be
        // created disturbs nothing.
        ensureThinkingFeed({ filePath });
        producer = createThinkingFeedProducer({
          append: (record) => {
            try {
              append(filePath, record);
            } catch {
              // A record that cannot be written is a record the reader
              // does not show; the session is never disturbed.
            }
          },
        });
      });

      // pi streams each reasoning phase as an assistant message event, and
      // the producer turns the three thinking phases into feed records.
      // Every other event type is not thinking and writes nothing; with no
      // session started there is no producer to write to.
      pi.on("message_update", (event) => {
        const update = event.assistantMessageEvent;
        if (!update) return;
        switch (update.type) {
          case "thinking_start":
            producer?.started();
            break;
          case "thinking_delta":
            producer?.delta(update.delta);
            break;
          case "thinking_end":
            producer?.ended(update.content);
            break;
        }
      });

      pi.on("session_shutdown", () => {
        // The last deltas of a run are not lost when the session goes away.
        producer?.close();
        producer = null;
      });
    },
  };
}
