# Decisions

Architecture decisions for the Rust rewrite. ADRs are numbered in order and
never renumbered; a changed decision gets a new ADR that supersedes the old one.

## ADR-001: A Rust front door with the TypeScript original as fallback

Status: accepted (2026-11-26)

Context: The backend is roughly 165,000 lines of TypeScript across `server/`,
`server-agents/`, `common/`, and `cli/`, with live behavior that must not
regress while the port is in progress: chat execution, provider processes, the
encrypted executor link, PTYs, and browser WebSockets. A rewrite delivered in
one step could not be verified or reviewed.

Decision: The Rust binary owns the public listener from the start and proxies
every request it does not serve natively, including WebSocket and executor-link
upgrades, to the original running on an ephemeral loopback port. Units move to
Rust one at a time. The original is removed only when the replay passes with no
fallback (rust-anything's "lift").

Consequences: The application keeps working at every step, and the fallback
rate measures progress. Until the lift, Garcon runs two processes. The original
still writes `runtime.json`, but publishes the front door's origin in it
(`--runtime-origin`): advertising its own ephemeral loopback port broke
`garcon-cli` restart detection in the end-to-end suite, because the port
changes on every restart. Executor CLI forwarding is unaffected because it does
not use HTTP.

## ADR-002: Record and replay from the outside

Status: accepted (2026-11-26)

Context: rust-anything proves a rewrite by recording the original's observable
behavior and replaying it against the port
([whole-app guide](https://github.com/erkamyaman/rust-anything/blob/1f84dc4d17d5276880900ba5b34b1721095c97ff/docs/whole-apps.md)).
Its `app record --http` cannot seed Garcon's credentials, authenticate, drive
the WebSocket protocol, or isolate config, workspace, project, and home
directories per run.

Decision: `rust/parity` implements the same model for Garcon: two recording
runs per scenario, run-to-run differences as wildcards, stable placeholders for
per-start and volatile values, generated trap variants, and deterministic
reports. Instead of rust-anything's source fingerprint, CI replays the original
against its own recordings, which detects stale recordings by behavior. The
equivalence bar is the HTTP status, the contract headers, and the decoded body;
JSON object key order is not compared.

Consequences: Any build that accepts the controller's arguments can be
replayed, including the original itself, which must always pass. Behavior that
no scenario exercises is not verified; coverage gaps are found by planting
mutations (see README).

## ADR-003: A unit moves with the state it owns

Status: accepted (2026-11-26)

Context: Almost every controller store loads its file once and serves it from
memory without watching it (`auth.json`, `auth-sessions.json`, `chats.json`,
`project-settings.json`, provider and executor configuration, snippets, and
others). Some writes are deferred by up to a second. A second process reading
or writing those files would observe stale state or lose writes.

Decision: Rust serves a route natively only when it needs no controller state
or when Rust owns that state outright, together with every in-process consumer
of it. Shared mutable files between the two processes are not allowed.

Consequences: Stateless edges move first. Stateful domains move as whole
vertical slices, and a domain with many in-process consumers (chats, auth)
needs an explicit hand-over design before it can move. See MAP.md.

## ADR-004: Native units claim only canonical requests

Status: accepted (2026-11-26)

Context: The original's routing has behavior that follows from Bun's router and
Node's `path.resolve` rather than design: a trailing slash after a file name
still serves the file, doubled leading slashes are routed at the root mount but
not under a base path, and percent-encoded file names are never decoded, so a
file whose name has a space or non-ASCII character returns 404.

Decision: A native unit claims a request only when its path is canonical: no
empty, `.` or `..` segments, no percent escapes, no trailing slash, and only
unreserved and sub-delimiter characters. Everything else goes to the original.

Consequences: Edge cases keep the original's exact behavior without being
reimplemented, and the replay covers them through the fallback. They must be
ported, or deliberately changed in both implementations, before the lift.

## ADR-005: Range requests stay with the original until the lift

Status: accepted (2026-11-26)

Context: The original implements single byte ranges by slicing a stream. Bun
then decides between `Content-Length` and chunked framing based on how the
stream is consumed: `bytes=0-99` arrives with a length, `bytes=2000-` and range
requests answered with the full body arrive chunked. Reproducing that would
mean reproducing Bun's stream timing.

Decision: Requests with a `Range` header fall back to the original.

Consequences: The SPA does not send range requests for its assets, so the
native share of real traffic is unaffected. The lift needs a deliberate
decision on range framing.

## ADR-006: Recordings use a fixed web build

Status: accepted (2026-11-26)

Context: `web/build` changes with every build: asset names are content hashes
and the shell embeds them. Recordings taken from it would fail after any
rebuild.

Decision: The controller reads the asset root from `GARCON_WEB_BUILD_DIR`,
defaulting to `<install>/web/build`, and the front door honors the same
variable. The harness points both at `rust/parity/fixtures/web-build`, a small
committed build covering the shell template, the manifest, and every asset
type and cache rule.

Consequences: Static recordings are stable across machines and builds. The
fixture must keep the runtime base-path token and title markup that the shell
renderer requires.

## ADR-007: The front door owns the client address

Status: accepted (2026-11-26)

Context: The login rate limiter keys on the client address. Behind a proxy
every client would share the proxy's loopback address unless the original
trusts forwarded headers, and trusting them unconditionally would let clients
choose their own key.

Decision: Unless `--trust-proxy` or `GARCON_TRUST_PROXY` is set, the front
door replaces `X-Forwarded-For` with the connection's address, removes
`X-Real-IP`, and starts the original with `--trust-proxy`. With either set, an
upstream proxy's headers pass through unchanged. The front door passes this,
and `--runtime-origin`, as flags rather than environment variables: the
original's terminal and provider children inherit its environment, so a Garcon
started from a Garcon terminal would otherwise trust forwarded headers from any
client.

Consequences: Rate limiting behaves as it does without the front door, and the
`spoofed-forwarded-for` case in `api-session` guards it. The original's
loopback port also accepts forwarded headers from local processes, which can
already reach it directly.

## ADR-008: hyper without a web framework, pure-Rust dependencies

Status: accepted (2026-11-26)

Context: The front door needs exact control over framing, headers, and protocol
upgrades for transparent proxying, and must build wherever Garcon builds.

Decision: Use hyper and hyper-util directly. Compression uses flate2 (gzip,
zlib-framed deflate) and ruzstd (zstd), with no C compiler required. Revisit a
routing framework when native routes outgrow a match on path prefixes.

Consequences: Encoders differ from Bun's byte for byte, which the harness
tolerates by comparing decoded bodies and the `Content-Encoding` header.

## ADR-009: Shadow the end-to-end suites, not only recorded scenarios

Status: accepted (2026-11-26)

Context: Anthropic's Rust migration of its API passed about 98% of its tests
while matching only about a quarter of production inputs, and was verified by
shadowing: the same traffic to both implementations, nondeterministic model
output recorded once and replayed to both, and each divergence fingerprinted by
where it begins and the length difference
([Migrating the Claude API to Rust](https://www.anthropic.com/research/migrating-api-to-rust)).
Garcon has no production traffic to shadow, but its server and Chromium suites
generate realistic traffic against deterministic scripted providers.

Decision: The integration fixtures can start the controller behind the front
door (`GARCON_TEST_CONTROLLER=front-door`). In shadow mode
(`GARCON_RS_SHADOW_LOG`) the front door sends each natively served request to
the original as well and logs a fingerprinted comparison. A unit is verified by
three loops: the scenario replay, the end-to-end suites with identical
outcomes under both controllers, and zero shadow divergences across them.

Consequences: Shadow mode doubles the work of native requests and is for
verification only. It applies to idempotent native units; a unit with side
effects needs a different comparison before it can be shadowed.

The first full run justified the third loop: the scenario replay and 76,091
shadowed asset responses all matched, yet three Chromium suites failed only
behind the front door. Its sockets left Nagle's algorithm on, so small
WebSocket and API writes waited for acknowledgements that a direct connection
to Bun never waits for. Content comparison cannot see latency; suite outcomes
can.

## ADR-010: The relay enforces the browser socket budget

Status: accepted (2026-11-26)

Context: The original drops a browser socket when more than
`GARCON_WS_BACKPRESSURE_LIMIT` bytes are queued in Bun for it. In
`websocket-backpressure.test.ts` (`direct replies drop a slow browser`), a
paused client sends 64 large pings. Connected directly, the original
terminates it after 42 to 47 of them. Behind a plain relay, every ping was
accepted, the client resumed reading, received all 16.8 MB of replies, and was
never dropped: the original passed 5 of 5 runs and the front door 0 of 5. The
relay hop absorbs the backlog in kernel buffers, so the original's queue never
exceeds its budget. Clamping those buffers did not change the outcome.

Decision: The relay applies the original's budget where the client's socket
is. For the browser socket (`<base path>/ws`) it reads the original's replies
eagerly, as Bun does for a direct client, and when more than the budget waits
for the browser it resets the connection, as Bun's `terminate()` does. The
original then sees the connection close and runs its usual disconnect
handling. Executor links keep plain backpressure, because the original does
not drop them at that budget either. This was chosen over accepting later
slow-client detection, because it keeps the original's guarantee and adds no
latency: the original is never blocked by a slow browser.

Consequences: The backpressure suite passes 5 of 5 under both controllers.
Memory per browser socket in the front door is bounded by the budget plus one
read chunk. The budget moves to Rust with the WebSocket unit when browser
delivery is ported.

The investigation also fixed two relay defects with unit tests: a client that
kept sending could hold a connection open after the original ended it, and both
directions shared one lock.

## ADR-011: Cache web build files and their encodings in memory

Status: accepted (2026-11-26)

Context: The original reads every static asset from disk and compresses it on
every request. For the largest application chunk (1.4 MB) that is about 22 ms
of CPU per request; the first native implementation did the same with a
slower encoder and served 60% fewer requests than the original.

Decision: The static-assets unit keeps each file it serves, and each encoding
it produces, in memory, keyed by path, size, and modification time, within a
128 MB budget. Built assets are content-addressed, so a rebuild produces new
paths or new versions and stale entries are never served. Files beyond the
budget are served uncached. Compression uses zlib-rs, a pure-Rust deflate.

Consequences: Responses are unchanged, so the scenario replay and shadow
comparison still match. Large compressed assets are served about 40 to 50
times faster with about 1% of the CPU (BENCHMARKS.md); the front door holds the
cached build in memory.

## ADR-012: Port along the executor link and the process boundary

Status: accepted (2026-11-27)

Context: After static assets, every remaining controller domain reads state
that other in-process consumers cache, so ADR-003 allows no further route to
move without hand-over glue between the two processes. Two boundaries already
have a complete contract and black-box coverage: the executor link
(`ExecutorRpcMethods`, exercised by the two remote lanes of the server suites)
and the controller's process boundary (the integration fixtures start it by
command line and drive it over HTTP and WebSocket).

Decision: The worker and the controller are ported as two programs behind
those boundaries. `garcon-server executor` in native mode is verified under the
unmodified TypeScript controller. The native controller mode has no fallback,
answers unported routes with a marked 501, and is verified by the same suites,
by the parity replay, and against the TypeScript worker on the remote lanes.
The front door with its fallback stays the default mode until the lift.

Consequences: Supersedes the unit order implied by ADR-001; the front door,
ADR-003, and the lift criteria stand. Progress is measured per quadrant of
controller and worker implementation instead of by fallback rate. No state is
handed between the two controllers at run time.

## ADR-013: Every integration is ported to Rust

Status: accepted (2026-11-27)

Context: The integrations depend on no provider SDK that requires JavaScript:
they supervise CLIs and speak JSON streams, HTTP, and SSE. Keeping them in
TypeScript would keep Bun as a runtime dependency after the lift.

Decision: Each integration becomes a crate behind the `AgentIntegration`
contract, in the order direct, Claude and Codex, Pi, OpenCode, Antigravity,
shell, then cursor, amp, and factory. Claude, Codex, Pi, OpenCode, and
Antigravity are verified through their pinned scripted-model suites; cursor,
amp, and factory have no scripted tier and are verified by ported unit tests
and recorded converter cases, as best-effort providers are today.

Consequences: Live conformance is added only where a scripted tier cannot
reach the behavior in question. Codex code mode needs a JavaScript parser
crate in place of `acorn`.

## ADR-014: Only current-version workspaces

Status: accepted (2026-11-27)

Context: `server/controller/migrations/` (3,300 lines), the legacy history
import facets, and the `migration.*` RPC methods exist to upgrade workspaces
written by earlier releases.

Decision: The Rust controller opens a workspace only at the version the last
TypeScript release writes. An older workspace is refused at startup with a
message naming that release, which upgrades it when it opens it once.
`--rollback-carryover-migration` is not ported.

Consequences: The migration ladder is not ported. The version marker, its
check, and the on-disk formats of the current version are, and both
implementations must read each other's files.

## ADR-015: Accidental behavior becomes a listed difference

Status: accepted (2026-11-27)

Context: Some recorded behavior follows from Bun and not from design: the
routing accidents of ADR-004 and the range framing of ADR-005.

Decision: The port does not reproduce them. Each case that then differs is
listed in `rust/parity/known-differences.json` with its reason and the Rust
result; the replay passes such a case only with exactly that result, and fails
once it no longer differs. The list is reviewed by the user at the lift.
Everything else keeps the bar of ADR-002, including error codes and error
text.

Consequences: Supersedes the open question in ADR-004 and ADR-005. A new entry
needs the user's approval; a session never adds one to make a case pass.

## ADR-016: A C toolchain at build time

Status: accepted (2026-11-27)

Context: The ledger, tickets, pull-request reviews, and transcript search use
SQLite, the search index needs FTS5, and executor links need TLS.

Decision: The workspace may depend on crates that compile C: rusqlite with
bundled SQLite and FTS5, and a TLS provider.

Consequences: Supersedes the pure-Rust constraint of ADR-008 for these
dependencies; hyper without a web framework stands. Builds need a C compiler;
the binary still has no runtime dependency on system libraries beyond libc.

## ADR-017: One core thread

Status: accepted (2026-11-27)

Context: The original's invariants assume one event loop: code between two
awaits runs to completion, and admission fences, queue transitions, and
ordered broadcasts depend on that. `bun:sqlite` calls are synchronous on that
thread, and work proportional to a transcript runs on Workers or in bounded
steps.

Decision: Controller logic and worker logic each run on one single-threaded
runtime, with state shared without locks as the original shares it. Blocking
and transcript-sized work (compression, rendering, token fitting, search,
long SQLite passes) runs on other threads and returns over channels, where the
original uses a Worker or `EventLoopSteps`.

Consequences: The first pass is a faithful translation and adds no races the
original does not have. Throughput is bounded by one core, as it is today;
revisit in the reshape pass after the lift.

## ADR-018: One contract crate; the CLI is ported last

Status: accepted (2026-11-27)

Context: `common/` is the contract shared by the server, the CLI, the web
client (100 modules through `$shared`), and the integration tests. `cli/`
depends on nothing else.

Decision: `garcon-contract` holds the Rust form of every DTO, parser, and
validator the server, worker, or CLI needs, one module per `common/` module
with the same name. `garcon-cli` is ported in the last wave and depends on
`garcon-contract` and `garcon-base` only. Until then the TypeScript CLI runs
unchanged against the Rust server. `common/` stays where it is as the web
client's and the integration tests' contract; modules only the server used are
removed with the original.

Consequences: After the lift the contract exists in two languages. The
recorded cases of ADR-020 are the guard against drift: both the Rust tests and
`common/__tests__` run them. The shipped artifact needs no Bun once the CLI
is ported.

## ADR-019: Targets

Status: accepted (2026-11-27)

Decision: Linux x64 is verified on every unit. Code stays portable: no
Unix-only API without a `cfg` and a counterpart where the original supports
Windows. macOS arm64 and Windows x64 are built and smoke-tested in CI at the
lift, as `build-exe:smoke` does today.

## ADR-020: Three levels of recorded behavior

Status: accepted (2026-11-27)

Context: The port must mirror the original's responses exactly. rust-anything
proves that by recording the original and replaying the port at each level
where behavior is observable: the unit's exported functions, and the app's
edge. Passing tests alone is weaker evidence (ADR-009).

Decision: Behavior is recorded from the original and replayed against the
port at three levels, with the same rules at each: two recording runs,
run-to-run differences as reviewed wildcards, a mismatch fixed in the port and
never in the recording, and ADR-015 for differences that stand.

- Unit cases: for a module of pure functions, every call its TypeScript unit
  tests make to its exports, plus generated trap inputs, is recorded as
  `{fn, args, result}` and replayed by the Rust crate's tests.
- Edge cases: the scenarios of ADR-002 for every route group.
- Suite traces: the integration test client records every HTTP exchange and
  every reply to its own WebSocket requests while a suite runs; the trace of
  the original is the golden for the same suite under the Rust controller.
  Broadcasts are compared per chat and event type where the original's two
  runs agree.

The rust-anything CLI itself is not used: its bridge and recorder assume Node
and cannot seed, authenticate, or isolate Garcon (ADR-002), and Garcon's
modules import Bun APIs.

Consequences: A unit is not done on green tests alone; its recorded cases must
match N of N. Recordings are committed and replayed in CI against both
implementations, so a TypeScript change to recorded behavior fails until it is
recorded again.

## ADR-021: The manager integrates and commits

Status: accepted (2026-11-27)

Decision: Sessions share one worktree and own disjoint crates. Only the
manager edits the workspace manifest, `garcon-server`, `MAP.md`, and this
file, runs full lanes, and commits a unit to `rust-server` when its gate
passes. Sessions never commit; nothing is pushed. At most six sessions run at
once, each with `CARGO_BUILD_JOBS=1` and its own target directory.

## ADR-022: The controller and the executor are separate crate graphs

Status: accepted (2026-11-27)

Context: The original instantiates the same `ExecutionRuntime` in two places:
`ExecutorManager` for the Local executor and `worker.ts` for a remote one. Its
dependency direction (runtime and remoting never import controller modules) is
held by a lint test over imports. Local and remote behavior differ by design:
Local shares the controller's lifetime and has no relay, journal, or reconnect
states.

Decision: `garcon-executor` is the executor's only public entry.
`Executor::start` builds the runtime services and integrations around the host
its owner supplies; `api()` returns the `ExecutionRuntimeApi` handle; `serve`
adds the RPC server, producer relay, reply journal, and CLI gateway over a
link. A remote executor is a thin main that parses arguments, starts, and
serves. The Local executor is the same `start`, called by the binary that
composes the controller, which passes the handle to `Controller::start`.
Controller crates never depend on executor crates, nor the reverse; only
contracts, primitives, and the link are shared. The executor ships two ways
from one function: the `executor` subcommand of `garcon-server`, which the
fixtures and documentation use, and the standalone `garcon-executor` binary,
which contains no controller code.

Local is not routed through the link. That would give one code path, but it
would change recorded Local behavior (ADR-020); the ported transport
abstraction keeps it possible after the lift.

Consequences: `garcon-server/tests/workspace_structure.rs` fails when a
workspace crate has no role, when a dependency crosses the boundary, or when
the executor's main grows beyond a call into its library. The composition
root moves out of the binary into `garcon-controller`, so the `garcon-server`
main is a dispatch between the two at the lift.

## ADR-023: Three binaries

Status: accepted (2026-11-27)

Context: With ADR-022 the controller and the executor are libraries joined
only by a composing binary, so which roles a binary contains is a choice of
main function.

Decision: The workspace builds three binaries from thin mains:

- `garcon-server`: the controller with a Local executor, as today. It keeps
  the `executor` subcommand that the fixtures and documentation use.
- `garcon-executor`: an executor only, with no controller code.
- `garcon-controller`: a controller only, with no executor code; every
  execution target is a remote executor.

`Controller::start` receives the Local executor by injection and never
constructs one, so the controller-only binary needs no conditional
compilation.

Consequences: The first two mirror the original and are verified against it.
A controller without a Local executor does not exist in the original: its
behavior is new, cannot be recorded, and is specified and tested as its own
unit after the core milestone (MAP.md, unit `controller-only`). Until that
unit is done the third binary is not built.

## ADR-024: The shared crates mirror the original's packages

Status: accepted (2026-11-27)

Context: The plan put `server/common` in `garcon-base` below a
`garcon-contract` that held both `common/` and the agent interface. In the
original the dependency runs the other way: `common/` imports nothing,
`server-agents/interface` imports `common/`, and ten of the 28 `server/common`
modules import one or both (`domain-error`, `http-error`,
`executor-disconnect`, and others). The planned layering was a crate cycle.

Decision: One shared crate per original package, depending in the original's
direction: `garcon-js` (the JavaScript-semantics helpers of RULES.md, which
have no original), `garcon-contract` (`common/`), `garcon-interface`
(`server-agents/interface`), `garcon-base` (`server/common`), `garcon-link`.
A module's path is its package's crate plus its file name in snake case.

Consequences: Supersedes the part of ADR-018 that placed the agent interface
in `garcon-contract`; the CLI depends on `garcon-contract` and `garcon-js`,
and may use `garcon-base`. No `server/common` module is split from its
directory.

## ADR-025: Each session works in its own worktree

Status: accepted (2026-11-27)

Context: Sessions sharing one worktree (ADR-021) saw each other's
half-written files: a commit captured a test that another session had just
added and that failed, a crate two sessions wrote into could be left
uncompilable for both, and concurrent git commands collided on the index.
Holding a session still until its work was committed cost it time.

Decision: Each session has a worktree `.worktrees/rust-server-<label>` on a
branch `rust-server-<label>` created from `rust-server`, and commits its own
work there when a part is complete and green. The worktree of `rust-server`
is the integration tree: only the manager edits it, merges a reported commit
into it after running the gate on the merge, and pushes `rust-server` to
origin after each merge. A session takes integrated work in with
`git merge rust-server` and never pushes, rebases, or touches another
worktree.

Consequences: Supersedes the shared worktree of ADR-021; its limit of six
sessions, their build settings, and the rule that only the manager edits the
workspace manifest, `garcon-server`, `MAP.md`, and this file stand. Two
sessions that add modules to one crate both edit its `lib.rs`, and the manager
resolves that file in the merge. `rust-server` is rebased onto `main` only
with every session paused.

## ADR-026: Bun 1.4.3 is the reference runtime, and Rust builds leave the development machine

Status: accepted (2026-11-28)

Context: CI and the release build pin Bun 1.4.3, while the development machine
ran 1.4.5. The original behaves differently on the two: a refused WebSocket
upgrade reports another close code to its client, a project path ending in a
backslash is found on 1.4.5 and not on 1.4.3, and `bun:sqlite` differs in
twelve probed behaviors, among them the SQLite version and the range of
integers bound as INTEGER. Recordings made on 1.4.5 failed two cases in CI.
Separately, six sessions compiling Rust beside their Bun work overloaded the
development machine until the Garcon server on it crashed.

Decision: The behavior to mirror is the original on the Bun that CI and the
release build pin. Recordings, replays, and oracle tests run with that
version. No Rust is compiled on the development machine: sessions and the
manager run every building command on a separate build machine, which has the
pinned Bun and Rust toolchain, through one wrapper that copies a worktree's
sources there. Formatting, which compiles nothing, stays local.

Consequences: A recording that differs between Bun versions is rerecorded on
the pinned one, and the difference is noted where a port could meet it. When
the pin moves, the recordings are replayed on the new version before it is
adopted. Files a remote command writes do not come back, except the lock file,
so recordings are produced locally and only compiled and tested remotely.
