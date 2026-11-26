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
still publishes `runtime.json` with its own loopback URL, so `garcon-cli`
discovery reaches the original directly; that remains correct because the
original still owns every CLI route. Executor CLI forwarding is unaffected
because it does not use HTTP.

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

Decision: Unless `GARCON_TRUST_PROXY` is set, the front door replaces
`X-Forwarded-For` with the connection's address, removes `X-Real-IP`, and
starts the original with `GARCON_TRUST_PROXY=1`. With `GARCON_TRUST_PROXY` set,
an upstream proxy's headers pass through unchanged.

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
