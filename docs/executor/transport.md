# Executor Transport

Current implementation reference, 2026-09-30. This supersedes the transport
descriptions in the historical [first-stage](./interface.md) and
[second-stage](./app-integration.md) designs.

Local remains available alongside configured remote executors. Each remote uses
one bidirectional Noise-encrypted WebSocket, regardless of which side dials.
The shared secret authenticates Noise and the application handshake binding
executor, runtime, version, and the fresh connection. The version is the
package version followed by the executor protocol revision, as in
`0.3.4+protocol.2`. The revision changes with anything either side sends or
accepts, so builds that disagree fail the handshake with "Executor version
mismatch" instead of failing mid-session. TLS is required outside explicit
development mode; Noise remains mandatory when outer TLS certificate
verification is disabled. After losing a session, the dialing side redials at
once, then after 5 and 5 seconds, five times after 10 seconds, and every 30
seconds after that, VS Code Remote's reconnection delays. A session that stayed
up for 10 seconds restarts them, so a peer that drops each session right after
it opens is backed off.

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
The transport has no receipts, replay buffers, or resumption handshakes, and
any connection loss retires the session. Producer notifications, launch
outcomes, and journaled RPC replies resume across sessions one layer up; see
Disconnected Turns and Calls Across Reconnects.

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
connection. A journaled compensation call that session loses is reconciled with
the same worker instance like any other journaled call. A cancelled preparation
has no controller decision to commit;
once dispatched, its native step runs without the RPC cancellation signal so
it can return the resource needed for compensation. Pre-dispatch cancellation
still rejects admission. Uncertain commit results are not rolled back
automatically. Other cancelled calls release their slots immediately.
Start, resume, and compaction have no implicit RPC deadline. Native admission can
be slow, and some providers return a compaction handle only after the turn ends.
Explicit caller deadlines and Stop still cancel these calls; losing the session
does not cancel a launch the worker is running.

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
chunked result transfers.

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
running chats, as `reconnecting`. Active runs stay active. Calls made meanwhile
wait for the replacement session; see Calls Across Reconnects. A permission
answer waits at most 20 seconds, so the browser gets a reply, and one that could
not be sent stays actionable. Admitting a new turn still requires a ready
executor, and queued turns wait for it. A turn admitted before the loss
continues its setup on the replacement session. A setup step that is safe to
repeat runs again if the lost session left its outcome unknown: endpoint
validation, file mention resolution, and the carryover compaction query, which
are read-only, and producer binding, with a fresh binding ID. Stop, deletion,
and shutdown cancel a held turn. Stop is recorded and delivered once the
executor is ready again. While installing a replacement session, the controller
calls `producers.resume` with each binding's last received sequence number. The
worker then resends the newer retained frames, paced like live output, so the
tail of a large replay follows the reply. The controller ignores numbers it
already has, so each notification reaches the ledger sink once. A skipped
number means dropped output and records one notice on the active run: "Some
agent output could not be delivered from the executor. Reload from native
history after this turn finishes to recover it."

A row batch the controller cannot decode is logged and counts as undelivered
output; consecutive undecodable batches record one notice with the same text.
Any other event it cannot read, such as a permission request or a launch
outcome, leaves its run's state unknown. It is logged, the run fails with
`OUTCOME_UNKNOWN`, and the binding closes through the session that holds it,
which stops the native turn. A resume report the controller cannot read fails
its binding the same way. None of these retire the session: that would
interrupt every binding the session carries, and a failure that recurs on
replayed events would retire each replacement session in turn. A controller
consumer that throws on an event is logged, and the other consumers still
receive it.

