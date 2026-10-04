# Executor Transport

Current implementation reference, 2026-10-02. This supersedes the transport
descriptions in the historical [first-stage](./interface.md) and
[second-stage](./app-integration.md) designs.

Local remains available alongside configured remote executors. Each remote uses
two bidirectional Noise-encrypted WebSockets, regardless of which side dials:
an authoritative primary and a subordinate bulk lane. One executor client,
runtime, producer relay, and reply journal serve both lanes.
The shared secret authenticates Noise and the application handshake binding
executor, runtime, version, and the fresh connection. The version is the
package version followed by the executor protocol revision, as in
`0.3.4+protocol.15`. The revision changes with anything either side sends or
accepts, so builds that disagree fail the handshake with "Executor version
mismatch" instead of failing mid-session. TLS is required unless explicitly
disabled with `noTls` (`--no-tls` for workers). Worker listeners require a PEM
`--tls-cert` and `--tls-private-key` pair or `--no-tls`; see the
[operator guide](../cli.md#executor-connections). Noise remains mandatory when outer TLS certificate
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
connecting; both lanes dial the identical configured path and query. Proxies
must permit two concurrent upgrades to that endpoint. No extra public port,
credential, URL role marker, or controller HTTP route is required.

Each link admits at most four sockets, including those still in the encrypted
handshake. When they are all taken, a new connection closes the oldest socket
whose peer has not proven the secret with its first handshake message, or, if
every socket still in the handshake has proven it, the oldest of those. A peer
without the secret cannot prove it, so its sockets are closed first, and it
cannot keep an executor's endpoint full with sockets that never start the
handshake. Only a valid WebSocket upgrade closes a socket this way. Across all
executors, the controller admits 64 established primary sockets, 64 established
bulk sockets, and 64 pending handshakes, with a hard ceiling of 192. Pending
includes the application proof, not just Noise establishment. An authenticated
bulk socket cannot consume primary's quota. Finite handshake pressure can still
deny new connections, and four arrivals before a legitimate peer's first
handshake message can still close that pending socket. These limits are not
general denial-of-service protection.

Executor configuration grants become active only after a confirmed durable write.
If a configuration write is renamed but its directory sync fails, the affected
executor is taken offline, its CLI authority is revoked, and further executor
configuration mutations are blocked until controller restart. The candidate
remains on disk and enumerable for reference accounting; it is not authorization.
Unchanged executors and Local remain available.

## Lanes And Authority

The primary session ID is the connection generation. Both application proofs
bind the lane, executor, peer runtime, protocol version, primary session ID, and
the lane's own session ID. Bulk attaches only to its current authenticated
primary. Possession of the same secret alone cannot attach an old bulk socket
to a replacement primary.

Primary carries launches, Stop/abort, permissions, credentials, producer and
terminal frames, small file identity/revision calls, and `git.getQuickSummary`.
Bulk carries every other Git/GitHub method, file bodies and directory lists,
the complete history reader sequence, and large-capable reverse CLI operations.
The exhaustive routing policy is checked before dispatch on both peers. There
is no size-triggered fallback to primary. Primary CLI context, turn receipts,
Stop, and permission decisions have a 64 KiB encoded request/reply cap, as does
Git quick summary. Oversized reads fail with their domain's size error;
potentially completed CLI mutations fail with `CLI_OUTCOME_UNKNOWN`.

The controller alone coordinates bulk recovery. `bulk-prepare` and
`bulk-prepared` on primary fence both old receivers before authorizing a fresh
bulk session; `bulk-connect` instructs the worker dialer when applicable.
Both new RPC receivers initially admit only recovery traffic. After bulk-scoped
reconciliation, `bulk-activate` and `bulk-active` on primary open ordinary traffic
in both directions. Activation does not wait for recovered handlers or retained
reply bytes. Preparation, handshake, and activation each have a five-second
timeout. Recovery has its own backoff with the primary redial schedule above.
Only successful activation ends a recovery interval; failed attempts cannot
reset its three-hour grace.

Bulk loss leaves primary readiness, turns, permissions, and terminal attachments
unchanged. New bulk calls wait at most 20 seconds for a lane, including when
their execution timeout is null, and consume their existing deadline and signal.
Already-sent journaled calls retain their original deadlines. Primary loss
synchronously fences bulk, its readers, pending handshakes, and retry callbacks
before primary continuity proceeds. A restarted worker cannot inherit either
lane's old calls or resources.

Remote executor snapshots expose secondary `bulk` availability and error fields;
Local has `bulk: null`. Connecting/reconnecting bulk does not change executor
capabilities or primary availability. Files buffers, Git drafts, and selected
targets remain intact; bulk errors do not disable Stop or fall back to Local.

## Ordering And Bounds

Each authenticated socket owns one session. `MessageSession` is a bounded send
queue with a 16 MiB encoded message limit. Both lanes share 32 MiB / 4,096 unsent
messages; bulk may use at most 24 MiB / 3,072. Ordinary traffic leaves 32 KiB /
four messages for typed primary bulk-lifecycle controls. Refused lifecycle and
producer/terminal offers do not close primary; the bounded lifecycle outbox
retries on capacity progress. This is admission reservation, not packet preemption.
Producer frames are admitted only while
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
refresh that lane's liveness during slow transfers. Activity on primary cannot
keep silent bulk alive, or vice versa. Small encrypted ping/pong messages can
pass between fragments. Queues exclude socket buffers, the two 16 MiB
reassemblers, parsed values, and retained replies; they are not a total heap cap.

RPC requests check both encoded size and remaining queue capacity before admission;
rejection means `not-dispatched`. An oversized reply becomes a small typed
uncertain-result error because its operation may already have executed. Native
history is paged toward a 1 MiB target; an individual larger row travels alone
within the 16 MiB packet ceiling. The controller keeps up to four numbered
`history.next` requests in flight per reader so link latency overlaps reading,
and the worker reads each reader's pages strictly in page order and rejects any
other page. A reader is scoped to its opening bulk session, with 16 readers per
integration and a 120-second idle timeout. Bulk loss closes its iterators and
rejects queued or late pages, without tearing down primary runtime service.
History never silently restarts on a replacement. Native fork creation and
discard remain primary; admission, bulk seed import, and compensation retain
the originating runtime instance in ephemeral context, including fork-run retries.
Fork-run preparation retains unresolved native cleanup when creation fails after
target registration; successful discard is not repeated by its rollback.
Pre-registration cleanup remains best effort.
A replacement primary may clean up only on that same worker instance.
Oversized producer output retires only its captured binding and
fails any active run on that binding; subsequent output cannot turn it into a
false success. Native abort is best effort and manual Reload remains explicit.
Producer output is paced by the worker's relay (see Disconnected Turns), so it
never overflows the shared session.

Outgoing RPCs share a 256-request budget, of which bulk may use 192. Incoming
work has an independent budget with the same reservation. Connection waiters,
parked calls, and unsettled handlers retain their leases across lane and primary
replacement. Cancellation does not release native admission before settlement.
Locally cancelled starts, resumes,
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
answer waits at most 20 seconds, even if a caller requests a longer timeout;
shorter caller timeouts are preserved. Both peers use the shared reconnect grace
in `server/remote/transport/limits.ts`. The browser gets a reply, and one that could
not be sent stays actionable. Admitting a new turn still requires a ready
executor, and queued turns wait for it. A turn admitted before the loss
continues its setup on the replacement session. A setup step that is safe to
repeat runs again if the lost session left its outcome unknown: endpoint
validation, file mention resolution, and the carryover compaction query, which
are read-only, and producer binding, with a fresh binding ID. Stop, deletion,
and shutdown cancel a held turn. A new chat's start holds its chat's lock
through setup, so Stop and deletion wait behind it until it gives up at its
interactive deadline; see Calls Across Reconnects. Stop is recorded and
delivered once the executor is ready again. While installing a replacement
session, the controller calls `producers.resume` with each binding's last
received sequence number. The
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

A reply the worker's session queue cannot take, unless the journal holds it (see
Calls Across Reconnects), reaches the controller as an unknown outcome on a live
session: "The executor's reply could not be delivered, so the outcome is
unknown." For a launch, the relay then publishes the outcome on the binding
behind that reply, so a running turn keeps a reachable handle and a failed one
reports its own failure. A launch cancelled by Stop, shutdown, or deletion also
ends with an unknown outcome, but the same action already ends or removes its
run. A launch that fails on the worker reports a definite failure even when a
nested call, such as a credential read, had an unknown outcome; a credential
read whose outcome is unknown, or that never reached the controller, fails as
"Provider credential could not be read from the controller. Try again."

