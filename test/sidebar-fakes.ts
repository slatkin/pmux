/**
 * Shared fakes for the sidebar tests.
 *
 * The publisher's seam is the spawner: a fake that records the command line
 * and the payload it received on stdin. Both sidebar test files drive the
 * same seam, so the fake lives here, beside the tmux fakes.
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
    };
  };
  return { spawn, calls };
}

/** Let the publisher's deferred emit run. */
export const flushSidebarQueue = () => new Promise<void>((resolve) => setImmediate(resolve));