A start, resume, or compaction whose reply was lost with its session leaves its
run active instead of failing the turn, and a launch the worker is running when
its session is lost keeps running. The worker's relay records each binding's
latest launch until its run ends or it fails, and the runs of the latest eight
launches it received, before running them. The resume reply reports both with
the sequence number the binding's replay ends at; the relay keeps that frame
when pressure drops older rows. A launch that settles after its session was lost
publishes its outcome on the binding instead: its handle, or its own failure,
since losing the session does not cancel it. A nested call the loss cuts off,
such as a credential read from the controller, fails the launch with its own
error. A launch cancelled before it started reports the dispatch failure below.
Once the replay reaches that sequence number, the controller settles every
launch whose reply it had lost when it requested the resume: a run the worker is
executing keeps a reachable handle, so Stop reaches it, and a Stop pressed
during the gap aborts it. A launch the worker never received is sent again once
on the new session, with the same run ID and admission signal, and settles the
same way. A launch the worker received that left no record failed before its
reply was lost; it, and a relaunch that is lost as well, fail as a dispatch
failure: "The executor connection was lost before this turn started. Send it
again." A launch dispatched on the new session settles through its own reply,
even while the replay is still arriving.

A reply the worker's session queue cannot take, unless the journal holds it
(see Calls Across Reconnects), reaches the controller as an unknown outcome on
a live session: "The executor's reply could not be delivered, so the outcome is
unknown." For a launch, the relay then publishes the outcome on the binding
behind that reply, so a running turn keeps a reachable handle and a failed one
reports its own failure. A launch cancelled by Stop, shutdown, or deletion also
ends with an unknown outcome, but the same action already ends or removes its
run. A launch that fails on the worker reports a definite failure even when a
nested call, such as a credential read, had an unknown outcome; an unknown
credential read fails as "Provider credential could not be read from the
controller. Try again."

A lost call no longer carries its caller's cancellation, so Stop reaches a
launch whose call was lost through the worker's relay: the controller names the
run with `producers.cancelLaunch`, sent on the replacement session if the link is
still down, and the relay cancels its native admission. A launch that finishes
admission after it was cancelled is aborted through its handle. A newer launch
on the same binding likewise cancels an older one still in admission, because
the controller begins another run only after abandoning the previous one.

A binding the worker no longer holds, a restarted worker (new instance ID), or
an expired controller grace falls back to the loss path: the controller fails
the active run with `OUTCOME_UNKNOWN`, closes its transcript binding, and warns:
"Executor disconnected mid-turn. The turn may still be running on the
executor. Reload from native history after it finishes to recover missing
output." A run still in setup, whose launch the controller has not requested,
fails with the dispatch failure instead, since no worker can have begun it.
After its own grace, the worker detaches the binding, drops further
publication, and denies pending or later permissions. That integration rejects
new work for the same chat until its detached turn ends. Reload rejects while
the native session is running. Reload requires a native session reference that
reached the controller before disconnect; an unknown initial launch may not
have one.

A stalled event loop looks like a lost link to its peer. Work proportional to a
whole transcript or native history therefore runs in bounded steps or on a
Worker, and both processes log event-loop stalls of 250 ms or more, with the
heap size and the routes, WebSocket messages, chat tasks, RPC methods, and ledger
operations that were running or finished during the stall. Stepped
work runs in named `EventLoopSteps`, and a step that holds the loop for 50 ms or
more is logged with its operation name (`executor-slow-step` on a worker). Each
closed connection that carried a session is logged with its cause and the
link's running count for that cause (`executor-link-closed` on a worker):
`liveness-timeout`, `socket-closed`, `socket-error`, `protocol-error`,
`record-limit`, `session-retired`, or `local-close`. A record that fails Noise
authentication or framing counts as `protocol-error`, a Noise handshake or
message timeout as `liveness-timeout`, and a transport failure as
`socket-error`; a socket the peer or network closed without an authenticated
close record counts as `socket-closed`. `record-limit` marks a busy long-lived
link that used up Noise's per-key record budget and reconnects with fresh keys.
When known, the log adds the reason: the Noise error code of a connection that
ended without an encrypted close, such as `TRANSPORT_CLOSED` when a tunnel
drops it, or the error that retired the session. A link failure carries the
same code and is logged when it differs from the previous failure, until a
session starts (`executor-unavailable` on a worker). The controller logs a
session whose setup fails with the stage it reached (`describe`,
`start-integrations`, `resume-bindings`, or `activate`) and the session's own
reason rather than the generic loss its pending call reports. A parse error's
message can echo the payload it failed on, so it is logged, and crosses the
link, as `Malformed data`.

