# WebSocket server

## Where the original uses it

- `server/controller/server.ts:825-858` installs one Bun WebSocket handler for browser
  and executor upgrades. `server/controller/ws/upgrade.ts:21-92` routes those requests,
  authenticates the browser, and reserves admission before attempting the upgrade.
- `server/controller/config.ts:147-149` defaults to a 960 s idle timeout, 2 MiB browser
  outbound backlog and 16 MiB browser inbound payload. `server/controller/ws/server-sockets.ts:46-105`
  applies the shared native limits and the browser's own payload limit.
- `server/controller/ws/transport.ts:9-28` negotiates compression and opts in per send.
  `server/controller/ws/primary-delivery.ts:20-45,99-108` enforces the browser send budget
  for both direct messages and broadcasts. `server/controller/ws/chat.ts:545` subscribes
  the browser peer to `chat`; the JSON ping handler at line 358 sends a JSON pong
  independently of WebSocket control frames.

## Behavior the port must keep

- Preserve HTTP refusal status and body, auth and admission order, and admission
  release on failed upgrade and disconnect. The auth bearer may arrive in a
  protocol token; if the client offers the exact `garcon-v1` token, the controller
  explicitly selects it regardless of offer order. Without that override, Bun
  may echo an offered token rather than omitting the response header
  (`server/controller/lib/websocket-auth.ts:8-16`, handshake probe below).
- Count a reassembled message in bytes, not characters or fragments. The
  shared native limit is the greater of the browser limit and the Noise frame
  limit. The browser's post-delivery check closes with `1009` and
  `Message exceeds the configured size limit`; exceeding the shared limit never
  reaches that check. Noise branches before the browser check
  (`server/controller/ws/server-sockets.ts:51-53,68-87`).
- Measure queued outbound bytes at the client-facing socket, not at a relay hop,
  and do not stall other peers behind a slow one. In the original the browser's
  smaller limit is checked *after* sending; when exceeded, retire just that peer
  and terminate without a close frame. The separate shared native limit is at
  least 32 MiB. See ADR-010 and `server/controller/ws/primary-delivery.ts:30-39`.
- Preserve close code/reason on application close, including revocation, and
  distinguish a close frame from transport termination. Stop delivery to a
  retired peer immediately; do not wait for a peer's close response to release
  application ownership (`server/controller/ws/primary-delivery.ts:42-69,78-95`;
  `server/controller/server.ts:844-855`).
- Automatic pings are empty control frames. Inbound traffic resets native idle
  detection; it is not a matching-pong watchdog. The vendored timeout splits
  the timeout into idle time and a 4, 8, or 16 s ping grace, with a four-second
  timer sweep. Keep the inactivity bound, not an exact packet timestamp.
  Respond to client pings with the same payload, independently of JSON pings.
- Keep the app's broadcast subscription and per-peer send checks. Do not
  replace `PrimarySocketDelivery.publish` with raw Bun topic publishing
  semantics: a positive send count is summed, otherwise return -1 if any
  peer queued, else 0 (`server/controller/ws/primary-delivery.ts:99-108`).

## Rust crates

The existing workspace locks `hyper 1.13.0`, `hyper-util 0.1.21`, and
`tokio-tungstenite 0.27.0` / `tungstenite 0.27.0`. The front door uses
hyper's `http1`, `server`, and `client` with hyper-util's `tokio` adapter;
the benchmark enables `connect` and `handshake` on tokio-tungstenite
with defaults off. Both compiled on Rust 1.99.1 with
`cargo test -p garcon-bench -p garcon-server --locked`. See
`rust/Cargo.lock` and both crates' `Cargo.toml`.

The native browser transport uses `yawc 0.5.0` (MPL-2.0), with default
features off and `zlib` enabled. Neither tungstenite 0.27.0 nor 0.30.0
implements permessage-deflate. Soketto 0.8.1 implements it, but its receive
size check precedes inflation without bounding the inflater's output, and
its normal sender close API does not take an application close reason.
This choice does not change the executor link's transport.

- Hyper parses the handshake and hands off the connection, including
  already-read bytes. The application writes Bun's choice of subprotocol
  and extension explicitly; yawc's raw stream starts after the HTTP 101
  and uses those extension parameters without another handshake.
- Yawc bounds frame, assembled message, and inflate sizes. Translate the
  inclusive Bun ceiling to yawc's exclusive limit. Apply the browser's
  own byte limit to the decoded message separately to keep its 1009
  response distinguishable from a transport drop.
- The native sender stages encoded bytes at the client socket. Its queue
  counts only bytes the socket has not accepted; both direct and broadcast
  delivery enforce the browser's post-send limit against that count.
- The `garcon-http` transport test runs the same raw client against Bun
  1.4.3 and a real Hyper listener. It checks exact browser extension
  offers, independently compressed replies, rejection of a message that
  relies on the previous message's deflate dictionary, fragmented and
  oversized inputs, close/pong frames, and terminating a paused client
  during a burst while another remains responsive. The broadcast path
  uses the same budget and is covered separately at the delivery layer.

