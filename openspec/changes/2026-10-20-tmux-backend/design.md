# Design

## Context

Two terminal hosts run the same subagent lifecycle: a pane is opened, a child
runs in it, the parent reads the child back, and the pane is closed. Luvus
exposes that through its own CLI; tmux exposes it through `tmux` itself.

## Goals

- One surface API, two hosts. The rest of the extension must not know which
  host it runs in.
- The split must anchor on the caller's own pane.
- No change to the completion protocol (`.exit` sidecar) or to the child
  tools.

## Decisions

### Decision 1: The caller's pane identity is `$TMUX_PANE`, never "the current pane"

tmux resolves an untargeted command against the session's most recently used
window, which another client can change at any moment. `$TMUX_PANE` is set
by tmux for the pane the process actually runs in, so it is the only stable
anchor. The tmux backend uses it for every split, and the caller id is
passed explicitly to the backend calls that the CLI makes with an injected
environment.

Rejected: `tmux display-message -p '#{pane_id}'` — it resolves the most
recently active pane and lands the split in the wrong window when a second
client is attached. Rejected: an untargeted `split-window` — the same
problem, with no way to fix it later.

### Decision 2: A pane is created empty and the command is sent to it

The Luvus backend creates a pane and then runs the launch command in it. The
tmux backend does the same: `split-window` without a command starts the
default shell, and the launch command is delivered with `send-keys`. The
pane therefore outlives the child, so the parent can read the exit sentinel
from it and close it afterwards.

### Decision 3: The pane closes when the child ends, as it does today

The wrapper closes the pane after a `done` or `handoff` sidecar, with the
configured grace. Keeping this behaviour means the tmux host behaves like
the Luvus host: no pane pile-up, and the parent's view of the campaign is
the same in both.

### Decision 4: The report is the child's last assistant message

Under Luvus the child can reach the parent with `luvus agent send`. tmux has
no such channel, so the report is the child's last assistant message, which
the parent already reads from the child's session file. The parent-contact
footer says which of the two applies.

### Decision 5: Live status stays Luvus only

The status lease (`agent report`) and the UHP event stream are Luvus
features. Under tmux the supervisor polls the sidecar and the pane. Making
the status host independent is a separate change; it is not needed to run a
campaign.

### Decision 6: Luvus wins when both hosts are available

A Luvus session that itself runs inside tmux keeps the Luvus behaviour: the
pane ids, the agent list and the status leases all refer to the Luvus
workspace, which is the more specific host.

## Risks

- The tmux pane id (`%3`) is not the same kind of identity as a Luvus pane
  id. The surface id is passed to the child as `PI_LUVUS_SURFACE`, which the
  child uses for Luvus-specific reporting only; under tmux it is inert.
- `send-keys -l` sends text literally, so a command containing a newline
  would be typed as one line. The launch command is a single line by
  construction.
- A pane that dies without writing a sidecar leaves the parent polling. The
  screen sentinel covers a clean exit; a killed pane ends the wait through
  the abort signal.