A lost call no longer carries its caller's cancellation, so Stop reaches a
launch whose call was lost through the worker's relay: the controller names the
run with `producers.cancelLaunch`, which waits for the replacement session
without a deadline, and the relay cancels its native admission. A launch that
finishes admission after it was cancelled is aborted through its handle. When
Stop cancels a launch call on a live session, a turn that starts anyway is
aborted through the call's late reply; if that session is lost before the reply
arrives, the controller records the launch as unsettled, never sends it again,
and sends `producers.cancelLaunch` on the replacement session, whose resume
report gives the router the handle to stop. A newer launch on the same binding
likewise cancels an older one still in admission, because the controller begins
another run only after abandoning the previous one.

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
authentication or framing counts as `protocol-error`, a message whose remaining
records stop arriving as `liveness-timeout`, and a transport failure or a full
socket buffer as `socket-error`; a socket the peer or network closed without an
authenticated close record counts as `socket-closed`. `record-limit` marks a
busy long-lived link that used up Noise's per-key record budget and reconnects
with fresh keys. A Noise handshake that fails or times out ends its connection
before any session, so it appears only as a link failure. When known, the log
adds the reason: the Noise error code of a connection that ended without an
encrypted close, such as `TRANSPORT_CLOSED` when a tunnel drops it, or the
error that retired the session. A link failure carries the same code, or the
reason a peer that holds the secret failed to authenticate or lost its
connection, and counts the failures of its kind since the last session
started, from one again when its message or reason changes. Logs keep the
failures whose count is 1, 2, 4, 8, ... (`executor-unavailable` on a worker).
A peer without the secret causes only encrypted-connection failures, whose
message is fixed for each Noise error code, so it cannot flood logs by failing
repeatedly or by alternating between failures. Until the executor has an
established session, the controller shows each failure, with its reason when it
has one, as the executor's last error and notifies clients when that error
changes: at once, then at most once a second with the latest error. Once it has
one, failures of other connections are only logged, even while a configuration
change or the session's preparation keeps the executor from ready, and losing
its own session makes the closure's reason its error, unless setup already
reported why it closed the session. The controller logs a session whose setup
fails with the stage it reached (`describe`, `start-integrations`,
`resume-bindings`, or `activate`) and the session's own reason rather than the
generic loss its pending call reports. A parse error's message can echo the
payload it failed on, so the error reply for a parse error that a handler
throws carries it only as `Malformed data`, as does the report of a launch
whose error reply was lost, and the side whose handler threw logs the call ID,
integration, and method. An integration that wraps a parse error in its own
failure passes that failure's message on, so parse failures that can reach
callers name what failed instead. Logs describe a parse error as `Malformed
data` with the nearest source location its stack kept, if any. A frame that
fails to parse is named instead: `Malformed executor RPC frame` or `Malformed
executor handshake frame`.