## Traps

Observed with a small Bun 1.4.3 server using the original's upgrade shape and
transport options, with reduced limits where noted. The refused-upgrade
client check explicitly compares versions. HTTP errors below refer to the
probe's application, which used the controller's plain-text fallback.

| Input | Original runtime result |
| --- | --- |
| Protocol offer `garcon-auth.abc, garcon-v1`, explicit response `garcon-v1` | 101 selects `garcon-v1`. Without an explicit response the probe selected `garcon-v1` for that offer, but selected `garcon-auth.abc` for its single-token offer. Do not infer a general selection rule from these inputs. |
| Version 12 or missing version; valid version with no key | First two return 426 with `Sec-WebSocket-Version: 13` and empty body. Missing key returns false from upgrade and the app returns 400 `WebSocket upgrade failed`. |
| Client WebSocket upgrade refused with HTTP 401 | No open event; Bun 1.4.3 reports close 1002, `Expected 101 status code`, while 1.4.5 reports 1006 with no reason. This is a client event, not a close frame sent by the HTTP server. |
| Offer `permessage-deflate; client_max_window_bits=12` | Negotiates `permessage-deflate; client_no_context_takeover; server_no_context_takeover`. |
| HTTP/1.1 upgrade without `Connection`, or with `Connection: keep-alive` | Bun upgrades; the native listener preserves this. |
| HTTP/1.0 GET upgrade with a valid key and version | Bun upgrades. Native returns plain 400 `WebSocket upgrade failed` because Hyper only hands off HTTP/1.1 upgrades. RFC 6455 requires HTTP/1.1 or higher for an opening handshake; manager-approved 2026-11-28 under ADR-028. The transport test covers this unrecorded difference. |
| Limit 1024, text of 1024 or 1025 bytes; fragmented text 600 + 600 bytes | 1024 delivered. 1025 and 600 + 600 end the transport without a close frame or message callback. |
| Limit 1024, negotiated compressed text inflating to 1024 or 1025 bytes | 1024 delivered; 1025 ends the transport without a close frame. Count inflated bytes too. |
| Valid binary containing bytes `66 80 6f` vs. the same bytes as text | Binary delivered unchanged; invalid text ends the transport without a close frame. |
| Ping payload `abc`; send `ping("px")` from the server | First yields pong with `abc`; second returns 2 and emits a ping with `px`. |
| Silent client, 8 s idle, automatic pings enabled | Empty ping around 4 s, transport closes around 8 s with local callback 1006 and `WebSocket timed out from inactivity`. Sending pings each second without a pong kept the connection open through 34 s. At 14 s, first ping was around 12 s and cutoff around 16 s, consistent with timer rounding. |
| `close(4001, "AUTH_REVOKED")` vs. `terminate()` on an open socket | First sends the named close frame and invokes the local callback immediately. Terminate sends no close frame and invokes the callback with 1006 and an empty reason. |
| Native limit 4096, paused reader, burst of 6000 messages of 1000 bytes each | Immediate sends return 1000, queued sends return -1, rejected sends return 0. With close-on-limit true, transport closes; false drains and remains open when the reader resumes. The transition index depends on the socket, not a fixed message count. |
| Subscribe twice to one topic, unsubscribe twice; publish on a server with no subscribers | Subscribe returns true both times, unsubscribe returns true then false, server publish returns 0. |

## Sources

- Bun [WebSocket API](https://bun.com/docs/runtime/http/websockets);
  installed `bun-types@1.4.3/serve.d.ts` (`ServerWebSocket`, `WebSocketHandler`).
- Bun 1.4.3 vendored uWebSockets:
  [upgrade and option plumbing](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-uws/src/App.h),
  [receive, drain and timeout](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-uws/src/WebSocketContext.h),
  [timeout split](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-uws/src/WebSocketContextData.h),
  [compression negotiation](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-uws/src/PerMessageDeflate.h),
  and [uSockets timer sweep](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-usockets/src/loop.c).
- [hyper upgrade](https://docs.rs/hyper/1.13.0/hyper/upgrade/),
  [tokio-tungstenite stream](https://docs.rs/tokio-tungstenite/0.27.0/tokio_tungstenite/struct.WebSocketStream.html),
  [tungstenite protocol config and frame handling](https://docs.rs/tungstenite/0.27.0/src/tungstenite/protocol/mod.rs.html),
  [tungstenite 0.30 features](https://docs.rs/crate/tungstenite/0.30.0/features),
  [soketto 0.8.1 connection](https://docs.rs/soketto/0.8.1/src/soketto/connection.rs.html),
  [yawc 0.5.0 raw stream](https://docs.rs/yawc/0.5.0/yawc/struct.WebSocket.html#method.from_stream_with_extensions).
