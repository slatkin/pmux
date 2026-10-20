/**
 * Clear the terminal-host variables for the test process.
 *
 * The suite must never talk to a real multiplexer. A run inside a tmux pane
 * or a Luvus pane inherits the host keys, and an un-stubbed backend call would
 * then mutate real panes — including closing the pane that runs the suite.
 * Every test file that exercises a backend imports this module first.
 */
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("LUVUS_") ||
    key.startsWith("PI_LUVUS_") ||
    key === "TMUX" ||
    key === "TMUX_PANE"
  ) {
    delete process.env[key];
  }
}