Closure and setup diagnostics include lane and parent/session IDs, setup phase,
retry counts, aggregate/per-lane queue bytes and oldest age, and incoming/outgoing
ordinary call counts. Bulk failures are deduplicated independently of primary.
Listener failures before a valid peer hello have no known lane. They remain
logged and visible for offline onboarding, but cannot replace a primary
reconnect error. A new primary resets their diagnostic counters; bulk does not.
Diagnostics never include connection query strings, credentials, or payloads.
Isolation does not remove CPU, disk, subprocess, or shared network contention;
primary producer/prompt traffic can still delay primary controls.

Hung detached turns require worker restart. Controller crash leaves execution
state empty on restart; graceful controller shutdown still requests native
abort, best effort: an executor that is reconnecting when shutdown begins does
not receive it, because shutdown stops redialing first, and its turns continue
detached. Explicit handoff to another provider does not coordinate with detached
work on the old provider.

## Calls Across Reconnects

Calls to a remote executor wait out a reconnect instead of failing, as VS Code
Remote holds requests while it reconnects. `ExecutorManager.requireExecutor`
returns a reconnecting executor whose integrations are known, and a call made
while it reconnects waits for the replacement session of the same worker within
its own deadline and signal. It keeps up to a second of that deadline for the
call itself, and it fails as not dispatched when the executor goes offline, is
disposed, or the deadline passes. A call made through `RemoteSessions.call` or
`send` whose session retires before it is sent is sent on the next session of
the same worker within that deadline. Calls that acquire their session
themselves, such as Git, GitHub, terminal, producer-binding, fork,
path-preparation, and history-reader calls, fail as not dispatched instead.
Sequences that belong to one session, such as a history reader's pages, acquire
their session once. Closing a binding goes through the session that holds it and
waits without a deadline, until the worker answers, the executor goes offline,
or the client is disposed. If that session was lost, the replacement session of
the same worker closes the suspended binding, which no session owns, without
resuming it, so its native turn stops; a restarted worker never receives it.