Hung detached turns require worker restart. Controller crash leaves execution
state empty on restart; graceful controller shutdown still requests native
abort. Explicit handoff to another provider does not coordinate with detached
work on the old provider.

## Calls Across Reconnects

Calls to a remote executor wait out a reconnect instead of failing, as VS Code
Remote holds requests while it reconnects. `ExecutorManager.requireExecutor`
returns a reconnecting executor whose integrations are known, and a call made
while it reconnects waits for the replacement session of the same worker within
its own deadline and signal. It keeps up to a second of that deadline for the
call itself, and it fails as not dispatched when the executor goes offline, is
disposed, or the deadline passes. Sequences that belong to one session, such as
a history reader's pages, acquire their session once. Closing a binding goes
through the session that holds it. If that session was lost, the close waits for
the replacement, and the worker closes the suspended binding, which no session
owns, without resuming it, so its native turn stops.

Each method has a continuity class, `rpcContinuity` in `rpc-protocol.ts`:

- `session` calls belong to their session: history readers, terminal
  attachments, producer bindings, forks, path-update preparations, lifecycle,
  CLI, and credentials. Losing the session cancels the handler and leaves the
  caller with an uncertain outcome. Compensation for a fork or preparation is
  issued on its session and is then journaled like other calls.
- `launch` calls (start, resume, and compaction) keep running on the worker;
  the producer relay reports their outcomes, as described above.
- `journaled` calls are all others, including Files, Git, projects, catalogs,
  permission answers, abort, steering, single queries, and validation. They
  keep running on the worker, and their replies survive the loss.

Every request carries a per-session sequence number, and the worker records the
highest it received from each recent session, so it can prove that a request
never arrived. The worker's `RpcReplyJournal` outlives sessions: it registers a
journaled call before its handler runs, keeps the encoded reply until the
controller acknowledges it with a batched `reply-ack`, and delivers each reply
through the session that owns the call as that session's queue admits it. Like
VS Code's persistent protocol, it resends what was not acknowledged; unlike it,
only journaled replies are kept, and requests are resent only when proven lost.

The controller parks a journaled call that was pending when its session retired;
its deadline and signal keep running. While installing a replacement session of
the same worker instance, the controller adopts every parked call into the new
session and, ahead of producer resumption, sends `calls.reconcile` with each
call's ID and the session and sequence number it was last sent with. The worker
answers per call: `pending`, whose reply follows on the new session;
`not-received`, which the controller sends again; or `unknown`. Calls of lost
sessions that a reconcile does not name belong to callers that gave up, so the
worker cancels them as those callers' lost cancels would have. Retained replies
are bounded at 64 MiB, dropping the oldest delivered ones first. A dropped reply
that its session still waits for is answered at once with an unknown outcome;
one whose session was lost reconciles as unknown. The worker's 256-request budget
covers running journaled calls of all sessions. Calls that install a session
(description, lifecycle initialization, producer resumption, and
reconciliation) bypass both sides' request budgets, so the calls a session
recovers cannot keep it from installing. A restarted worker, an expired grace,
or a disposed executor leaves parked calls with an unknown outcome.

## Shutdown And Browser Isolation

Shutdown rejects new HTTP and browser-WebSocket admissions with
`SERVER_SHUTTING_DOWN` and closes existing browser sockets before final store
flushes. Existing worker sockets remain open long enough to send native aborts.
Browser payload and outbound-buffer limits are enforced independently of Noise
on the shared listener. The listener's native frame ceiling is the larger of
the configured browser limit and Noise's 65,535-byte frame limit.

Implementation: `server/remote/transport/{websocket-link,session-socket,message-session,rpc,rpc-journal}.ts`,
`server/remote/server/producer-relay.ts`,
`server/remote/client/{executor-client,remote-agent-integration}.ts`,
`server/controller/ws/{server-sockets,primary-delivery}.ts`, and `server/controller/server.ts`.
