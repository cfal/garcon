# Executor Transport

Current implementation reference, 2026-09-28. This supersedes the transport
descriptions in the historical [first-stage](./interface.md) and
[second-stage](./app-integration.md) designs.

Local remains available alongside configured remote executors. Each remote uses
one bidirectional Noise-encrypted WebSocket, regardless of which side dials.
The shared secret authenticates Noise and the application handshake binding
executor, runtime, build version, and the fresh connection. TLS is required
outside explicit development mode; Noise remains mandatory when outer TLS
certificate verification is disabled. The default redial delay is five seconds.

Public connection URLs may use arbitrary paths and query strings. They need not
contain an executor ID or an `/executor` suffix. A reverse proxy must forward
WebSocket upgrades to the internal controller route `/executor/<executor-uuid>`
for executor-initiated connections, or the worker route `/executor` for
controller-initiated connections. The `#secret=...` fragment is removed before
connecting; paths and query strings are forwarded as configured. No additional
controller HTTP routes need to be exposed for the executor connection.

One channel describes the current implementation, not a final topology decision.
Channel splitting remains separate work. Correctness and resource bounds must
stand independently; do not add scheduling, retry, or lifecycle machinery solely
to compensate for sharing a channel.

## Ordering And Bounds

Each authenticated socket owns one session. `MessageSession` is a bounded send
queue: 32 MiB or 4,096 unsent messages, with a 16 MiB encoded message limit.
RPC traffic may fill the whole queue. Producer frames are admitted only while
it holds under 4 MiB and 512 messages, and terminal output only while the
socket is writable and it holds under 2 MiB and 256 messages, so neither can
crowd out RPC replies. Successful socket writes leave the queue immediately.
The transport has no receipts, replay buffers, or resumption handshakes. Any
connection loss retires the session; requests are never automatically resent.
Producer notifications alone resume across sessions, one layer up; see
Disconnected Turns.

Socket backpressure pauses flushing. Encoded messages cross Noise
as binary fragments containing one final-fragment byte followed by at most
32 KiB of UTF-8 bytes. Each fragment fits within one Noise record, so the Noise
assembler exposes authenticated progress even at 12 KiB/s. Reassembly is capped
at 16 MiB per connection. Only complete packets enter the ordered session;
authenticated fragment arrivals
refresh liveness during slow transfers. Small encrypted ping/pong messages can
pass between fragments. This is bounded transport framing, not additional
channels or application scheduling.

RPC requests check both encoded size and remaining queue capacity before admission;
rejection means `not-dispatched`. An oversized reply becomes a small typed
uncertain-result error because its operation may already have executed. Native
history is paged by encoded bytes, at most 1 MiB per page; an individual row
that cannot fit rejects that reader. The controller keeps up to four numbered
`history.next` requests in flight per reader so link latency overlaps reading,
and the worker reads each reader's pages strictly in page order and rejects any
other page. Oversized producer output retires only its captured binding and
fails any active run on that binding; subsequent output cannot turn it into a
false success. Native abort is best effort and manual Reload remains explicit.
Producer output is paced by the worker's relay (see Disconnected Turns), so it
never overflows the shared session.

Outgoing RPCs share a 256-request budget. Locally cancelled starts, resumes,
compactions, native forks, history opens, and project-path preparations retain
their budget slot until a reply arrives or the session retires. A late successful
reply releases the slot and triggers best-effort abort, fork discard, reader
close, or preparation rollback on that same session, never a replacement
connection. A cancelled preparation has no controller decision to commit;
once dispatched, its native step runs without the RPC cancellation signal so
it can return the resource needed for compensation. Pre-dispatch cancellation
still rejects admission. Uncertain commit results are not rolled back
automatically. Other cancelled calls release their slots immediately.
Start, resume, and compaction have no implicit RPC deadline. Native admission can
be slow, and some providers return a compaction handle only after the turn ends.
Explicit caller deadlines, Stop, and session retirement still cancel these calls.

Stop on a returned execution handle cancels that operation's native admission
before requesting native abort. A resume still preparing its native turn must
not start afterward merely because its launch RPC has already returned.

An uncertain or expired permission response retires the exact occurrence's
ephemeral capability and removes its browser control through the existing
ordered transient-feed mutation. The request remains in history; retirement
does not record a successful response, end the run, or permit a retry.

Files use single-request reads/saves up to 4 MiB; base64 bounds JSON expansion.
Git results are limited to 4 MiB of serialized JSON. Oversized operations reject
explicitly; there are no application-level chunk handles, upload staging, or
result-transfer caches.

## Disconnected Turns

One worker process owns one executor ID, its integration instances, and native
agent processes. Deleting and re-adding a controller-connects executor creates a
new ID and requires restarting its worker. The controller rejects an identity
mismatch rather than replacing that worker's still-running native work.
Replacing the socket for the same executor does not stop it.

