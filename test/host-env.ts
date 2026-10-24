/**
 * Clear the terminal-host and subagent-identity variables for the test
 * process.
 *
 * The suite must never talk to a real multiplexer. A run inside a tmux pane
 * inherits the host keys, and an un-stubbed backend call would then mutate
 * real panes — including closing the pane that runs the suite. It would
 * also inherit the pane's own `PI_PMUX_*` and detector keys
 * (`PI_SUBAGENT_DEPTH`, `PI_BLACKHOLE_*`), which would leak a fake child
 * depth and marker list into the env builders under test. Every test file
 * that exercises a backend imports this module first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("PI_PMUX_") ||
    key.startsWith("PI_BLACKHOLE_") ||
    key === "PI_SUBAGENT_DEPTH" ||
    key === "TMUX" ||
    key === "TMUX_PANE"
  ) {
    delete process.env[key];
  }
}

/**
 * The extension reads its config when the module loads, before a test can
 * point it anywhere. A suite run on a machine with a real pmux config (a
 * custom `surface`, a different status setup) would read the user's settings
 * and change what the tests see. Give the process its own agent config
 * directory: empty, and removed when the process ends.
 */
const agentConfigDir = mkdtempSync(join(tmpdir(), "pi-pmux-test-"));
process.env.PI_CODING_AGENT_DIR = agentConfigDir;
process.on("exit", () => {
  rmSync(agentConfigDir, { recursive: true, force: true });
});
