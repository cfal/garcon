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