Interactive operations that hold a chat's lock or its queue-control lock wait
for a reconnecting executor for at most 20 seconds
(`INTERACTIVE_EXECUTOR_WAIT_MS` in `server/common/interactive-deadline.ts`).
Browsers give each request 30 seconds, so the server answers first, and a Stop
or deletion queued behind the lock still completes. The operation's deadline
starts when it asks for the lock, so operations queued behind a long wait give
up in turn, and all of the operation's calls share it. A call passes it as
`dispatchDeadline`: a call not yet sent fails as not dispatched at the
deadline, and a sent journaled call whose session is lost stops waiting for a
replacement session to reconcile it then, with an unknown outcome, or as not
dispatched if the reconciliation shows that the worker never received it; it is
never sent again after the deadline. A read-only call, such as a
validation, a project inspection, or a catalog read, may run until 5 seconds
past the deadline once sent, so a read sent late still gets time to answer, and
all of the operation's reads end by then. A sent mutation or launch otherwise
keeps its own deadline, because native startup can take longer. Settings
changes, submits, queue creation, compaction scheduling, handoff preflight,
permission answers, inter-agent messages, and steering follow this rule; a
steer's capture and delivery share one deadline. So does a new chat's start,
which holds its chat's lock through dispatch: if the executor has not
reconnected by the deadline, the start fails as not dispatched, its chat is
rolled back, and the user sends it again. A start or resume that an agent
command requests takes its deadline when it asks for the requesting chat's
lock, and a delegated start dispatches after releasing it. A scheduled prompt
sends through the same locked paths after claiming its occurrence, so an
occurrence that cannot reach a reconnecting executor in time fails, is recorded
in the run log, and is not retried. Queued turns, the
queue drain's admission check, chat-ID disclosures, and replies to agent
commands run without one, so they keep waiting within their own deadlines. Some
lock holders do not follow the rule yet and wait within their own deadlines
and, where the route passes one, the request's signal: forks and fork runs'
native forks, project-path updates, Reload, handoff carryover compaction, and
adopting a chat created before the transcript ledger. A new chat adopts without
calling its executor. A turn's preparation, such as a fork run's native fork or
a handoff's carryover compaction, does not count against the deadline of the
admission check after it; if the deadline ran out before the preparation began,
the check does not wait for a reconnecting executor, and a read it sends still
gets its 5 seconds.

Each method has a continuity class, `rpcContinuity` in `rpc-protocol.ts`:

