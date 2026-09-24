# Execution Node Transport

Current implementation reference, 2026-09-24. This supersedes the transport
descriptions in the historical [first-stage](./interface.md) and
[second-stage](./app-integration.md) designs.

Local remains available alongside configured remote nodes. Each remote uses
one bidirectional Noise-encrypted WebSocket, regardless of which side dials.
The shared secret authenticates Noise and the application handshake binding
node, runtime, build version, and the fresh connection. TLS is required
outside explicit development mode; Noise remains mandatory when outer TLS
certificate verification is disabled. The default redial delay is five seconds.

## Ordering And Bounds

Each authenticated socket owns one session. `MessageSession` is a bounded send
queue: 32 MiB or 4,096 unsent messages, with a 16 MiB encoded message limit.
Successful socket writes leave the queue immediately. There are no receipts,
replay buffers, resumption handshakes, or reconnect grace timers. Any connection
loss retires the session; requests are never automatically resent.

Socket backpressure pauses flushing. Encoded messages cross Noise
as binary fragments containing one final-fragment byte followed by at most
256 KiB of UTF-8 bytes. Reassembly is capped at 16 MiB per connection. Only
complete packets enter the ordered session; authenticated fragment arrivals
refresh liveness during slow transfers. Small encrypted ping/pong messages can
pass between fragments. This is bounded transport framing, not additional
channels or application scheduling.

RPC requests check both encoded size and remaining queue capacity before admission;
rejection means `not-dispatched`. An oversized reply becomes a small typed
uncertain-result error because its operation may already have executed. Native
history is paged by encoded bytes; an individual row that cannot fit rejects
that reader. Oversized producer output retires only its captured binding and
fails any active run on that binding; subsequent output cannot turn it into a
false success. Native abort is best effort and manual Reload remains explicit.
Aggregate reliable-publication overflow can still retire the shared session.

Files use single-request reads/saves up to 4 MiB; base64 bounds JSON expansion.
Git results are limited to 4 MiB of serialized JSON. Oversized operations reject
explicitly; there are no application-level chunk handles, upload staging, or
result-transfer caches.

## Disconnected Turns

One worker process owns one node ID, its integration instances, and native
agent processes. Deleting and re-adding a controller-connects node creates a
new ID and requires restarting its worker. The controller rejects an identity
mismatch rather than replacing that worker's still-running native work.
Replacing the socket for the same node does not stop it. The controller fails
its active run with `OUTCOME_UNKNOWN`, closes its transcript binding, and warns:
"Execution node disconnected mid-turn. The turn may still be running on the
execution node. Reload from native history after it finishes to recover missing
output."

The worker detaches the old producer binding, drops further publication, and
denies pending or later permissions. That integration rejects new work for the
same chat until its detached turn ends. Reload rejects while the native session
is running. No gap count, automatic import, reattachment, or resend is promised.
Reload requires a native session reference that reached the controller before
disconnect; an unknown initial launch may not have one.

A Stop that never reached the worker may be lost. Hung detached turns require
worker restart. Controller crash leaves execution state empty on restart;
graceful controller shutdown still requests native abort. Explicit handoff to
another provider does not coordinate with detached work on the old provider.

## Shutdown And Browser Isolation

Shutdown rejects new HTTP and browser-WebSocket admissions with
`SERVER_SHUTTING_DOWN` and closes existing browser sockets before final store
flushes. Existing worker sockets remain open long enough to send native aborts.
Browser payload and outbound-buffer limits are enforced independently of Noise
on the shared listener. The listener's native frame ceiling is the larger of
the configured browser limit and Noise's 65,535-byte frame limit.

Implementation: `server/execution-nodes/{websocket-link,session-socket,message-session,rpc}.ts`,
`server/ws/{server-sockets,primary-delivery}.ts`, and `server/server.ts`.