Producer notifications resume at the application layer, in the manner of
XEP-0198 stream management applied to one message kind rather than to transport
frames. The worker's process-level `ProducerRelay` outlives sessions. It numbers
each binding's notifications from 1 and retains every frame until the
controller acknowledges receiving it with a fire-and-forget `producer-ack`,
batched every 250 ms. Like VS Code's persistent protocol, it keeps one ordered
retransmit queue per binding and resends everything unacknowledged, ahead of
newer output, after a reconnect. VS Code's socket buffers without limit; the
session queue here is bounded, so the relay offers frames in publication order
across bindings and keeps any the session refuses, offering them again as the
queue drains. A replay of any size therefore streams through one session, and a
slow link backs output up in the relay instead of retiring the session.
Retention is bounded at 32 MiB across bindings and chats on the executor.
Under pressure the relay drops the oldest row batches from the largest backlog,
whether or not they were already sent; it never drops session, permission, or
run facts. A lost session suspends its bindings instead of
detaching them, for a 3 h grace in which native publication continues and
pending permissions stay pending; VS Code Remote uses the same grace. A
controller resumes every binding it still holds while installing a session,
so once a newer session starts, bindings it has not resumed expire within
5 minutes, as VS Code shortens its grace once another client connects.

Meanwhile the controller reports the executor, and the processing phase of its
running chats, as `reconnecting`. Active runs stay active. New dispatch and
permission answers fail fast as unavailable, and a permission answer that could
not be delivered stays actionable. Stop is recorded and delivered once the
executor is ready again. While installing a replacement session, the controller
calls `producers.resume` with each binding's last received sequence number. The
worker then resends the newer retained frames, paced like live output, so the
tail of a large replay follows the reply. The controller ignores numbers it
already has, so each notification reaches the ledger sink once. A skipped
number means dropped output and records one notice on the active run: "Some
agent output could not be delivered from the executor. Reload from native
history after this turn finishes to recover it."

A start, resume, or compaction whose reply was lost with its session leaves its
run active instead of failing the turn. The worker's relay records each
binding's latest launch until its run ends or it fails, and the resume reply
reports it with the sequence number the binding's replay ends at; the relay
keeps that frame when pressure drops older rows. A launch that settles after
its session was lost publishes its outcome on the binding instead: its own
failure, or the dispatch failure below when the lost session cancelled it.
Once the replay reaches that sequence number, the controller settles every
launch whose reply it had lost when it requested the resume: a run the worker
is executing keeps a reachable handle, so Stop reaches it, and a Stop pressed
during the gap aborts it; a run the worker never began fails as a dispatch
failure: "The executor connection was lost before this turn started. Send it
again." A launch dispatched on the new session settles through its own reply,
even while the replay is still arriving.

A binding the worker no longer holds, a restarted worker (new instance ID), or
an expired controller grace falls back to the loss path: the controller fails
the active run with `OUTCOME_UNKNOWN`, closes its transcript binding, and warns:
"Executor disconnected mid-turn. The turn may still be running on the
executor. Reload from native history after it finishes to recover missing
output." After its own grace, the worker detaches the binding, drops further
publication, and denies pending or later permissions. That integration rejects
new work for the same chat until its detached turn ends. Reload rejects while
the native session is running. Reload requires a native session reference that
reached the controller before disconnect; an unknown initial launch may not
have one.

A stalled event loop looks like a lost link to its peer. Work proportional to a
whole transcript or native history therefore runs in bounded steps or on a
Worker, and both processes log event-loop stalls of 250 ms or more. Stepped
work runs in named `EventLoopSteps`, and a step that holds the loop for 50 ms or
more is logged with its operation name (`executor-slow-step` on a worker). Each
closed connection that carried a session is logged with its cause and the
link's running count for that cause (`executor-link-closed` on a worker):
`liveness-timeout`, `socket-closed`, `socket-error`, `protocol-error`,
`session-retired`, or `local-close`.

Only producer notifications and launch outcomes resume. Other RPC replies lost
with a session remain uncertain outcomes, and requests are never resent. Hung
detached turns require worker restart. Controller crash leaves execution state
empty on restart; graceful controller shutdown still requests native abort.
Explicit handoff to another provider does not coordinate with detached work on
the old provider.

## Shutdown And Browser Isolation

Shutdown rejects new HTTP and browser-WebSocket admissions with
`SERVER_SHUTTING_DOWN` and closes existing browser sockets before final store
flushes. Existing worker sockets remain open long enough to send native aborts.
Browser payload and outbound-buffer limits are enforced independently of Noise
on the shared listener. The listener's native frame ceiling is the larger of
the configured browser limit and Noise's 65,535-byte frame limit.

Implementation: `server/remote/transport/{websocket-link,session-socket,message-session,rpc}.ts`,
`server/remote/server/producer-relay.ts`,
`server/remote/client/{executor-client,remote-agent-integration}.ts`,
`server/controller/ws/{server-sockets,primary-delivery}.ts`, and `server/controller/server.ts`.