RPC errors validate their domain and error code before entering application
code. Unknown domains and unknown provider error codes retire the malformed
session rather than introducing values outside the typed error contract.

- `session` calls belong to their session: history readers, terminal
  attachments, binding and resuming producer bindings, forks, path-update
  preparations, lifecycle, CLI, and credentials. Losing the session cancels the
  handler and leaves the caller with an uncertain outcome. Cleanup of a resource
  that outlives its session is issued on its session and journaled:
  compensation for a fork or preparation, and closing a producer binding.
- `launch` calls (start, resume, and compaction) keep running on the worker;
  the producer relay reports their outcomes, as described above.
- `journaled` calls are all others, including Files, Git, projects, catalogs,
  permission answers, abort, steering, single queries, and validation. They
  keep running on the worker, and their replies survive the loss.

Every request carries a per-session sequence number, and the worker records the
highest it received from each recent lane session, so it can prove that a request
never arrived. Receipt histories retain 16 sessions per lane; equal sequence
numbers across sockets are unrelated. The worker's `RpcReplyJournal` outlives sessions: it registers a
journaled call before its handler runs, keeps the encoded reply until the
controller acknowledges it with a batched `reply-ack`, and delivers each reply
through the session that owns the call as that session's queue admits it. Like
VS Code's persistent protocol, it resends what was not acknowledged; unlike it,
only journaled replies are kept, and requests are resent only when proven lost.

The controller parks a journaled call that was pending when its session retired;
its deadline and signal keep running. While installing a replacement session of
the same worker instance, the controller adopts every parked call into the new
lane session and sends `calls.reconcile` with each
call's ID and the session and sequence number it was last sent with. The worker
answers per call: `pending`, whose reply follows on the new session;
`not-received`, which the controller sends again; or `unknown`. A call whose
dispatch deadline passes while it is reconciled is not sent again: it stops
waiting with an unknown outcome and is cancelled on the worker, or, when the
worker's late answer already shows that it never received the call, fails as
not dispatched. Calls of lost
sessions that a reconcile does not name belong to callers that gave up, so the
worker cancels them as those callers' lost cancels would have, only within that
lane. Primary reconciliation precedes producer resumption and does not wait for
bulk. Bulk reconciliation follows explicit predecessor fencing. Cancellation,
reply ACKs, receipt proofs, and journal adoption cannot cross lane ownership.
Blocked bulk journal delivery does not block primary's delivery pass.
Retained replies are bounded at 64 MiB, with bulk capped at 48 MiB, dropping the
oldest delivered ones first within the affected budget. A dropped reply
that its session still waits for is answered at once with an unknown outcome;
one whose session was lost reconciles as unknown. The worker's shared request budget
covers running journaled calls of all sessions and both lanes. Calls that install a session
(description, lifecycle initialization, producer resumption, and
reconciliation) have a bounded admission exemption, so the calls a session
recovers cannot keep it from installing. Only one reconciliation is allowed per
lane session, with at most 64 distinct primary installation method/integration
pairs exempted; setup never bypasses byte budgets. A restarted worker, an expired grace,
or a disposed executor leaves parked calls with an unknown outcome.

## Shutdown And Browser Isolation

Shutdown rejects new HTTP and browser-WebSocket admissions with
`SERVER_SHUTTING_DOWN` and closes existing browser sockets before final store
flushes. Existing worker sockets remain open long enough to send native aborts.
Browser payload and outbound-buffer limits are enforced independently of Noise
on the shared listener. The listener's native frame ceiling is the larger of
the configured browser limit and Noise's 65,535-byte frame limit.

Implementation: `server/remote/transport/{websocket-link,bulk-connection,rpc-connection,session-socket,message-session,rpc,rpc-journal}.ts`,
`server/remote/server/producer-relay.ts`,
`server/remote/client/{executor-client,remote-agent-integration}.ts`,
`server/controller/ws/{server-sockets,primary-delivery}.ts`, and `server/controller/server.ts`.
