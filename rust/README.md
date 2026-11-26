# Garcon in Rust

This directory holds the incremental Rust rewrite of the Garcon controller and
the verification loop that proves each step. The approach follows
[rust-anything](https://github.com/erkamyaman/rust-anything) (permalinks below
are at commit `1f84dc4d17d5276880900ba5b34b1721095c97ff`): record what the
original does from the outside, port one unit at a time, and replay every
recording against the Rust build before a unit counts as done.

- [`DECISIONS.md`](DECISIONS.md) records the architecture decisions as ADRs.
- [`MAP.md`](MAP.md) is the port plan: every unit, its state, and what blocks it.

## Layout

```text
rust/
  garcon-server/      The front door: a Rust binary that owns the listener,
                      serves ported units natively, and proxies the rest to
                      the TypeScript original it starts as a child process
  parity/             The verification loop (Bun, workspace @garcon/parity)
    cli.ts            record and replay commands
    scenarios/        What to send: HTTP and WebSocket steps per scenario
    golden/           What the original did, with placeholders and wildcards
    fixtures/         A deterministic web build used for every recording
    replay-report.md  The committed result of replaying the front door
```

## The front door

`garcon-server` accepts the controller's arguments and environment. It binds the
requested address, starts `bun server/main.ts` on an ephemeral loopback port,
relays its logs (rewriting the `Started at` line to its own URL), and mirrors
its lifetime: SIGTERM and SIGINT are forwarded so the original shuts down
gracefully, and the front door exits with the original's status. Help,
`executor` mode, maintenance flags, and arguments it cannot parse run the
original directly.

```bash
bun run rust:build
rust/target/release/garcon-server --port 8080
```

| Variable | Effect |
| --- | --- |
| `GARCON_RS_ORIGINAL_ROOT` | Checkout containing `server/main.ts` (default: working directory) |
| `GARCON_RS_BUN` | Bun executable used to start the original (default: `bun`) |
| `GARCON_RS_FALLBACK_LOG` | Appends `METHOD path` for every request handed to the original |
| `GARCON_RS_UNIT_<UNIT>=original` | Sends a native unit's routes back to the original without a rebuild |

Unit names for the kill switch are listed in [`MAP.md`](MAP.md).

## The verification loop

A scenario is a sequence of HTTP and WebSocket steps run against a fresh server
in an isolated config, workspace, project, and home directory, with seeded
credentials. Scenarios marked `traps` also run generated variants of every
step: missing and forged credentials, HEAD, trailing and doubled slashes, dot
segments, encoded traversal, non-ASCII path segments, and malformed or
non-ASCII JSON bodies.

```bash
bun run parity:record        # run the original twice per scenario, write golden/
bun run parity:replay        # the original must replay its own recordings
bun run rust:build
bun run parity:replay:rust   # the front door must match every case
```

What is compared, per case:

- HTTP: status, the contract headers listed in `parity/src/capture.ts`
  (`Content-Length` only for uncompressed bodies), and the decoded body: JSON
  structurally, text exactly, binary by SHA-256.
- WebSocket: whether the upgrade succeeded, the negotiated subprotocol, the
  replies to the step's own requests (matched by `clientRequestId`), the close
  code, and for a refused upgrade the raw HTTP status and body, which WebSocket
  clients do not expose. Unsolicited broadcasts are not recorded, because their
  timing is outside the step's control; they need scenarios with a
  deterministic trigger.
- Values that belong to one server start (temporary paths, port, session
  token) become placeholders such as `{{projectDir}}`. Timestamps, UUIDs, and
  JWTs become `{{timestamp}}`, `{{uuid}}`, and `{{jwt}}`, so their presence and
  position are still checked.
- Anything else that differs between the original's two runs becomes a `[..]`
  wildcard, trimmed to whole words. `record` prints every wildcard it creates;
  review each one, since order and count differences are exactly what a port
  can get wrong for real.

`replay` reports passed and total cases, the share served without falling back
to the original, a table of distinct differences grouped by field, and the
first difference of each failing case as a JSON path. The report has no
timings or temporary paths, so CI checks the committed report with
`git diff --exit-code`. CI also replays the original against its own
recordings, so a TypeScript change to recorded behavior fails until the
scenarios are recorded again.

The loop is only as good as its coverage. Before trusting a green replay for a
unit, plant a deliberate bug in it (a header, a status, an off-by-one) and
confirm the replay fails on the expected field; a surviving mutant means a
scenario is missing.

## Porting a unit

1. Claim the unit in [`MAP.md`](MAP.md) and read its ADRs.
2. Extend or add scenarios until every route the unit serves, its error paths,
   and the state it reads are exercised. Record and review the noise.
3. Implement the unit in `garcon-server/src/<unit>.rs` with a `claim` function
   that accepts only requests the unit fully owns, and a kill switch.
4. `bun run rust:build && bun run parity:replay:rust` must pass every case.
   Commit the updated `parity/replay-report.md`.
5. Run the mutation check described above, then mark the unit done in the map
   with its replay result.

Rust code is formatted with `cargo fmt` and must pass
`cargo clippy --all-targets -- -D warnings`. A C linker is required for the
GNU target; no crate in the workspace needs a C compiler.
