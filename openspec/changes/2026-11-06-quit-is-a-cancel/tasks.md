# Tasks

## 1. Child extension

- [x] 1.1 `pmux-done.ts`: track the terminal payload the session wrote, in every path that writes one.
- [x] 1.2 `pmux-done.ts`: on `session_shutdown` with reason `quit` and no sidecar on disk, write `cancelled` when the session wrote no payload or wrote `cancelled`, and write nothing otherwise; write status `done` with `cancelled`.

## 2. Tests

- [x] 2.1 A quit with no payload writes the `cancelled` sidecar and status.
- [x] 2.2 A quit after `pmux_done` whose sidecar was consumed writes nothing.
- [x] 2.3 A quit over a terminal sidecar leaves it in place.
- [x] 2.4 A session switch writes nothing.
- [x] 2.5 A failed error-sidecar write still keeps the quit from relabelling the provider error as a cancel.

## 3. Docs

- [x] 3.1 `skills/pmux/SKILL.md`, `docs/guide.md`: a `cancelled` sidecar covers Escape and a quit.
