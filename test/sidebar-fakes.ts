/**
 * Shared fakes for the sidebar tests.
 *
 * The publisher's seam is the spawner: a fake that records the command line
 * and the payload it received on stdin, and holds each child's exit until a
 * test releases it — the real publisher spawns the next hook only after the
 * previous one exited. Both sidebar test files drive the same seam, so the
 * fake lives here, beside the tmux fakes.
 */
import type { SidebarChild } from "../pi-extension/pmux/sidebar.ts";

export interface SidebarSpawnCall {
  /** The binary the publisher spawned. */
  command: string;
  /** The command line's arguments. */
  args: string[];
  /** The payload the publisher wrote to the child's stdin. */
  stdin: string;
}

/** The exit listeners of the children still running in the module's fakes. */
const running: (() => void)[] = [];

/** A fake spawner that records every call and the payload on stdin. */
export function makeSidebarSpawn() {
  const calls: SidebarSpawnCall[] = [];
  const spawn = (command: string, args: string[]): SidebarChild => {
    calls.push({ command, args, stdin: "" });
    return {
      stdin: {
        write(chunk: string) {
          calls[calls.length - 1].stdin += chunk;
          return true;
        },
        end() {},
      },
      onExit(listener: () => void) {
        running.push(listener);
      },
    };
  };
  return { spawn, calls };
}

/** Exit the oldest running fake child. */
export function exitOneSidebarChild(): void {
  running.shift()?.();
}

/** Let the publisher's deferred emit run, then exit every child it spawned. */
export const flushSidebarQueue = async (): Promise<void> => {
  for (let round = 0; round < 100; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (running.length === 0) return;
    while (running.length > 0) running.shift()?.();
  }
};
