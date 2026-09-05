# Garcon Transcript Ledger V5: Core-Owned Append-Only Authority

Status: revision 34 integrated design. Supersedes
`AGENT_OWNED_TRANSCRIPT_PROJECTION_DESIGN.md`
(V4, SHA-256 `12e6efbcbd30419c0b4580d8159f60e2b1948d8dd790857a070dee5b3f6873cf`),
which remains untouched as the historical record of the reconciliation-based
architecture and its implementation through commit `f029424c`.

Revision 34 prevents native-history persistence lag from deleting the only
receipt evidence for a completed preamble turn. A provider-origin `run-ended`
after the application input and before the next ordinary non-steer input makes
one native occurrence of that receipt signature mandatory; intervening steers
remain part of the same turn. If the normalized native history has fewer
matching occurrences than completed applications, Reload fails retryably with
`HISTORY_LOAD_FAILED` before cutover and native-fidelity target creation
aborts. Evidence without provider-completion proof remains valid for the
commit-before-dispatch crash window. Identical prefixes remain intentionally
indistinguishable and are counted by receipt signature.

Revision 33 defines preamble receipt SHA-256 over the exact JavaScript UTF-16
code units of the complete prefix, serialized as unsigned 16-bit little-endian
values. Receipt creation and native sanitation use one shared helper. This
prevents UTF-8 encoding from replacing lone surrogates with U+FFFD and making
distinct same-length prefixes share a receipt; the frame and receipt shape
remain version one.

Revision 32 adds target-chat substitution to preamble bodies. At boundary
composition, core expands the shared `{{chat_id}}` token to the target chat's
16-digit ID, turns `\{{chat_id}}` into the literal token, and leaves unsupported
variables unchanged. Catalog validation renders every candidate with a fixed
16-digit sample before enforcing the combined limit. The catalog retains the
authored template, the receipt covers the exact expanded prefix, and neither
form enters the ledger. The preamble editor documents the supported token in
an accessible legend below its text composer.

Revision 31 removes the per-application identifier from the version-one
preamble frame and its private receipt. Exact `codeUnitLength` and SHA-256
remain sufficient proof of the complete prefix. Native sanitation matches
each framed message to the sole matching receipt signature and then the
earliest unused exact receipt in ledger order;
identical prefixes are intentionally indistinguishable and consume identical
evidence in that order. At that revision, missing native occurrences remained
valid crash-window evidence, while a malformed frame, an unmatched exact
prefix, more native
occurrences than matching receipts, or more than one distinct matching
receipt signature fails closed.

Revision 30 adds provider-neutral preamble applications. A durable pending
boundary on a new chat, fork, continuation, or in-place agent switch is
consumed by the first ordinary input. When enabled catalog entries match,
core commits one typed title-only application notice immediately before the
visible user input in the same SQLite transaction, keeps the rendered body
only in the transient provider prompt, and stores a private exact prefix
receipt on the input. Reload and native-fidelity fork sanitize the normalized
native history by that authoritative receipt and reconstruct the notice;
unknown or changed recognizable frames fail closed. Provider integrations
still receive one opaque prompt and require no preamble-specific contract or
implementation.

Revision 29 removes completed-attempt deduplication by emitting run from
chat-ID discovery. A later request becomes eligible after the prior delivery
settles even when both markers belong to one long-lived provider turn, as can
happen across multiple compactions. Run identity remains delivery-routing
correlation, not request identity; only the per-chat in-flight gate and the
view-scoped control-turn recursion fence suppress markers. Request storage,
delivery routing, and outcome semantics otherwise remain unchanged.

Revision 28 keeps revision 27's single visible discovery outcome while
restoring the request marker as one ledger-private hidden notice. The cleaned
assistant remainder, when present, and `{type: 'chat-id-request'}` support row
commit atomically at the marker timestamp before delivery starts. The shared
presentation boundary drops that row, and every conversational fold already
excludes notices; native import reconstructs it without redispatching. It is
therefore durable provider evidence without becoming a second visible row,
model input, queue entry, share/export entry, or public message contract. The
native-activity predicate returns exactly to revision 26: request, disclosure,
and disabled notices qualify while generic delivery failures do not; probe
scheduling remains activation-only and is unchanged.

Control delivery now captures only the emitting run, steers it once, and
falls back only after definitive non-delivery and settlement of that exact
attempt. Fallback makes one direct server-control reservation and sends the
disclosure envelope without admitting a user input. Ambiguous delivery is
terminal because it cannot authorize duplication. There is no retry,
successor retarget, route watcher, priority queue, or discovery-specific
execution notification. The visible success notice is the sole transcript
representation of accepted disclosure; the control turn's processing and
provider output retain ordinary lifecycle behavior. Unsupported steering is a
fallback trigger rather than a terminal discovery outcome.

Revision 27 collapses chat-ID discovery into one outcome notice and adds a
hidden new-turn fallback. Core still strips the exact assistant marker before
storage, but stores no request notice. Delivery first targets the active turn;
definitive steering state changes fall back to a direct turn carrying only the
disclosure envelope, using the same three-attempt run/steer alternation as
`garcon-cli send-async --allow-steer`. Server control accepts a deliberately
wider set of definitive non-delivery outcomes because it has no committed user
row to reuse. A definitive steer rejection waits for
that captured execution attempt to settle before selecting the next route.
Neither route creates a `user-input` row
or queue entry. Acceptance of either route immediately appends one success
notice and returns; later turn failure remains ordinary provider/run history.
Disabled, unsupported, and unavailable-route outcomes each append one typed
error notice. Native import drops request markers and reconstructs an exact
hidden disclosure input as the single success notice.
The hidden turn's identity remains a recursion fence for its view: its own
markers and later markers with no active-run attribution are suppressed until
view replacement or deletion. When no discovery delivery is pending, markers
correlated to a different run remain eligible.

Revision 26 adds provider-neutral chat-ID auto-discovery as a core
canonicalization and control-steering rule. An assistant message beginning
exactly with `<garcon-get-chat-id />` has that prefix removed before storage;
the cleaned provider row and a typed request notice commit together. When the
default-enabled remote setting is enabled, core synchronously captures the
emitting run's active steering target and starts one provider-only steer carrying
`<garcon-chat-id>{chatId}</garcon-chat-id>`. This control creates no
`user-input`, queue entry, next-turn latch, or prompt decoration. Delivery
completion appends a typed success or failure notice, and repeated requests in
one run dispatch only once. Disabled requests still remove the marker and append
a typed error notice but dispatch nothing. Native import canonicalizes request
markers and exact synthetic disclosure inputs back into notices so Reload and
native forks never expose server control as user-authored conversation.

Revision 25 makes enabled transcript search a second explicit genesis-adoption
occasion alongside first open. Search maintenance probes current-view
existence without creating ledger files, adopts registered legacy chats
sequentially through the sole `TranscriptAdoptionService` owner under the
existing 50% ingest duty cycle, and never adopts or probes missing views from a
query request. Status distinguishes the total registry population from
indexed, pending, failed, and still-unindexed chats, so partial coverage cannot
look complete. HTTP cancellation reaches the fixed reader pool; because each
reader runs synchronous SQLite work, an abandoned request quarantines and
replaces that one Worker while its peer remains available. Each structured
query clause materializes at most 10,000 newest matching derived rows and sets
`resultsTruncated` when a successor exists, making broad-prefix cost bounded
and its sampled-result semantics visible instead of widening the deadline.

Revision 24 makes ordinary export artifacts transcript-first. Both renderers
retain durable ordinals and the role or typed entry shape, but omit repeated
per-entry timestamps and semantic categories because ordinal order and the
heading or XML tag already carry the information needed to follow the chat.
Markdown uses one compact identity line and, only when rows were removed, one
omission summary. XML keeps minimal chat identity, omits capture and requested
exclusion metadata, and includes one compact `<omitted .../>` element with
positive counts in canonical category order only when rows were removed. The
revision supersedes revision 23's artifact-level disclosure: the authenticated
typed response remains the machine contract for the pinned view, canonical
exclusions, and omitted counts. Transport-only user message identity and
CLI-row provenance are not rendered; compact CLI-authored presentation labels
remain because they distinguish operator notices and errors from ordinary
prompts.

Revision 23 adds an authenticated ordinary user-export surface over the
authoritative ledger. Export captures one pinned current-view watermark,
projects every row required by the section 9 Export column, preserves durable
ordinals, excludes support-only `session` rows and `providerMeta` by
construction, and renders Markdown or XML on the server. Optional semantic
filters may remove tool calls, tool results, reasoning, permissions,
diagnostics, or handoffs; user and assistant content, compaction summaries,
and carryover-quarantine disclosures form a non-excludable spine. Every
artifact records its canonical exclusions and omitted counts. The bounded
`status --messages` operational snapshot and the persisted public Share
artifact remain separate surfaces.

Revision 22 reconciles presentation-only transcript rows across core,
integrations, and shared rendering. The already-shipped `add-row` surface
appends a durable core-owned notice or error without creating agent work; both
forms, plus integration-emitted `ErrorMessage` rows, render and enter share
snapshots and export but never search, preview, model context, resend
boundaries, carryover, or fork seeds. An integration may also publish one
narrow advisory: a nonblank `notice` for its active `runId`. Core drops
stale-run and blank events, strips the ephemeral correlation, and commits an
ordinary durable `notice` row. This reports a provider-owned wait; it is not a
retry, status, acknowledgement, or control protocol. OpenCode uses it to
surface each distinct upstream retry schedule while the owning turn remains
active. Rendered notices and errors now carry their optional title in one
top-level `title` field; CLI detail is provenance only.

Revision 21 adds OpenCode to the native-fidelity fork providers. Upstream V1
forks a session server-side at an exclusive message boundary, so the facet
resolves the anchor row's `providerMeta` identity to the first message to
exclude and forks the tip when the anchor message is last; an identity the
provider has not persisted refuses with the standard not-settled error, and
discard deletes the forked provider session. The boundary is
message-granular: a mid-message anchor includes the anchor message's
trailing parts, and the fork's feed is the forked session's native record,
as section 12.3 already requires.

Revision 20 corrects two OpenCode notes against shipped behavior. Legacy
absence: a chat that records no native session is the only positive legacy
absence; a recorded session the provider cannot return within scope — missing
or outside the recorded directory — fails genesis adoption with the ordinary
retryable typed error and creates no view, because a production store
replacement showed the previous scoped-NotFound-is-absence rule committing a
permanent false-empty view, the outcome Decision 11 forbids. Restoring the
source lets a later open import the real history. Compaction: the repair
landed as #529 supersedes revision 19's disable — pinned V1 automatic
compaction runs with marker-part routing that adopts OpenCode's marked
control and continuation parts into the owning turn's route, and a
successful overflow summary continues the turn; session-latest routing
remains deleted.

Revision 19 makes native drift detection activation-only and transient. A
successful active newest-history load returns before scheduling one bounded
probe. Older pages, replay continuations, background reads, provider dispatch,
timers, and startup never schedule it. Equal in-flight checks coalesce; a
changed agent, view, session row, native reference, or provider watermark
aborts and supersedes the pending check, and every result revalidates that
exact key plus execution ownership. A newer native tail emits only a
process-lifetime `chat-operational-notice`. The durable drift notice, its
Reload action and warning watermark, completed-result policy, and ineffective
pre-resume hook are deleted. Explicit manual Reload remains the sole
reconciliation path.

Revision 18 records the final stabilization corrections. Permission history
has one integration-generated occurrence UUID, named
`permissionOccurrenceId` at every live/shared boundary; provider-native
request IDs remain integration-private, and possession of the exact live
response capability is the authority. Ledger schema version 1 keeps its
durable JSON key `incarnation`; the ledger codec alone translates that key,
so existing rows require no rewrite. A permission event without its concrete
operation is logged and dropped rather than assigned synthetic correlation.

Pre-V5 history migration is now a distinct nullable
`legacyHistoryImport` capability, explicitly declared by every integration
and consumed only by genesis adoption. It never falls back to or grants
`nativeHistoryImport`, which remains the native-session import capability for
explicit Reload and a successfully materialized native-fidelity fork. Direct
uses the former to read released Garcon JSONL once and keeps the latter null;
ordinary Direct turns reconstruct provider requests from the ledger. Adoption
commits no current view unless every required source was either read
successfully or positively determined absent. An already-recorded carryover
migration quarantine is known prior loss rather than an unknown read failure:
adoption creates a usable view with an explicit durable warning, while the
quarantined artifact remains available for support.

HTTP history reads perform one bounded raw-row scan and return an ordinal
continuation even when that scan renders no messages; the client requests
further ranges. This preserves the existing `(transcriptViewId, ordinal)`
addressing and adds no opaque cursor. Expanded browser history is never
trimmed under a reader, is discarded on chat switch, and restores from the
bounded cache; the three-minute live-edge prune timer is deleted. Pinned
OpenCode V1 automatic compaction is disabled because its continuation has no
immutable operation carrier; session-latest routing is deleted, context
exhaustion fails visibly, and V2/improved compaction support is deferred.

Revision 17 states how a producer reaches its sink. The sink was always
the fence, but nothing said how a runtime obtains one, and the adapter
resolved it from a chat-keyed map as each event arrived - capability
ceremony with global-lookup semantics, which let a trailing event from a
replaced generation publish into the view that replaced it. Section 5.1
now carries the publisher rule, its provenance requirement, and its
retirement boundary.

Revision 16 records what revision 15 read like once built: which fork
requests reach the facet at all, and what a native-seeded feed contains
while the provider's record still trails the live one.

Revision 15 settles how a fork that cannot be native is handled. Revision
14 refused outright, which reversed a deliberate V5 choice: a fork seeded
from the frozen conversation is a good outcome, and only its silence was
wrong. The refusal now serves as a probe the client turns into a
confirmation, the fallback is named a handoff fork after the shape it
produces, and a fork that does produce a native session seeds its feed
from that session rather than from the source rows.

Revision 14 moved the fork-point decision behind the `forking` facet.
Core had been reading `providerMeta` to decide whether a row was
forkable and, finding none, quietly produced a session-less fork; the
integration's typed refusal was then discarded on the way back. Core now
delegates unread and propagates the refusal. Section 12.3 carries the
rule and section 15 the failure semantics.

Revision 13 added the durable `agent-switch` row. V4 synthesized the
handoff boundary at read time from carryover segments, so it disappeared
whenever the composite was rebuilt - on chat switch or reload. Storing it
makes the boundary as durable as the conversation it separates: handoff
writes the row past the captured watermark and advances
`content_start_ordinal` past it, so the marker closes the outgoing
owner's history, and the frozen projection carries it through reload,
continuation, and fork. Roll-forward adopts an existing marker rather
than appending a second one when it reruns after a crash.

Revision 12 reconciled the document with the implementation after
review. Three points changed. Producers must absorb sink rejections
where provider events are dispatched, because a rejection escaping that
boundary could fail another session in the same runtime or another chat
sharing the provider stream, breaking the per-chat fencing L11 promises.
Permission facts with no correlated run were assigned a fresh correlation
ID rather than degrading into conversational rows; revision 18 deletes that
synthetic-correlation path
and applies section 5.1's log-and-drop rule. Roll-forward discharges the
ownership-journal entry before reopening the target's producer, since
that entry is the pending-ownership fence and would otherwise fence its
own last step. The permission `requested` shape now names the normalized
`requestedTool` message the tool-use contract requires, the surviving
`attachNativeMessageSource` carrier is described where §18 previously
claimed it was deleted, and the passive checkpoint on connection close
is named as housekeeping.

Revision 11 was the final deletion-and-fix pass, jointly reviewed and
user-approved. `publish()` now commits synchronously, deleting the
producer FIFO, `flush()`, close-and-drain, the publish/close race
protocol, and the queue's `sending` state. The sink is a capability
object closed by core; `agentOwnershipToken` is deleted, leaving transcript
addressing with exactly two identities. Shares are self-contained
snapshots (verified against the existing product implementation),
deleting the L8 exception; the reload cutover atomically deletes the old
view (user choice), deleting the `retained` status, retained reads, disk
reporting, and all GC policy. `binding_json` dissolves: the latest
`session` ledger row at or after `content_start_ordinal` is the durable
session authority and the registry becomes a repairable cache. Event
correlation rules make `runId` mandatory on `run-ended` and permission
lifecycle events and absent on rows and session facts, fixing the late-end
contradiction; revision 22 extends that ephemeral correlation to producer
notice events without storing it. `run-ended: failed` may carry optional
sanitized error detail (user choice); duplicate-submission retries never re-dispatch;
handoff staging is an in-memory plan with a self-contained decision
record and verified checkpoint; export privacy is split; dark validation
is deleted.

The central simplification:

> Core owns one durable serving ledger. Integrations translate provider
> events into rows and publish them once through one fenced sink. Normal
> history only grows. One explicit manual native reload atomically
> replaces the complete transcript view and is the only reason its view
> ID changes.

## 1. Decision Record

V4 kept two durable stores per chat (a normalized projection journal and
the provider's native history) and reconciled them by identity: canonical
source IDs on every live row, a native audit at open/idle/terminal,
settlement proofs gating turn success, positional matching for rows
without identity, and epoch/reset protocols for every case where the two
stores could disagree. Implementation falsified the premise that
cross-store identity is cheaply available: Pi emits `message_end` before
persisting; Codex's real-time stream and its rollout representation do
not match row-for-row; Amp, Factory, and Cursor expose weak or absent
live identities. The defect class was structural: reconciliation demands
identity the providers do not owe us. V5 removed the reconciliation;
later revisions removed the remaining exactly-once ceremonies, because
the pipeline they decorated is at-most-once by decision.

The decisions:

1. **Store what you showed.** The normalized stream each integration
   emits is the display truth. Core durably stores that stream in
   observed order — physically, one SQLite database per chat — and
   serves exactly it back, byte-identical. Provider-native history and
   integration-private storage are never serving authorities; core never
   reads them for ordinary history.
2. **Simplicity over crash-perfect attribution.** Small crash losses,
   delayed output, overlapping output after interruption, and slight
   native-history desynchronization are accepted. Drift detection and
   manual native reload mitigate them; protocol machinery does not try
   to eliminate them. There is no retry protocol, no producer event
   identity, no delivery evidence, and no durable run attribution on
   content rows.
3. **Core owns the one ledger; integrations own one producing path.**
   Each active integration translates provider events into normalized
   rows and publishes them, in the order observed, through a core-issued
   sink. The sink is a capability object: possession is the fence, and
   core closes it at handoff, reload, deletion, and shutdown.
   `publish()` validates, canonicalizes, and commits synchronously —
   acceptance and durability are the same point. That, plus a narrow
   active-run display-only notice event, a session-ref codec, separate
   nullable legacy-migration and Reload history imports, an optional tail
   probe, and an optional native fork, is the entire provider surface.
4. **Strictly append-only normal operation.** No revert, truncation,
   reconciliation, automatic reload, or generalized reset. No
   modification, removal, reordering, or ordinal reuse. Equal-content
   occurrences remain distinct. Ordinary appends never rotate a
   generation, never invalidate a cursor, and never change the
   transcript view.
5. **Durable before provider dispatch.** An immediate input is appended
   and committed before dispatch; a steer before delivery is attempted;
   a dequeued entry before its dispatch. A future-turn queued input
   remains only in the process-ephemeral queue, and restart loses it by
   design. Submission is idempotent by the client's `clientMessageId`,
   and a retry that finds its row already committed never re-dispatches.
6. **Resend is a backward scan, not a protocol.** A turn-starting
   dispatch initializes its prompt with the current input and scans
   preceding rows newest-first, collecting user inputs, skipping over
   interruption `run-ended` rows, notices, and presentation-only provider
   errors, and stopping at conversational provider output, any permission
   request, or any other `run-ended` row. Opting out is ephemeral composer
   state. There are no markers, no retraction rows, and no delivery evidence
   of any kind.
7. **One manual exception.** The explicit user action "Reload from
   native history" is the sole full-transcript replacement path. It
   rotates a narrow `transcriptViewId`; nothing else does. It is never
   automatic, exists only for chats whose current binding has a native
   source and a non-null `nativeHistoryImport`, preserves the frozen
   prefix before the current binding while importing exactly that one
   source through its tail, and atomically deletes the replaced view in
   the cutover transaction.
8. **Runs are ephemeral correlation.** Active execution holds an
   in-memory `runId`. `runId` is mandatory on `run-ended`, permission
   lifecycle, and producer notice events — the events that touch run or
   actionability state or authorize a run-scoped advisory — and absent from
   stored content, notice, and session rows. A user interrupt
   immediately marks the run stopped and appends
   `run-ended: interrupted`; provider abort is best-effort; a duplicate
   or stale end signal is ignored and never stored; an interrupt with no
   active run is an idle no-op. Late provider content and session facts always
   commit while the sink is open; producer notices do not outlive their run.
9. **The session row is the session authority.** The latest `session`
   ledger row at or after the view's `content_start_ordinal` is the
   durable authority for the current `agentSessionId`, native ref, and
   seed receipt; absence means no current native session. Registry
   session fields are an execution/listing cache repaired from the
   authoritative row at open. Handoff advances `content_start_ordinal`
   behind a durable decision written after the sink is closed and a
   verified checkpoint; it never deletes a native session.
10. **Concurrent-exclusive native ownership, advisory detection.** While
    Garcon is actively executing or importing a native session, nothing
    else may write it concurrently. Non-concurrent external use is
    expected — it is the manual-reload product case. After a successful active
    newest-history load, the native drift check may probe only the current
    binding and compare against integration-emitted history. A newer tail
    sends a transient operational warning recommending manual reload; it
    appends no ledger row and never blocks anything.
11. **Migration is not native-session import.** Genesis adoption reads pre-V5
    integration-owned history only through `legacyHistoryImport`; manual
    Reload and native-fidelity fork seeding read their concrete native session
    only through `nativeHistoryImport`. Every integration declares both
    nullable facets explicitly. Core never infers one capability from the
    other, and a migration failure never creates a false-empty current view.
    Adoption occurs either when the chat is first opened or when enabled
    transcript-search maintenance reaches the chat. Search maintenance is
    paced, invokes the same sole adoption owner, and never runs from a query.

## 2. Invariants

- **L1 Single serving authority.** One core-owned ledger per chat defines
  rendered history. Paging, reconnect, search, preview, model context,
  carryover, export, fork lookup, and command attribution consume its
  stored envelopes through the specified read folds (section 9); shares
  copy their content at publish time and never read the ledger again. No
  read surface touches provider-native storage or any
  integration-private storage.
- **L2 Append-only view.** Within a transcript view, stored rows are
  never modified, removed, reordered, or re-addressed. The view-wide
  ordinal is dense and never reused. Equal-content rows are distinct by
  address. Ordinary appends preserve `transcriptViewId`, rotate no
  generation, and invalidate no cursor.
- **L3 Durable before visible.** `publish()` and every core-originated
  append validate, canonicalize, and commit synchronously before
  returning; acceptance and durability are the same point. Broadcast
  happens after commit, through the existing per-chat server-event
  queue, preserving the established chat-messages-before-terminal-derived
  broadcast contract; a crash before broadcast is harmless because
  reconnect reads the committed rows. Committed means durable across
  process crash; durability across OS or power failure follows the
  configured `synchronous` level and the accepted-loss posture (4.3).
  Everything tentative, including the future-turn queue and resend
  opt-out state, is process-ephemeral overlay and dies on restart. A matched
  preamble application is one core-originated row group: its typed notice and
  boundary input commit atomically at adjacent ordinals and broadcast as one
  ordered batch.
- **L4 Durable before dispatch, idempotent by message identity.** An
  immediate input is appended and committed before provider dispatch; a
  steer before delivery is attempted; a dequeued queued entry before its
  dispatch. A future-turn queued input is not a transcript row.
  Submission is idempotent by `(chatId, transcriptViewId,
  clientMessageId)`: the same ID with identical content and attachments
  returns the existing queue disposition or ledger row and never
  re-dispatches; the same ID with different content is a typed conflict;
  a submission qualified by a stale view after manual reload is
  rejected, never deduplicated into the replacement. A presentation-only chat
  row uses the same view-local identity and conflict boundary over its type,
  title, and content, but never dispatches agent work.
  A pending preamble boundary is consumed only by the committed input's
  private boundary proof. A matching application's body-free prefix receipt
  covers the exact target-chat-expanded prefix, is server-derived, and is
  excluded from the submission fingerprint, so an
  identical retry returns the original input without another notice, prefix,
  or dispatch.
- **L5 At-most-once, observed order.** Every accepted event is committed
  at acceptance or the chat fences; there is no retry protocol and no
  producer event identity. Late provider content and session facts —
  received after an interruption or another run's start — always commit in
  observed order while the sink is open. Conversational output participates
  in every read fold; presentation-only errors render but enter no
  conversational fold. Neither can change processing state or make an old
  permission actionable. Producer notices are run-scoped advisories rather
  than content: only a nonblank event for the active run commits, and a stale
  event is dropped. A duplicate or stale `run-ended` is ignored and never
  becomes a row. Across a crash, events the provider emitted but core had not
  yet handled are lost, accepted.
- **L6 Run lifecycle.** Core applies each chat's events in the order
  their synchronous appends begin on the event loop; no ledger
  transaction spans an `await`. A session event is required only before
  provider output that depends on a newly established native session;
  resumed turns create no session row. `run-ended` is a durable
  lifecycle row (`outcome: finished | failed | interrupted`,
  `origin: provider | core`, optional sanitized `error`); run
  correlation is an ephemeral in-memory `runId`, mandatory on `run-ended`,
  permission lifecycle, and producer notice events and absent from stored
  content, notice, and session rows: a user interrupt immediately marks the run
  stopped and appends `run-ended: interrupted`; a later end signal for a
  stopped or unknown run is ignored; an interrupt with no active run is
  an idle no-op. The prior run's rows and its `run-ended` are committed
  before the scheduler starts the next queued turn. A crashed process
  leaves no `run-ended`; restart synthesizes nothing. A nonblank producer
  notice is accepted only for the current active run and stored as an ordinary
  notice without `runId`; stale-run and blank notices are ignored.
- **L7 The sink is a capability.** Producers publish only through the
  chat's single active sink object, issued by core and bound to the
  current view. Possession is the fence: core closes the sink at
  handoff, reload, deletion, and shutdown, a closed sink rejects
  synchronously, and a stale callback holds only a closed object — no
  token exists. `publish()` validates closure and event shape, then
  canonicalizes into a core-owned immutable envelope and commits before
  returning; core never backpressures provider callbacks, and commit
  latency is an accepted operational stall, never a buffering
  justification. A durable handoff decision immediately fences command
  admission and producer publication; transcript, search, and other read
  surfaces remain available throughout. The browser never trims either edge
  of the active interval while a user reads or a page/scroll mutation is in
  flight. Expanded state belongs only to the selected chat: chat switch or
  reload discards it, and returning restores the bounded recent cache. No
  live-edge timer participates in correctness, and memory eviction never
  truncates the ledger.
- **L8 View stability.** `transcriptViewId` changes only through manual
  full reload. Every page, event, search result, and cursor is qualified
  by it; requests qualified by a replaced view receive a typed
  stale-view error whether or not its rows still exist. There are no
  exceptions: shares are snapshot artifacts, not ledger readers.
- **L9 Advisory drift detection.** A successful active newest-history load
  returns before scheduling one point-in-time bounded tail read of the chat's
  current binding. Older pages, replay continuations, background reads,
  provider dispatch, timers, and startup never schedule it. The probe
  obligation: the reported relevant-entry timestamp must be no later than
  core's append time for any entry Garcon observed; a provider that cannot
  guarantee this returns `unavailable`. Equal pending work coalesces; changed
  eligibility supersedes it; every result revalidates the exact agent, view,
  session row and native reference, provider ordinal/timestamp, and execution
  ownership. A strictly newer tail may send a transient operational warning.
  The check appends no ledger row, stores no warning state, and never blocks
  the chat, gates resume, requires acknowledgement, or disables submission.
- **L10 Explicit history imports.** Complete integration-owned history reads
  occur only at genesis adoption through `legacyHistoryImport`, explicit
  manual Reload through `nativeHistoryImport`, and native-fidelity target
  seeding through that same native-session facet after the integration has
  materialized a fork. The two nullable facets are declared independently and
  core never substitutes one for the other. Reload imports exactly one native
  source — the current binding through its tail — while preserving the frozen
  prefix before it. The replaced view is deleted in the cutover transaction. A
  chat whose current binding has no native source or whose integration has a
  null `nativeHistoryImport` has no Reload action. Genesis adoption is invoked
  only by first-open activation or paced search maintenance; a search request
  never probes for or adopts a missing view. Adoption initializes no current
  view if a required prefix or legacy import fails, so a later open or search
  maintenance pass can retry. A durable carryover migration quarantine is the
  sole exception:
  the failed conversion and preserved artifact are already known, so adoption
  proceeds with an empty frozen prefix and a durable warning instead of
  permanently fencing the chat. Before Reload or native-fidelity fork turns
  normalized native history into rows, core strips only exact leading
  preamble prefixes proven by receipts collected from the selected ledger
  binding. A recognizable malformed, unmatched, or multi-signature prefix, or
  an excess native occurrence without matching evidence, fails before cutover or target
  publication. Receipt evidence absent from native history is allowed only
  without provider-completion proof. A provider-origin `run-ended` after the
  application input and before the next ordinary non-steer input requires one
  native occurrence of that receipt signature; a missing required occurrence
  fails retryably with `HISTORY_LOAD_FAILED` before Reload cutover or
  native-fidelity target publication.
- **L11 Fail closed, per chat.** A commit failure or unknown commit
  outcome fences the chat's ledger for writes; `SQLITE_CORRUPT` or any
  other ledger failure on open or query fences that chat with a typed
  error, and only that chat — per-chat databases make the fencing unit
  and the corruption blast radius the same boundary. There is no silent
  rebuild from native history or from any integration-private storage,
  and no retry protocol.
- **L12 Provider neutrality.** Core never branches on provider ID or
  parses provider formats; each history import source is read by its
  owning integration. Translation, native parsing, probes, and fork
  mechanics stay behind `@garcon/server-agent-interface` under
  `server-agents/<id>/`. Capabilities are nullable facets, never
  optional methods or boolean flags. Preamble selection, target-chat template
  expansion, framing, prompt concatenation, receipt validation, and
  normalized-history sanitation remain in provider-neutral core. Integrations receive the existing single opaque
  prompt and expose the existing normalized import stream unchanged.

## 3. Data Model

### 3.1 Addressing

```
chat ──> current transcript view (transcriptViewId)
           ──> rows (ordinal 1..n, view-wide, dense, monotonic)

address = (chatId, transcriptViewId, ordinal)
```

That address is the canonical durable row identity; no other row
identity exists. Handoff, continuation, and fork watermarks are
`(transcriptViewId, ordinal)`. The visible transcript is the ordinal
order of the current view; the browser sequence is the ordinal. Transcript
addressing and submission idempotency have exactly two identities —
`transcriptViewId` and `clientMessageId` — and zero tokens. The
`permissionOccurrenceId` UUID identifies one permission fact across its
specialized lifecycle; it is neither a row address nor a submission identity
and confers no authority. Chat, native-session, journal-operation, and durable
ownership identities exist elsewhere in the system and are not part of
transcript addressing.

### 3.2 Batches

The atomic append unit is the batch: exactly one producer event or one
core-originated row group, committed as one SQLite transaction inside
the synchronous append call, with ordinals assigned by core. One
provider occurrence that expands into several rendered rows (an item
with tool call and result subrows, a message with several parts) is one
batch: it commits atomically or not at all. Batches carry no identity;
there is nothing to retry (L5). A matched preamble boundary is one
core-originated batch containing exactly the `preamble-application` notice and
its user input at adjacent ordinals. A zero-match boundary stores only the
input with its private boundary proof.

### 3.3 Rows and writers

The row contract is a discriminated union over `kind`, so kind, message
presence, and detail shape co-vary at the type level; the fields common
to every variant are:

```ts
interface LedgerRowBase {
  readonly ordinal: number;                // view-wide, dense
  readonly at: string;
  readonly providerMeta: JsonObject | null;// opaque, owner-provider-private
}
```

Rows carry no durable run or attempt attribution and no row-level UUID.
`runId` is ephemeral event metadata where present; core strips it before
storing rows. `providerMeta` is optional metadata written by the
emitting integration and read back only by that integration (native
resume/fork positions, edge-dedup residue); core stores it blindly and
never compares it; stable provider-native row IDs are never required.

The ledger has two normal writers, plus the staging importer role used
by reload, continuation/fork seeding, and adoption.

| Kind | Writer | Rendered |
| --- | --- | --- |
| `user-input` | core | yes |
| `notice` | core, including `add-row`, chat-ID discovery, and accepted producer advisories | yes, except the ledger-private chat-ID request row |
| `agent-switch` | core | yes |
| `permission-resolved` | core | specialized |
| `provider-row` | integration | yes |
| `session` | integration | no |
| `run-ended` | integration, or core (`origin: 'core'`) | turn state only |
| `permission-requested` | integration | specialized |
| `permission-cancelled` | integration | specialized |
| `permission-expired` (optional) | integration | specialized |

Kind semantics:

- `user-input`: appended when the input becomes outbound (7.1). `detail`
  records the `clientMessageId`, the attachment manifest, whether the input
  was a steer (display styling), and two server-private nullable preamble
  fields. `preambleBoundary` is `{kind, ownershipEpoch}` and proves that this
  input consumed the binding's pending boundary, including when zero entries
  matched. `preamblePrefixReceipt` is
  `{format: 'preamble-v1', codeUnitLength, sha256}` and proves
  the exact leading prefix for native sanitation without storing its authored
  body template or target-chat-expanded body. The digest covers the prefix's
  exact JavaScript UTF-16 code units serialized as unsigned 16-bit
  little-endian values, so lone surrogates remain distinct from U+FFFD.
- `notice`: durable advisory. An accepted active-run producer advisory is an
  ordinary notice; its optional title is presentation metadata, and its
  `runId` is never stored. Native drift is not represented by this row; its
  warning is a process-lifetime operational event outside the ledger. The
  carryover quarantine notice's message is "Some earlier chat history could not
  be migrated. Quarantine reference: {artifactId}." Its `detail` records the
  same opaque `artifactId` plus `errorCode` under
  `{type: 'carryover-migration-quarantine', artifactId, errorCode}`; it has no
  action. The typed detail is how the frozen projection preserves this notice
  while dropping ordinary notices, because the loss cannot be repaired by
  Reload. Every chat-ID request also creates the ledger-private support detail
  `{type: 'chat-id-request'}` at the marker timestamp. It is dropped by the
  server presentation boundary and enters no public or conversational fold,
  but remains native-activity evidence. Accepted disclosure uses the shared
  `{type: 'chat-id-disclosure'}` detail; disabled or failed delivery uses
  `{type: 'chat-id-discovery-failure', reason}`. Those outcome notices are
  presentation-only diagnostics: they render, replay, share, and export, but
  do not enter search, preview, model context, resend, carryover, or fork seeds. Rendered
  `TranscriptNoticeMessage` and `ErrorMessage` instances own
  their optional top-level `title`; a rendered CLI row's detail is only the
  `{type: 'cli-row'}` provenance marker.
  A preamble application uses the fixed message `Preambles applied` and exact
  public detail `{type: 'preamble-application', preambles: [{id, title}, ...]}`.
  The ID/title pairs are immutable snapshots; no body, scope, path, catalog
  revision, or receipt is present.
- `agent-switch`: the durable ownership boundary written at in-place
  handoff, carrying `{fromAgentId, toAgentId, fromModel, toModel}` and
  rendered as the shared `AgentSwitchMessage`. V4 synthesized this
  marker at read time from a carryover segment's trailing handoff, so it
  vanished whenever the composite was rebuilt - on chat switch or
  reload. Storing it makes the boundary as durable as the conversation
  around it. Handoff writes it past the captured watermark and advances
  `content_start_ordinal` past the marker, so it closes the outgoing
  owner's history rather than opening the successor's, and the frozen
  projection carries it through reload, continuation, and fork.
- `provider-row`: one finalized normalized output row (assistant, thinking,
  every tool-use/result family, compaction summary, provider error, and every
  explicit provider-specific message type from `common/chat-types.ts`). An
  `ErrorMessage` is presentation-only even though its integration provenance
  keeps it in this row kind; every other provider row is conversational.
  Streaming deltas are overlay, never rows. Core recognizes only an assistant
  message beginning exactly with `<garcon-get-chat-id />`, removes that prefix
  and leading remainder whitespace before append, and omits the provider row
  when no non-whitespace remainder exists. The original `providerMeta` remains
  attached to a cleaned row. Each marker appends a ledger-private
  `chat-id-request` notice after its cleaned remainder in the same batch.
  Marker recognition invokes discovery delivery only after that batch commits.
- `session`: a newly established native session for this chat. `detail`
  holds `agentSessionId`, encoded native-session ref, seed receipt. The
  latest session row at or after the view's `content_start_ordinal` is
  the durable authority for the current native session (3.4); older
  session rows are history. Emitted only when a native session is
  established; resumed turns emit none. Session facts are
  ownership-scoped, not run-scoped: they carry no `runId` and commit in
  observed order while the sink is open, so a session established just
  before an interrupt still lands.
- `run-ended`: the durable lifecycle row
  `{ outcome: 'finished' | 'failed' | 'interrupted',
     origin: 'provider' | 'core',
     error?: { code: string, message?: string } }`.
  Provider-origin rows record the outcome the integration observed;
  core-origin rows record a user interrupt or a core-observed dispatch
  failure, and `failed` rows may carry the optional sanitized error
  detail so restart preserves why, not just that, a run failed. It
  carries no delivery claims and no durable run identity. A crashed
  process leaves no `run-ended` row.
- permission rows: durable typed permission lifecycle (section 8);
  `permission-resolved` is core-authored after a successful
  `respondToPermission()`, the others integration-emitted.

Read-fold membership is server-owned by row kind plus the presentation-only
`ErrorMessage` subtype. Clients receive normalized messages and own only their
rendering. Section 9 specifies every fold.

### 3.3.1 Presentation-only chat rows

The view-qualified HTTP surface and `garcon-cli add-row` append one durable
notice or error without starting, steering, stopping, or otherwise mutating
agent execution. Both presentations are stored as `notice` rows and broadcast
through the ordinary committed-row path. They persist across restart and
replay, update active and background transcript caches, and enter share
snapshots, but never preview metadata or a conversational fold.

The target read returns the current `transcriptViewId`; the mutation repeats
that view plus `clientRequestId` and `clientMessageId`, runs under the shared
chat-mutation lock and pending-ownership fence, and rejects a stale view. The
ledger's existing view-local submission index makes an identical retry return
the same ordinal and makes any changed payload or collision with a user input
a typed conflict. Content is retained byte-for-byte after enforcing nonblank,
well-formed UTF-8 up to 64 KiB. An optional title is normalized to one nonblank
line of at most 120 Unicode code points.

The ledger-private detail
`{type: 'cli-row', clientMessageId, presentation, title}` preserves durable
idempotency and rendering metadata. Presentation maps its title to the shared
message's top-level `title` and exposes only `{type: 'cli-row'}` as provenance;
private submission and presentation fields never cross the ledger boundary.

### 3.4 Session authority and the content-start boundary

Each transcript view records one normalized ledger-owned field:
`content_start_ordinal`, the boundary where the current binding's rows
begin. Rows before it are the frozen prefix — prior ownership's history,
continuation/fork seed, or adoption baseline — display truth that is
never re-imported (L10).

There is no stored binding object. The current native session derives
from the ledger: **the latest `session` row at or after
`content_start_ordinal` is the durable authority** for the current
`agentSessionId`, native-session ref, and seed receipt; absence of such
a row means the chat has no current native session. Registry session
fields are an execution/listing cache: a session publish commits the
row, updates the in-memory cache, and schedules the registry file flush;
opening a chat repairs the cache from the authoritative row, which
closes the crash window between the synchronous row commit and the
asynchronous registry flush.

Handoff advances `content_start_ordinal`; until the new owner emits a
session row past the boundary, the chat's current native session is
null. Old session rows remain readable history — handoff never deletes a
native session, and prior refs stay recorded for any future product
flow. Reusing an old session never inserts rows before
`content_start_ordinal`.

## 4. Storage: One SQLite Database Per Chat

### 4.1 Authority and physical scope

SQLite via `bun:sqlite` is the authoritative transcript ledger — the
repository already depends on Bun, so this adds no dependency. One
database per chat contains that chat's current view and, transiently,
a staging view during reload:

```
<ledger-root>/<chatId>/
  ledger.sqlite
  ledger.sqlite-wal
  ledger.sqlite-shm
```

Per-chat databases align corruption and fencing with the chat boundary
(L11), avoid cross-chat writer contention (`bun:sqlite` is a
synchronous single writer per database, and Garcon runs many concurrent
chats), and make deletion, export, and support per-file operations.
Deleting a chat closes its LRU-held connection, then removes the
directory. Connection-cache sizing is an implementation detail, not
protocol. The storage-boundary paragraphs of both `AGENTS.md` and
`CLAUDE.md` update in the same implementation change; provider-neutral
transcript search stays in `server-agents/common` and consumes the
ledger through a read port.

### 4.2 Schema

Canonical JSON payloads with only query-critical fields normalized:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE transcript_views (
  view_id               TEXT PRIMARY KEY,
  status                TEXT NOT NULL
                        CHECK (status IN ('current', 'staging')),
  created_at            TEXT NOT NULL,
  content_start_ordinal INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX transcript_one_current
  ON transcript_views(status)
  WHERE status = 'current';

CREATE TABLE transcript_rows (
  view_id           TEXT NOT NULL
                    REFERENCES transcript_views(view_id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  at                TEXT NOT NULL,
  client_message_id TEXT,
  payload_json      TEXT NOT NULL,
  PRIMARY KEY (view_id, ordinal)
) WITHOUT ROWID, STRICT;

CREATE UNIQUE INDEX transcript_submission
  ON transcript_rows(view_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
```

- `transcript_views` is the sole current-view authority: the partial
  unique index permits at most one `current` view. An established
  database has exactly one; a brand-new empty database is the sole
  zero-current case. There is no `meta` or pointer table, no pointer
  file, and no `retained` status — the reload cutover deletes the
  replaced view (section 11).
- `PRAGMA user_version` is set at creation and validated at every open;
  schema migrations run lazily and transactionally at open.
- The canonical durable row address is `(transcriptViewId, ordinal)`;
  there is no `rowUuid` and no imported-row origin provenance. If future
  diagnostics ever need origin provenance, its only valid
  non-load-bearing form is `{sourceChatId, sourceViewId, ordinal}` — it
  may never become a lookup dependency or second identity.
- `next_ordinal` is not persisted. The serialized append path seeds an
  in-memory next ordinal from one primary-key seek at open and advances
  it; a durable counter would be a second source of truth and is added
  only if measurement ever justifies it.

### 4.3 Writes, durability, and paging

- One producer event or core-originated row group is one SQLite
  transaction, executed synchronously inside the append call; no ledger
  transaction spans an `await`. Acceptance and durability are the same
  point (L3); broadcast follows commit through the per-chat server-event
  queue.
- Commit an immediate input or steer before provider dispatch/delivery,
  and a dequeued input before its dispatch (L4).
- WAL with `synchronous=NORMAL` is the default; `FULL` may be deployment
  configuration. NORMAL preserves complete process-crash recovery —
  commits reach the OS regardless of fsync — but recent commits may be
  lost on OS or power failure. That window is within the accepted-loss
  posture (section 16). Commit latency is rationale-level fast, but WAL
  auto-checkpoints or a slow filesystem can occasionally stall a
  callback; that is an accepted operational stall, not a buffering
  justification.
- Exactly one `wal_checkpoint(FULL)` is protocol-significant: after the
  outgoing sink is closed, immediately before fsyncing the separate
  ownership-journal handoff decision (12.1). Handoff must verify the
  checkpoint completed — zero busy frames, all frames checkpointed —
  before writing the decision; an incomplete checkpoint leaves the
  operation pre-decision. It protects the sole cross-store dependency:
  the fsynced decision must not survive a power loss that the ledger
  prefix it depends on does not. No other checkpoint is protocol; the
  passive checkpoint on connection close is housekeeping that keeps an
  idle chat's WAL from growing unbounded.
- HTTP history paging performs exactly one bounded raw-row keyset query on
  the `(view_id, ordinal)` primary key per request; there is no offset,
  presentation-sized scan loop, or sidecar index. The request `limit` is a
  raw-row budget, not a promise to return that many rendered messages. The
  newest page is
  `SELECT ... WHERE view_id = ? ORDER BY ordinal DESC LIMIT ?`; older pages
  are `SELECT ... WHERE view_id = ? AND ordinal < ? ORDER BY ordinal DESC
  LIMIT ?`. An expected `transcriptViewId` is checked before the high-watermark
  read or query.
- Define `effectiveBefore = min(request.beforeOrdinal ?? lastOrdinal + 1,
  lastOrdinal + 1)`. The query reads rows with `ordinal < effectiveBefore`.
  `pageNewestOrdinal` is the inclusive raw interval ceiling,
  `effectiveBefore - 1` (zero for an empty interval), even when no message is
  presented. `pageOldestOrdinal` is the first presented ordinal in ascending
  response order, or zero when none are presented. `nextBeforeOrdinal` equals
  the oldest raw ordinal returned when that ordinal is greater than one;
  otherwise it is null. Dense ordinals make that continuation derivable from
  the same query, so no second existence query is allowed.
- Presentation filters that one raw batch once. A lifecycle-only batch may
  therefore return zero messages and a non-null `nextBeforeOrdinal`. `hasMore`
  is true exactly when that continuation is non-null. The client validates
  strict progress and follows the raw ordinal until it has enough visible rows
  or reaches null; a hidden run may require several bounded requests. This
  keeps all addressing in the existing `(transcriptViewId, ordinal)` space and
  bounds server work independently of transcript length. The backward resend
  scan (7.2) walks the same key order.
- Submission idempotency is the `transcript_submission` partial unique
  index plus canonical payload comparison on conflict: an insert that
  conflicts re-reads the existing row; an identical user submission returns
  and never re-dispatches, while an identical presentation-only chat row
  returns the same ordinal and broadcasts nothing. A changed payload or a
  cross-kind ID collision is the typed conflict. There is no index rebuild at
  open.

### 4.4 Execution model, operations, and failure handling

- Core uses `bun:sqlite` directly, synchronously, behind the ledger port
  and the existing per-chat serialization. No Worker is introduced until
  measured event-loop latency warrants one; the search Worker's
  bulk-indexing rationale does not transfer to small per-event commits.
- SQLite WAL recovery is normal startup behavior. There are no
  clean-shutdown markers and no routine `quick_check`; corruption
  surfaces lazily as `SQLITE_CORRUPT` (or another ledger failure) on
  open or query and fences that chat only (L11). `quick_check` and
  `.recover` are support tools, not protocol.
- A commit failure or unknown commit outcome means no broadcast and the
  chat's ledger fences for writes; the producer holds nothing, and
  whatever the fence loses falls under accepted loss 1 (section 16).
- Live backups use SQLite's backup API or `VACUUM INTO`; copying only
  `ledger.sqlite` while the WAL may contain commits is not a valid
  backup.
- The durable ledger is paged from disk. The selected chat may hold an
  expanded active interval without mutation-time trimming; switching chats
  discards that interval and a later return restores only the bounded recent
  cache. The cache persists the raw earlier-page continuation independently of
  its oldest visible ordinal, so an all-hidden page remains resumable after a
  switch or browser-cache hydration. Evicting memory never truncates the
  ledger — scrolling reloads older pages.

## 5. Producer Boundary

### 5.1 The sink

Core issues each active integration one producer sink per chat — a
capability object bound internally to the chat and its current view:

```ts
interface AgentProducerSink {
  // Synchronously validates closure state and event shape,
  // canonicalizes the event into a core-owned immutable envelope,
  // assigns ordinals, and commits the transaction before returning.
  // Broadcast follows commit through the per-chat server-event queue.
  // Throws SinkClosedError once closed.
  publish(event: ProducerEvent): void;
}
```

Possession of the open sink is the fence; there is no token. Core
closes the sink at in-place handoff, manual reload, chat deletion, and
shutdown; a closed sink rejects synchronously, and core may additionally
verify object identity against the chat's single active sink. Old-owner
or pre-reload callbacks hold only a closed object. Sinks do not survive
restart. `runId` is ephemeral correlation metadata on `run-ended`, permission,
and producer notice events only — never ledger identity and never present on
stored content, notice, or session rows.

A runtime never looks a sink up. Core hands it a publisher closing over
one binding, and that closure is the only route the runtime has to a
transcript. Events therefore carry no chat id: routing is not data a
provider can get wrong, because it is not data at all. An operation that
outlives the transcript it was started against keeps publishing at its
own closed sink and has no mechanism to discover the replacement, which
is what makes possession the fence rather than a claim about it.

The publisher is captured on the concrete turn, request, or callback
object when that object is created, never resolved when an event
arrives. A runtime whose provider multiplexes one process-wide stream -
OpenCode's global event stream - demultiplexes on the provider's own
immutable operation identity. A runtime whose provider gives each operation
its own client and process - Codex's app-server wiring - applies the same rule
at its runtime dispatch boundary: the operation's immutable identity selects
only its captured publisher. In both topologies that identity is a turn id
rather than a session id, because a session id survives the reload that
replaces the view and would reintroduce the same overwrite one layer down.
Deriving a publisher from the current chat, the current session, or the
operation that happens to be latest is the defect this rule exists to prevent,
so an event the provider does not name is logged and dropped rather than
attributed. Content flushed after a turn ends is named too: section 6 admits
it, and the provider knows which turn produced it even when Garcon's own run
has ended. Where a provider drops that name on the way out - Codex's turn-item
ledger did - the fix belongs at that emitter, not in a fallback that guesses.
A name is meaningful only inside the chat that issued it, so a route resolves
only when the name and the emitting chat agree.

The one display-only exception does not relax content routing: an integration
may attach a provider's session-scoped advisory to that session's sole active
turn and publish only a `notice` through the turn's captured publisher. Core's
active-`runId` check drops it after the turn ends, and the notice row enters no
conversational fold. The advisory cannot publish output, session state,
permissions, or a terminal on behalf of an unnamed operation.

A route retires when its provider event source can no longer emit, not
when its run ends: section 6 admits content after the terminal while the
sink is open, and discarding the route at `run-ended` would lose it.
Retirement is therefore an event, never a capacity limit - evicting a
route because newer ones exist would discard one whose source is still
live and whose sink is still open. A fresh session supersedes whatever
produced the chat before it, which is the observable point its routes
retire. State that outlives a single operation, such as the session
already published, belongs to the sink rather than to the operation, and
is read only while a publisher is being constructed.

```ts
interface AgentHistoryImport {
  load(request: {
    readonly chat: AgentChatReference;
    readonly signal: AbortSignal;
  }): AsyncIterable<readonly AgentImportedTranscriptRow[]>;
}

interface AgentIntegrationV5 {
  descriptor; settings; catalog; lifecycle; migration;   // unchanged
  execution: AgentExecutionV5;    // start/steer/abort + admission;
                                  // failures are plain errors;
                                  // start() returns an opaque handle
  legacyHistoryImport: AgentHistoryImport | null;
                                  // pre-V5 history -> rows; adoption only
  nativeHistoryImport: AgentHistoryImport | null;
                                  // concrete native session -> rows; Reload and
                                  // materialized native-fork seed only;
                                  // null = no Reload
  nativeSessions: codec;          // encode/decode session refs
  nativeActivity: AgentNativeActivityProbe | null;  // drift check (10.2)
  forking: AgentNativeForkV5 | null;  // native-fidelity fork (12.3)
  steering; goals;                // unchanged nullable facets
}

interface AgentPermissionResponseCapability {
  readonly permissionOccurrenceId: string;
  respond(decision: PermissionDecisionPayload): Promise<void>;
}

type ProducerEvent =
  | { type: 'rows'; rows: ProducedRow[] }
  | { type: 'session'; session: EstablishedSession }
  | { type: 'notice'; runId: string; content: string; title?: string }
  | { type: 'permission'; runId: string;
      lifecycle: Extract<PermissionLifecycle, { kind: 'requested' }>;
      decision: AgentPermissionResponseCapability }
  | { type: 'permission'; runId: string;
      lifecycle: Exclude<PermissionLifecycle, { kind: 'requested' | 'resolved' }>;
      decision?: never }
  | { type: 'run-ended'; runId: string;
      outcome: 'finished' | 'failed' | 'interrupted';
      error?: { code: string; message?: string } };

interface ProducedRow {
  readonly message: ChatMessage;
  readonly providerMeta?: JsonObject;
}
```

Every integration declares both history-import facets explicitly; there is no
`legacyHistoryImport ?? nativeHistoryImport` fallback. Both emit the same
normalized row stream, but each facet carries its own invocation occasion. The
facet objects may be thin wrappers over one provider-owned source and
translation implementation; reference equality is not a contract. For
`legacyHistoryImport`, completing normally with no rows means the supported
migration source was positively determined absent or validly contained no
importable rows; inability to discover, open, read, parse, convert, sanitize,
or finish iterating a possible supported source throws. Genesis adoption propagates that
failure and creates no current view. A later open retries. For
`nativeHistoryImport`, the concrete session selected by Reload or a
native-fidelity target seed is required: missing or NotFound, unreadable,
unparseable, unconvertible, unsanitizable, or incomplete native evidence
throws. Only a
successfully opened native session that validly contains no importable rows may
complete empty. Reload then preserves its current view on failure, and a failed
native-fidelity seed remains fatal to the target fork.

This is the entire provider surface for transcripts: translate what the
provider did into rows, optionally surface a nonblank active-run display-only
advisory, and publish in observation order. The notice arm is not a generic
provider-status or retry-control protocol. There is no producer-event identity,
no ordering obligation beyond observation order, no provider durability
obligation, no delivery claim, and no producer acceptance-capacity protocol.
HTTP pages and WebSocket replay frames have independent bounded transport
contracts.
Provider-level redelivery may be deduplicated at the adapter edge when a
real provider identity exists (Claude uuids, Codex item ids, OpenCode
part ids); otherwise a duplicate is an honest additional immutable
occurrence.

### 5.2 Acceptance semantics

`publish()` is the event's acceptance point, and acceptance is
durability:

- Validation is synchronous: closure state and event shape. An event
  offered to a closed sink rejects synchronously, and so does an event
  offered while the chat's ledger is fenced. Producers must absorb both
  rejections at the boundary where provider events are dispatched. A
  rejection that escapes that boundary can fail another session in the same
  runtime or another chat sharing the provider stream, breaking the per-chat
  fencing L11 promises. The dropped event is the accepted at-most-once loss,
  logged and not retried.
- Acceptance snapshots: core canonicalizes the event into a core-owned
  immutable envelope; later mutation of the caller's object has no
  effect.
- The commit executes inside `publish()` before it returns; observed
  order is the order synchronous mutation calls begin on the event loop,
  and no ledger transaction spans an `await`, so no lock or race
  protocol exists between publishes, core appends, and `close()`.
- Broadcast is not part of `publish()`: after commit, the row broadcast
  enters the existing per-chat server-event queue, preserving commit
  order and the established chat-messages-before-terminal-derived-state
  contract. A crash before broadcast is harmless; reconnect reads the
  committed rows.
- Nothing buffers, so there is no flush concept, no accepted-but-
  unpersisted state, and no publish/close race protocol. The loss window
  is events the provider emitted that core had not yet handled at crash,
  plus the NORMAL power-loss window (4.3); a later active history load may
  surface newer native evidence where the provider persisted it, and manual
  reload is the remediation.
- Ordinary request validation (for example rejecting an absurdly
  oversized submission) may remain at the API boundary; it is not a
  transcript protocol.

### 5.3 Sink teardown

Ending a sink is one ordinary synchronous operation — `sink.close()` —
after which later publishes reject. There is nothing to drain and
nothing to flush. The flows differ only in their preconditions and
continuations:

- **In-place handoff** (12.1): acquire the existing per-chat execution
  reservation; require no active run with its `run-ended` committed and
  an empty future-turn queue; close the sink; run the verified
  checkpoint; then write the durable ownership decision.
- **Manual reload** (11): acquire the reservation; require no active run
  with its `run-ended` committed and an empty future-turn queue; close
  the sink; then stage. A staging failure issues a fresh sink bound to
  the unchanged current view.
- **Deletion of a live chat**: abort best-effort, close the sink, write
  the durable deletion decision, then clean up; queued entries are
  cleared, the connection is closed, and the chat directory is removed.
- **Shutdown**: close sinks; everything accepted is already committed.

The UI directs the user to run or remove queued entries before reload or
handoff; nothing is silently cleared or retargeted.

## 6. Ordering and the Run Lifecycle

### 6.1 Synchronous application and runs

Core applies each chat's events in the order their synchronous appends
begin on the event loop. Session ordering is exactly this: a `session`
event is required before any provider output that depends on a newly
established native session, and nothing else. User input is accepted
before a new session may exist, and resumed turns create no session row.

Run correlation is ordinary in-memory execution state — an ephemeral `runId`
held by the active execution, mandatory on `run-ended`, permission lifecycle,
and producer notice events and absent from stored rows:

- An accepted user interrupt immediately marks the current run stopped
  and appends `run-ended: interrupted` (`origin: 'core'`). Provider
  abort/kill is best-effort: core does not require confirmed process
  death and does not fence the chat when confirmation is unavailable.
- A `run-ended` whose `runId` names a stopped or unknown run is ignored
  and never stored; the current run cannot be stopped by a delayed old
  signal, and a new user dispatch creates a new `runId`.
- If the provider had already ended before the interrupt is processed,
  the interrupt is an idle no-op.
- A core-observed dispatch failure appends `run-ended: failed`
  (`origin: 'core'`), carrying the optional sanitized error detail so
  the reason survives restart.
- A nonblank producer notice commits only when its `runId` is still active.
  Core stores an ordinary display-only notice without run correlation; a blank
  or stale-run notice is ignored.
- Session facts carry no `runId` and are never rejected as stale-run
  lifecycle: a session established just before an interrupt still
  commits when its callback arrives, preserving the native ref that
  resume, the drift probe, and reload depend on. The closed sink is the
  only fence on session facts.

Late provider rows and session facts received after an interruption or after
another run began commit normally in observed order. Conversational provider
rows participate in every conversational fold and may interleave with later
output; provider errors remain presentation-only, and session facts remain
hidden authority. That is accepted. Late events cannot change processing state
(the `runId` rule) or make an old permission actionable (section 8).

The prior run's rows and its `run-ended` are committed before the
scheduler starts the next queued turn — with synchronous appends this is
the natural order, not a watermark protocol. If a commit fails, the chat
fences (L11). A crashed process leaves no `run-ended`; restart
synthesizes nothing, and the next submission simply starts a new run.

### 6.2 Session row as sole writer

`execution.start()` returns only an opaque execution handle for abort
routing; session metadata has exactly one durable source: the `session`
row (3.4). Applying a session event commits the row, updates the
in-memory registry cache, schedules the asynchronous registry file
flush, and broadcasts `ChatSessionCreatedMessage`. Opening a chat
repairs the registry cache from the authoritative row, closing the
commit-versus-flush crash window. There is no second value to validate
for agreement; the V4 session-metadata registry write from `RuntimeRouter`'s
start return path (`server/agents/runtime-router.ts`) is removed. Startup fences
orphan provider processes (unchanged policy).

## 7. Inputs and Resend

### 7.1 The queue/transcript boundary

The guarantee is durable before provider dispatch, not durable at send:

- An **immediate input** (starting a turn now) is validated under the
  ownership and pending-ownership fences, appended, and committed before
  provider dispatch. If its binding has a pending preamble boundary, core
  resolves the current enabled catalog against the canonical project path.
  A nonempty match plus an otherwise-unhandled slash-leading input is rejected
  before admission and leaves the boundary armed; otherwise the input commits
  the boundary proof and consumes it exactly once. Each matched body expands
  the shared `{{chat_id}}` token to this target chat ID before prefix framing;
  `\{{chat_id}}` becomes literal and unsupported variables remain unchanged.
- A **steer** is appended and committed before delivery to the running
  provider is attempted. A steer initially sends only its own content;
  it is an ordinary prior `user-input` if a later turn performs the
  fold.
- A **chat-ID discovery control input** is server-originated rather than a user
  submission. It creates no `user-input` row and does not participate in resend,
  queueing, or command idempotency. Core captures a steering target once and
  uses it only when its turn identity equals the marker's emitting run. It
  attempts that steer once. Accepted delivery finishes; ambiguous delivery and
  unexpected failures stop without fallback. A definitive unavailable,
  changed, non-steerable, unsupported, or confirmed-not-sent result waits for
  that exact attempt to settle, then makes one direct server-control
  reservation. A missing or mismatched emitting target goes directly to that
  reservation without steering a successor. The direct route uses ordinary
  execution ownership, deletion/drain/queue/pause checks, and background
  lifecycle, but sends only the disclosure envelope and admits no transcript
  input. Contention fails immediately: there is no retry, route watch,
  successor retarget, or queue entry. Acceptance of either route immediately
  appends one outcome notice; provider completion is not part of discovery and
  any later failure uses the ordinary provider/run error path.
  The direct route registers its control-turn identity before provider
  dispatch. Discovery suppresses markers correlated to that turn and, because
  late provider rows carry no active-run attribution, every later uncorrelated
  marker until view replacement or deletion. Outside the per-chat in-flight
  delivery gate, a marker correlated to a different run remains eligible. This
  conservative recursion fence may drop an independent uncorrelated request
  rather than recursively dispatching a control turn's late output. After a
  delivery settles, a later marker from the same emitting run is eligible
  again; run identity is not a request-deduplication key.
- A **future-turn queued input** remains only in the process-ephemeral
  queue, indexed by `clientMessageId`. It is not a transcript row.
  Dequeue is one synchronous block: commit the `user-input` row (the
  submission unique index is part of the same transaction), remove the
  queue entry, then dispatch — nothing can interleave between those
  steps, so a retry can never observe neither or both identities. On
  commit failure the entry stays queued while the chat fences. Removing
  a still-queued entry only removes it from the queue. Restart
  intentionally loses queued entries and does not reconstruct them or
  mark them.

Submission is idempotent by `(chatId, transcriptViewId,
clientMessageId)`. The client generates `clientMessageId` once per
logical message and reuses it on retry. While the message is queued, the
queue index answers retries with the existing disposition; once it is a
ledger row, the submission unique index answers with the existing row.
The same ID with identical content and attachments is an idempotent
retry that returns the existing row and **never re-dispatches**: the
UUID deduplicates both the row and the command. A crash between commit
and dispatch is an accepted loss — the committed row renders with the
ordinary will-send-with-your-next-message affordance, and the next fresh
input's backward scan is the recovery path. The same ID with different
content is a typed conflict; a stale-view submission after manual reload
is rejected. `clientRequestId` remains process-ephemeral command
correlation. None of this is delivery tracking.

What the client shows beside its own optimistic row is not delivery
tracking either. The submitting request is in flight or it is not, and
that distinction lives entirely in the tab that made the call: it is
never sent, never stored, and gone on reload. It is worth showing because
losing connectivity mid-submit is otherwise indistinguishable from a slow
server, and the row it decorates is already ephemeral for the same
reason. The ledger keeps no counterpart, and an unanswered request stays
marked in flight rather than claiming an outcome nobody observed.

An immediate or dequeued dispatch is composed by one synchronous method
that commits the input row and computes the backward scan before
returning; no provider callback can interleave between insert and scan,
and dispatch consumes the returned immutable composition. For a matched
preamble boundary, that immutable composition also carries the rendered
private prefix. Core expands chat-ID tokens in matched catalog bodies, then
frames and receipts the exact result. Core resolves file mentions in visible authored input first,
then prepends the receipt-covered prefix once to the complete turn prompt.
The provider integration still receives one ordinary opaque prompt string;
the body never enters the ledger or any context fold.

V4's prepare/commit/promotion admission transaction, active-lifetime
entries, and `input-not-sent` reset are deleted.

### 7.2 The resend fold

There is no delivery evidence, no marker, and no stored resend state.
The fold is a literal backward scan, run only for a turn-starting
submission or a dequeued entry, after the current input's row is
committed:

```ts
const prompt = [currentInput];

for (const row of precedingRowsNewestFirst) {
  if (row.kind === 'user-input') {
    prompt.unshift(row);
    continue;
  }

  if (row.kind === 'run-ended' && row.outcome === 'interrupted') {
    continue;
  }

  if (row.kind === 'provider-row' && row.message.type === 'error') {
    continue;
  }

  if (
    row.kind === 'provider-row' ||
    row.kind === 'permission-requested' ||
    row.kind === 'run-ended'
  ) {
    break;
  }

  // Notices, presentation-only errors, session metadata, and permission
  // bookkeeping do not affect the scan.
}
```

The current input appears exactly once, as the initializer. The scan collects
unanswered inputs back through any number of interruptions, notices, and
presentation-only errors, and stops at the first conversational provider
output, any `permission-requested` row (resolution rows are ignored by the scan,
so the boundary is the request itself, not its lifecycle state), or a run that
ended without interruption — a visible finish or failure is the user's cue to
decide for themselves. Collected inputs and their
attachments are combined into one prompt; the integration receives one
prompt. Rows composed into the current outgoing prompt are excluded from
the context fold supplied for that same request, so they appear exactly
once (section 9).

Opting out is ephemeral: the composer shows the to-be-resent rows as
removable chips; removing a chip excludes that row from this composition
only. Restart resets chips and the scan re-collects the row —
duplication over omission, the chosen bias. An input the user declines
to resend remains conversation history and still reaches stateless
providers as prior context (section 9); history cannot be un-said.

No interruption row is inferred or appended after a restart. Explicit
user interruptions remain durable because they were appended when
accepted. A crash with no stored conversational provider output naturally
leaves the preceding user rows eligible for the next scan; a crash after
conversational output may not. That loss is accepted (section 16).

### 7.3 Presentation

Turn state renders from `run-ended` rows and live execution state; after
a crash the transcript simply ends and the chat is idle. Rows the next
scan would collect carry a "will be sent with your next message"
affordance whose removal is composer state ("Don't resend"), never a
ledger write. Resend affordances never show while a run is active.
Presentation-only notices and errors remain visible around those rows without
changing their resend eligibility.

V4's pending-input settlement machinery (`settledInputRequests`,
`nativelyBoundInputRequests`, delivery-status tracking, stop-cohort
native-binding proof) is deleted. What survives under that last name is
only the client's in-flight marker from 7.1, which crosses no boundary.

## 8. Permission History

Permission lifecycle is durable ledger history, not a transient-only
channel. Integrations emit provider-originated `permission-requested`,
`permission-cancelled`, and `permission-expired` events — with a
mandatory ephemeral `runId` for actionability correlation — on the
ordered stream; core appends `permission-resolved` itself after
`respondToPermission()` succeeds, which removes callback-ordering
requirements from every integration. All permission lifecycle rows,
including late ones, remain durable observed history; a late fact can
never become actionable for a different or current run.

The owning integration creates one globally unique
`permissionOccurrenceId` with `crypto.randomUUID()` when it creates the
concrete native permission occurrence. It stores that UUID with the native
request object, the concrete operation and publisher, and a response closure.
Requested and terminal lifecycle events reuse exactly that UUID. A
provider-native request ID may remain inside this integration-private object
and closure, but never crosses the producer, core, API, WebSocket, or browser
boundary. An event without its owning concrete operation cannot supply a
valid publisher or `runId`; it is dropped with a structured,
transcript-content-free
warning rather than assigned synthetic correlation or degraded into a
`provider-row`.

The durable detail contract is discriminated and typed:

```ts
type PermissionLifecycle =
  | { readonly kind: 'requested';
      readonly permissionOccurrenceId: string;
      readonly requestedTool: ToolUseChatMessage;
      readonly options: readonly AgentPermissionOption[] }
  | { readonly kind: 'resolved';
      readonly permissionOccurrenceId: string;
      readonly decision: PermissionDecisionPayload }
  | { readonly kind: 'cancelled';
      readonly permissionOccurrenceId: string;
      readonly reason: string | null }
  | { readonly kind: 'expired';
      readonly permissionOccurrenceId: string };
```

- A requested producer event carries its occurrence's
  `AgentPermissionResponseCapability`; terminal producer events carry no
  capability. The sink rejects the event unless the lifecycle and capability
  `permissionOccurrenceId` values are equal, then commits the requested row and
  registers that exact capability in ephemeral active state before returning.
  Possession of the capability is the authority. `permissionOccurrenceId`
  selects the fact to claim but grants no authority by itself.
- The client renders permission rows with specialized presentation and
  action handling. After restart, historical permission rows remain
  visible but are not actionable because no response capability survives.
  The response endpoint pre-claims the occurrence by
  `permissionOccurrenceId` only after checking the current
  `serverInstanceId`, current run correlation, and unresolved lifecycle
  state. Those checks reject stale or historical controls; they are not a
  second source of authority. Core invokes only the claimed occurrence's
  capability, abandons the claim if provider response fails, and appends
  `permission-resolved` only after response succeeds.
- Ledger schema version 1 intentionally keeps the stored lifecycle JSON key
  `incarnation`. `server/ledger/codec.ts` encodes
  `permissionOccurrenceId` as `incarnation` and decodes stored `incarnation`
  as `permissionOccurrenceId`; an old extra `requestId` is ignored. No other
  layer knows the durable spelling, no dual public field exists, and no
  schema migration or payload rewrite is required.
- Streaming partial permission UI remains ephemeral overlay; finalized
  lifecycle facts are durable.

## 9. Read Folds

Every read surface consumes the ledger through one explicit row-kind
matrix. "Conversational rows" below means `user-input` rows plus non-error
`provider-row` rows, in ordinal order. A provider `ErrorMessage` remains an
integration-owned `provider-row` for provenance and native activity but is
presentation-only in every consumer fold.

| Kind | Rendering | Search | Preview | Model context / carryover | Share snapshot | Export |
| --- | --- | --- | --- | --- | --- | --- |
| `user-input` | yes | yes | candidate | yes, excluding current-prompt rows | yes | yes |
| conversational `provider-row` | yes | yes | candidate | yes | yes | yes |
| error `provider-row` | yes | no | no | no | yes | yes |
| ledger-private `chat-id-request` notice | no | no | no | no | no | no |
| typed `preamble-application` notice | yes | no | no | no | yes | yes |
| every other `notice` | yes | no | no | no | yes | yes |
| `agent-switch` | yes | no | no | no | yes | yes |
| permission rows | specialized | no | no | no | specialized | yes |
| `session` | no | no | no | no | no | support export only |
| `run-ended` | turn state only | no | no | no | no | yes |

The native-drift operational warning is outside this matrix. It is a transient
server event and enters no ledger page, replay, search result, preview, share,
model context, carryover, or export.

- **Rendering** shows conversational rows, public notices, provider errors,
  and specialized permission rows; the ledger-private chat-ID request notice
  is filtered at this shared server boundary. Turn state derives from
  `run-ended` rows and live execution state. Late content renders in observed
  order.
- **Search** indexes conversational content only, keyed
  `(chatId, transcriptViewId, ordinal)` with an appended-through
  watermark; normal appends index only the suffix; nothing is ever
  de-indexed within a live view. Commit notifications and view
  replacement enter the search worker in the same per-chat order, so
  deleting a replaced view's entries cannot be followed by a delayed
  old-view insert; the derived index may delete replaced views' entries,
  and query admission is current-view-qualified regardless.
  Index status is current-view/frontier-qualified: pending until
  acknowledgement, failed after terminal indexing rejection, and indexed
  after acknowledged repair, including valid views with no searchable rows.
  Enabled search maintenance enumerates the registry, probes current-view
  existence without creating a ledger, and sequentially invokes the sole
  genesis-adoption owner for every unadopted chat under the ingest duty-cycle
  pacer. Query admission reads only the controller's maintained view cache; it
  never opens, probes, or adopts a ledger. Search status reports the registry
  total and the indexed, pending, failed, and unindexed populations so partial
  coverage cannot appear complete. Each compiled query clause materializes at
  most the 10,000 newest matching FTS rows plus one successor probe. A
  successor sets `resultsTruncated`; ranking, clause intersection, result
  counts, and snippets then describe that bounded recent sample rather than an
  unbounded complete match set.
- **Preview** selects the latest conversational row; notices, provider errors,
  and lifecycle state are separate UI signals, never preview text.
- **Model context and carryover** are the conversational fold, minus the
  rows composed into the current outgoing prompt (which appear exactly
  once, in the prompt). Conversational history is never excluded otherwise: a
  message the user declined to resend remains history and reaches stateless
  providers as context. The frozen projection has one display-only exception
  to the conversational matrix: it preserves carryover-quarantine and typed
  preamble-application notices. The former keeps permanent prior loss visible;
  the latter preserves immutable title snapshots next to copied boundary
  inputs. Neither notice enters model context.
- **Shares are snapshot artifacts**: publishing a share copies its
  rendering fold into the share store (the existing product behavior —
  `server/routes/shares.ts`, `server/chats/share-store.ts`,
  `common/share-types.ts`); the share never reads the ledger again and
  is unaffected by reload or deletion of views. Share revocation policy
  is unchanged.
- **Ordinary user export** captures the current view through one pinned
  watermark and folds raw ledger rows into export entries. It includes
  `user-input`, every rendered `provider-row`, every public `notice`,
  `agent-switch`, permission lifecycle, and `run-ended`; it excludes the
  ledger-private chat-ID request and support-only `session` rows. Entry objects
  contain the durable ordinal and projected message or
  sanitized terminal detail, never `providerMeta`, so storage-private metadata
  and native refs/paths are unreachable to renderers by construction. A raw
  support export for explicit diagnostics remains a separate future surface.
  Markdown and XML are rendered on the server; XML uses explicit user and
  assistant elements plus typed structural entries. Image bodies and
  structured data URLs are omitted with visible markers, while authored
  conversational text is retained. CLI-authored user presentation remains as a
  compact label or typed attributes; transport identity does not.
- **Export filtering** is a semantic fold over six closed categories:
  `tool-calls`, `tool-results`, `reasoning`, `permissions`, `diagnostics`, and
  `handoffs`. User input, assistant text, compaction summaries, and
  carryover-quarantine disclosures have the non-excludable `conversation`
  category. Original ordinals are never renumbered. The typed response records
  canonical exclusions plus per-category omitted row counts; Markdown carries
  only a compact summary of nonzero omissions. XML omits requested exclusions
  but, when at least one count is positive, emits one compact `<omitted .../>`
  element immediately before `<entries>`; its positive count attributes follow
  canonical category order and zero counts are absent. Rendered entries omit
  repeated category and timestamp labels: ordinal order and the Markdown
  heading or XML tag/type define the flow. Filtering applies to top-level
  entries, so a retained permission request still contains its requested-tool
  description.
  `garcon-cli status --messages` stays a bounded, lossy operational snapshot;
  Share stays a self-contained public snapshot copied at publish and never
  enters this export path.

Because future queued inputs are not transcript rows, the ordinary
conversational fold is already correct for direct-provider context; no
turn-aware filtering exists.

## 10. Native Sessions and the Native Drift Check

### 10.1 Role of native history

Native history is provider execution state plus the source for explicit Reload
and a materialized native-fidelity target. Garcon binds it via the `session`
row, imports one concrete native session through `nativeHistoryImport` only for
those two flows, and otherwise never reads it beyond the drift check's bounded
tail. Pre-V5 history is a separate migration input behind
`legacyHistoryImport`; it may be Garcon-owned legacy storage rather than
provider-native state and is unreachable after genesis adoption.
Ownership is concurrent-exclusive: while Garcon is actively executing or
importing a session, nothing else may write it concurrently.
Non-concurrent external use — the user talking to the provider CLI
outside Garcon and returning later — is expected and is the very case
manual reload exists to adopt.

### 10.2 The probe

```ts
interface AgentNativeActivityProbe {
  // Bounded, best-effort read of the native transcript's tail. Returns
  // the timestamp of the last conversation-relevant entry as recorded
  // by the native format itself, never filesystem mtime, never a full
  // parse. Each integration excludes its provider's housekeeping
  // entries from "relevant". Typed like every provider-touching read.
  lastActivity(ref: AgentNativeSessionRef, signal: AbortSignal):
    Promise<
      | { kind: 'ready'; value: { lastEntryAt: string | null } }
      | { kind: 'unavailable' }>;
}
```

The probe obligation: the reported relevant-entry timestamp must be no
later than core's append time for any entry Garcon observed. A provider
that cannot guarantee this returns `unavailable`. The obligation is
testable per provider with fixtures. One accepted limitation follows: an
entry created before core finished appending an earlier observed row can
be missed — a false negative, acceptable for an advisory check.

### 10.3 The check

The native drift check is a point-in-time comparison, not a watcher. One
successful active newest-history load returns its page before scheduling the
probe in a microtask. The read explicitly carries the sole
`purpose: 'activation'` marker; only the active transcript's newest request may
set it. Older pages, bounded replay continuations, background snapshots,
Chat-window previews, search, provider dispatch or resume, timers, and startup
never schedule a probe. A failed history read schedules nothing.

Each chat has at most one pending check. Eligibility is the exact tuple of
agent ID, transcript view ID, current session-row ordinal, structurally equal
native-session reference, and the latest integration-emitted provider
watermark `(ordinal, at)`. An equal request joins the pending work. Any changed
tuple aborts and supersedes it. Ineligible or execution-owned state aborts and
removes pending work. Completion removes only the attempt whose token still
owns the pending entry; there is no completed-result cache, cooldown,
last-warning watermark, or persisted scheduler state.

One strict rule, single mode:

> Warn when the native session's last conversation-relevant entry is strictly
> newer than the provider watermark timestamp for that session.

The provider watermark is the latest native-evidence row for that session:
`provider-row`, `session`, provider-origin `run-ended`, integration-emitted
permission rows, imported provider inputs with no `clientMessageId`, and the
chat-ID request, disclosure, or disabled notice. The request row carries the
marker's provider timestamp; disclosure reconstructs a provider-native control
input; disabled is synchronously anchored to the same request. Other user
inputs and notices — including generic discovery failures — plus
`permission-resolved` and core-origin `run-ended` are excluded, so they cannot
hide missed native output behind unrelated activity. The watermark carries
both row ordinal and timestamp: timestamp remains the native comparison value,
while ordinal fences ledger changes whose timestamps collide. Computing the watermark is a descending
primary-key scan bounded by `content_start_ordinal`, using a payload predicate (for
example `json_extract`) for `run-ended` origin; no normalized column or
index is added before measurement. Rows imported by reload carry native
timestamps and count toward the watermark, which keeps the check quiet
immediately after a reload. Under the probe obligation, a cleanly
finished run is quiet by construction; after a crash or interruption,
anything the provider persisted beyond the last integration-emitted row
is strictly newer and fires — which is the feature, since manual reload
is how the user adopts it.

The provider call has a five-second hard timeout. Before presenting its
result, core requires no execution ownership, re-derives eligibility, and
requires exact tuple equality. Timeout, failure, abort, `unavailable`, invalid
timestamp, ownership change, or tuple change produces no warning. This result
fence contains a provider that ignores abort.

On trigger, core sends the fixed warning as a process-lifetime
`chat-operational-notice`; it appends no ledger row and carries no durable
action. A later activation may probe and warn again for unchanged drift. The
check is advisory and permanently non-blocking: history delivery never awaits
it, and it never gates resume, requires acknowledgement, or disables
submission. False negatives and a client missing the transient event are
accepted; explicit manual Reload remains available and is the sole
reconciliation action.

## 11. Genesis Adoption and Manual Full Reload

### 11.1 Genesis adoption

Genesis adoption is the one-time conversion of a registered pre-V5 chat into
its first ledger view. It occurs on either of two explicit occasions: first
open, or the enabled transcript-search maintenance backfill. Both occasions
invoke the same `TranscriptAdoptionService` owner and are keyed only on
current-view existence: an existing current view means complete; a database
with no current view remains unadopted and retryable. Search maintenance first
uses a non-materializing existence probe, processes registered chats
sequentially under the existing 50% ingest duty-cycle pacer, and never runs on
the query request path. Under the per-chat adoption lock, core:

1. Loads the complete frozen carryover/prefix strictly before the current
   binding, including prior-agent history. Any unavailable, corrupt, or failed
   prefix read propagates as its typed failure. If the registry already holds
   a durable carryover migration quarantine, that is positively known prior
   loss rather than a read attempt: core uses no history rows for that prefix
   and prepares one transcript-content-free notice carrying the opaque
   quarantine `artifactId` and `errorCode`.
2. Calls only the owning integration's explicitly declared
   `legacyHistoryImport`, when non-null. It never calls or falls back to
   `nativeHistoryImport`. A completed empty stream is valid only when the
   supported source is absent or validly contains no importable rows;
   discovery, open, parse, conversion, sanitation, or iteration failure for a
   possible supported source propagates.
3. Rechecks the chat's ownership epoch, then creates the first current view in
   one initialization transaction. Rows are laid out as the frozen prefix and
   optional quarantine notice, then the current session fact at
   `content_start_ordinal` when one exists, then the normalized legacy rows; if
   there is no session fact, the current binding's first legacy row begins at
   that boundary. Initialization is the last step and the only
   adoption-completion marker.

No broad catch substitutes an empty source. Failure creates no current view,
does not affect unrelated chats, and a later first open, catalog refresh, or
startup search-maintenance pass retries. Search records the failed adoption as
a visible per-chat derived failure until a later adoption notification repairs
it; it never reports that chat as indexed or silently absent. The explicit
quarantine branch creates a usable view and durable visible warning instead of
silently erasing the loss or permanently dead-ending the chat. The quarantine
notice is part of the frozen prefix and survives Reload, continuation, fork,
and handoff. Every integration declares `legacyHistoryImport` explicitly so
SACS can observe the capability; core contains no provider ID, Direct parser,
or provider-storage branch. The facet is removed only after eager migration
covers every registered pre-V5 chat or support for all pre-V5 workspaces is
deliberately dropped.

The facet split preserves every migration source supported before revision 18;
it changes which core flow may invoke an importer, not whether released chats
remain discoverable. Claude, Codex, Pi, Amp, Factory, and Cursor reuse their
existing provider-owned import source and translation implementation behind
both history facets, with thin occasion-specific wrappers where absence
semantics differ. OpenCode does the same only for its supported
directory-scoped source. The three Direct integrations expose their
released-JSONL reader only as `legacyHistoryImport` and keep
`nativeHistoryImport` null. A null legacy facet is valid only when the
integration had no supported pre-V5 source; it cannot silently retire an
existing migration path. Conformance asserts each facet's behavior, never
object reference equality.

### 11.2 Manual full reload

The explicit user action "Reload from native history" exists for one
product case: the user interacted with the current native provider
session outside Garcon (or lost lines to a crash) and chooses to replace
Garcon's displayed transcript with the complete history. It exists only
for chats whose current binding has a native source and whose
integration provides a non-null `nativeHistoryImport`; a chat with no
native source (direct providers, no session yet) has no Reload action.
It is never automatic and is the sole full-transcript replacement path:

1. Core acquires the per-chat execution reservation, requires no active
   run with its `run-ended` committed, and requires an empty future-turn
   queue. The confirmation surfaces the rows the next scan would resend
   (7.2), since they will not exist in the replacement, and states that
   the current displayed history will be replaced.
2. Core collects preamble application evidence from the current binding's
   notice/input pairs. If the registry still carries a pending boundary that
   the ledger already proves consumed, core clears it only for the matching
   ownership epoch. Core then flushes the complete current in-memory registry
   state before any view replacement, even when no pending boundary remains in
   memory. This flush is required because cutover can delete the only
   zero-match boundary proof; a stale debounced `chats.json` write must never
   re-arm that boundary after restart.
3. Core closes the current view-bound sink (5.3).
4. Core creates a `staging` view row and inserts its rows
   transactionally from two sources: the frozen prefix — every row
   before the current binding's `content_start_ordinal`, carried through
   the frozen projection — and the single native import: the current
   binding, read by its owning integration's `nativeHistoryImport`
   through its current tail, excluding the binding's native
   seed/carryover context by seed receipt so the inherited prefix is not
   duplicated.
5. The frozen projection preserves conversational rows (`user-input` and
   non-error `provider-row`) with retained `clientMessageId`
   (covered by the staging view's submission unique index) and every
   `agent-switch` boundary, so the record of which agent produced which
   stretch of the conversation survives reload rather than being lost
   with the owner that wrote it. It also preserves the durable carryover
   quarantine and typed preamble-application notices, when present, because
   Reload cannot repair prior loss or discard immutable application title
   snapshots from earlier bindings. The current-session `session` row (3.4)
   is placed at the staging view's `content_start_ordinal`, so the reloaded
   view still knows its bound native session. All other sessions, `run-ended`
   rows, notices, and permission rows are not carried.
   Staged rows receive fresh dense ordinals; uniqueness and structure
   are enforced by the schema; no cross-view identity is promised.
6. Atomic cutover is one transaction in the same database: delete the
   old `current` view row — the foreign-key cascade removes its rows —
   then promote `staging` to `current`. The order satisfies the
   immediate one-current constraint, and a crash exposes a valid old or
   a valid new current view, never zero or two. A fresh database file
   per reload is deliberately not used: it would resurrect the
   pointer-file and directory-swap ceremony SQLite eliminated. Freed
   pages are reused by future appends; an optional best-effort `VACUUM`
   after cutover is housekeeping, not protocol.
7. Core issues a sink bound to the new view; the typed full-transcript
   replacement event is a core-to-client broadcast, not a sink
   publication.
8. Search deletes the replaced view's entries and indexes the new view,
   in the same per-chat order as commits; query admission is
   current-view-qualified throughout, and a not-yet-indexed replacement
   returns absent results, never stale ones.

If staging fails before the cutover, core issues a fresh sink bound to
the unchanged current view before releasing the reservation; the chat
continues unmodified. Stale `staging` views from a crash are inert and
deleted lazily on open. Requests qualified by the replaced view receive
the typed stale-view error (L8) — identical behavior whether or not the
rows still exist. Concurrent external mutation of native history during
the operation is unsupported by the product precondition; there are no
provider snapshot leases, mutation gates, or generalized reset
machinery.

Lossiness is per source. The native import is the provider's record: it
lacks Garcon-only rows other than receipt-backed preamble applications —
ordinary notices, permission history, and inputs the provider never received
remain absent — and inputs that were composed into one outgoing prompt
reappear merged as one user message, because that is what the provider
received. Before staging, core sanitizes the normalized native stream in two
ordered passes: exact carried-context removal, then exact preamble-prefix
removal. Preamble evidence comes only from an adjacent typed application
notice and receipt-bearing boundary input in the selected current binding.
The sanitizer hashes exactly each receipt's `codeUnitLength` using the shared
UTF-16LE code-unit helper, requires one
distinct matching length/hash signature, selects its earliest unused receipt
in ledger order, restores that private receipt
and boundary proof on the imported input, and reconstructs the immutable
title-only notice immediately before it. Identical prefixes consume identical
evidence in ledger order because the removed application identifier served
only as sanitation correlation and is no longer required. Core marks an
application as requiring a native occurrence when a provider-origin
`run-ended` follows it before the next ordinary non-steer input; intervening
steers remain part of that application turn. After sanitation, observed and
required counts are compared by receipt signature because identical prefixes
are intentionally indistinguishable. A missing required occurrence fails
retryably with `HISTORY_LOAD_FAILED`, preserving the current view on Reload and
aborting native-fidelity target creation. Evidence without provider-completion
proof may remain absent for the commit-before-dispatch crash window. A
malformed, unmatched, or multi-signature leading Garcon preamble frame, or an
excess native occurrence without matching evidence, fails with
`PREAMBLE_ENVELOPE_MISMATCH` before
cutover; raw injected text is never presented. The frozen prefix preserves the
prior conversational rows, agent-switch boundaries, carryover-quarantine
notices, and preamble-application notices while dropping other lifecycle rows.
The replaced view is deleted, and there is no undo. That lossiness is expected
and is part of why reload is manual and confirmed; shares published earlier
are unaffected because they are self-contained snapshots.

Native import treats an exact synthetic chat-ID disclosure input as server
control rather than user conversation and reconstructs a typed disclosure
notice at its provider timestamp. It applies the same assistant request-marker
canonicalization and reconstructs the ledger-private request row without
dispatching control. A marker-only native entry therefore remains hidden
provider evidence without fabricating an outcome.
Live success and failure notices start from the requesting provider row's
timestamp and clamp forward to the current provider watermark so asynchronous
delivery cannot regress it. A manual Reload reconstructs success from the exact
provider-native disclosure input. Disabled and failed-delivery notices are
core-only outcomes that native history cannot reconstruct and drops.

The product rule for history: external or crash-missed native activity
is adoptable only while its session is the current binding. Once
ownership moves on (handoff), the displayed prefix is frozen and final;
an activation-time operational warning is the best-effort prompt to reload
before handing off.

Continuation, fork, and genesis adoption reuse the frozen projection defined
above: a continuation/fork target's ledger begins with the frozen
projection of the source's conversational fold, agent-switch boundaries, and
carryover-quarantine notice at or below the captured watermark — copied
transactionally into the target chat's database — followed by a fresh binding.
Target-chat creation builds the target ledger completely first and registers
the chat last; startup removes unregistered target directories after the
registry loads. A native-fidelity fork that
crashes before registration may orphan a provider artifact; existing
best-effort rollback applies and the residue is a named accepted loss —
no new journal is invented for it.

## 12. Handoff, Continuation, and Fork

Three distinct product operations. None deletes a native session, and
none rewrites recorded history. "Closed" refers only to a superseded
producer binding; source sessions and source chats may continue
afterward. The canonical watermark for all of them is
`(transcriptViewId, ordinal)`.

### 12.1 In-place cross-agent handoff

Changes which agent owns an existing chat. The durable ownership
decision is written only after the outgoing producer path is closed and
the ledger checkpointed, so a crash on either side of the decision is
unambiguous:

1. Core acquires the per-chat execution reservation, requires no active
   run with its `run-ended` committed, and requires an empty future-turn
   queue (the UI directs the user to run or remove queued entries;
   nothing is silently cleared or retargeted).
2. Core closes the outgoing sink (5.3); everything accepted is already
   committed.
3. Core validates the handoff as an in-memory plan — target identity and
   configuration, and the captured watermark
   `(transcriptViewId, ordinal)` at the current high-water mark. Nothing
   durable is staged; carryover is recomputed from the immutable
   watermark whenever needed, including after restart.
4. Core forces `wal_checkpoint(FULL)` on the chat's ledger and verifies
   it completed — zero busy frames, all frames checkpointed — then the
   ownership journal records the durable decision (12.4), which contains
   the target identity/configuration and the captured watermark needed
   to reconstruct roll-forward. An incomplete checkpoint leaves the
   operation pre-decision. From the decision onward the pending fence
   rejects new admissions and publications.
5. Core appends the `agent-switch` boundary row past the watermark and
   advances `content_start_ordinal` past that row, issues the target's
   sink, and completes roll-forward; the chat's current native
   session is null until the new owner emits a session row past the
   boundary.

Handoff does not delete the old agent's native session, and its ref
remains recorded in the ledger's session rows (3.4); whether any future
product flow reuses it is outside this design. `transcriptViewId` does
not change; cursors remain valid; reads stay available throughout
(12.4).

### 12.2 Continuation to a new chat (`/handoff`)

Creates a new target chat from a source chat. The handoff record names
the captured source watermark — `(transcriptViewId, ordinal)` — and the
target identity. The target chat begins with the frozen projection of
the source's conversational fold, agent-switch boundaries, and persistent
carryover-quarantine notice at or below the watermark (section 11), followed by
a fresh binding built completely before the target is registered.
The source chat and its native session remain fully usable; later source
rows never enter the target.

### 12.3 Fork

Identical watermark semantics at a user-chosen row instead of the tip.
Carryover fork is complete at cutover for every provider.
Native-fidelity fork ships only where it is reliable — Claude, Codex, and
OpenCode — through the nullable `forking` facet consuming `providerMeta`.

Forkability is the integration's decision, never core's. Core selects the
row, hands its `providerMeta` to the `forking` facet unread, and reports
what comes back; it never inspects the blob to decide whether a point can
be forked. Only the owning integration knows what its own metadata means:
which fields identify a position, whether they need transforming before
they will match the native file, and whether the provider has persisted
far enough to honour the point at all. A row can therefore carry no
`providerMeta` at all - a live event-stream row that the provider has not
yet correlated to a turn or item - and that is a refusal to make, not an
absence for core to interpret.

The facet answers with one of three outcomes: a materialized native fork,
an unmaterialized fork, or a typed refusal meaning the row exists in the
ledger but the provider has not written it to native history yet.

A fork request therefore carries whether the caller will accept a handoff
fork - a fork seeded from the frozen conversation with no native session,
the same shape `/handoff` produces. Without that consent core asks for a
native fork only, and propagates the refusal instead of substituting
something else. The client turns that refusal into a question rather than
an error: it asks whether to continue with a handoff fork, and repeats the
request with consent if the user agrees. The refusal is a probe, not a
failure.

Falling back silently is the specific outcome this rule prevents. A
handoff fork is a good result when the user chooses it and a poor one when
it arrives unannounced, because the chat looks forked while quietly
lacking the session the original had. Native history only grows, so a
point that reads as unsettled can only become forkable before the user
answers; a request confirmed after the point settles is served as a native
fork, which is strictly better than what was offered.

Two cases should never raise the question. A provider that cannot fork natively
at all has nothing to lose against expectation. A core-authored row or
presentation-only provider error resolves to the last conversational provider
row before it, which is what branching from a non-conversational row means.
Where that resolution finds nothing — no conversational provider row from the
current binding at or before the point — there is no native position to offer, and the handoff fork is taken
without asking. Forking the whole chat rather than a point always has
one: the session tip is a native position by construction, so the request
reaches the facet even when every visible row is frozen carryover.

A fork that produces a native session seeds its feed from that session's
native history rather than from the source's rows. The forked session is
the target's execution state, and for a native fork the provider, not
core, decided what it contains; copying the source's rows across would
start the chat already disagreeing with the session it resumes from.
Core collects preamble evidence only from adjacent application/input pairs in
the source's selected current binding through the fork watermark. The target
seed runs the same carried-context-then-preamble sanitation as Reload,
reconstructing exact applications and refusing malformed, unmatched, or
multi-signature framed prefixes and excess native occurrences before the target is registered.
Receipt evidence that has no native occurrence remains valid evidence of a commit whose
dispatch or provider persistence never happened.
Handoff forks keep the frozen projection, because there is no native
session to read. The import is the one manual reload performs, with the
same lossiness: provider-native rendering, no Garcon-only rows, and
folded prompts where inputs were combined. It also composes the same way:
only the current binding is the session's to describe, so rows below the
source's content start - carryover from earlier agents, any persistent
carryover-quarantine notice, and the `agent-switch` marker between bindings -
are frozen into the target ahead of the imported rows exactly as reload
preserves them.

Forking a chat mid-turn therefore produces a feed that stops where the
provider's record stops, which is short of what the source displays. Both
providers write the prompt and their reasoning as the turn proceeds and
the reply only at the end, so the fork holds the question without the
answer. That is the honest rendering: the forked agent resumes from that
same record, and rows it has no memory of would be a fiction the chat
never recovers from. A failed import is fatal to the fork rather than a
reason to fall back, because a native session paired with a feed core
assembled is the disagreement this rule exists to prevent; the session is
discarded with the rest of the fork's artifacts.

The existing `/handoff`, cross-agent handoff, and fork implementations
are audited against these three definitions during implementation and
documented separately.

### 12.4 Decision durability and the pending fence

Carried forward from V4, with the 12.1 ordering and a narrowed fence:

- The ownership-journal decision write is the only linearization point:
  write and sync a temporary file, rename, sync the parent directory.
  The journal remains its own separately synced file — it is cross-chat
  state and does not move into any chat's SQLite database. The durable
  ownership revision it maintains for crash recovery is registry/journal
  state, never exposed through the transcript sink and never a
  transcript identity. An ambiguous rejection at any step re-executes
  the same idempotent replacement until one call returns success;
  same-process read-back is never durability proof; no registry progress
  and no rollback occur under ambiguity.
- One core pending-ownership predicate (backed by
  `AgentOwnershipJournal.hasPending`) fences command admission and
  producer publication: a decided but incompletely rolled-forward
  handoff admits no new work and accepts no new publications until
  roll-forward completes. Transcript, search, preview, and export reads
  remain available throughout: the view does not rotate, rows are
  append-only, and cursors stay valid, so there is nothing incoherent to
  serve. Recovery: no decision record means presumed abort — the source
  stays authoritative and a fresh source sink is issued; a decision
  record means roll forward before admitting work, recomputing carryover
  from the recorded watermark. Because close and the verified checkpoint
  precede the decision, neither outcome has anything volatile to
  recover. The journal entry *is* the fence, so roll-forward discharges
  it before reopening the target's producer; otherwise recovery would
  fence its own last step. Startup recovery therefore needs no ordering
  relationship with serving: a chat whose decision has not rolled
  forward rejects new work with a typed retryable error instead of
  running the superseded owner past the recorded watermark.
- Deletion is unchanged: the durable deletion decision removes the chat
  from registry and search catalog and installs the tombstone first;
  ledger and provider-artifact cleanup retries afterward with retained
  records, closing the ledger connection before removing the chat
  directory. Deletion's read-blocking is its own tombstone mechanism,
  not the pending fence.
- Restart: reopen ledgers (SQLite WAL recovery is normal startup
  behavior); drop all overlay state; fence orphan provider processes; no
  epoch rotation, no replay; ordinals and the view continue.

## 13. Direct Providers

Direct providers obey the same producer contract as every other
integration. Because they are stateless at the upstream API boundary,
each execution request needs prior conversation context:

- Core derives the canonical provider-neutral context from the
  conversational fold (section 9). Future queued inputs are not
  transcript rows, so the ordinary fold is already correct.
- Rows composed into the current outgoing prompt are excluded from that
  context, so resent inputs and the newly submitted prompt appear
  exactly once, never both in prior history and again as the prompt.
- The direct integration translates the context into the
  provider-specific request format on every turn: Chat Completions
  `messages`, Responses `input` with `store: false`, or Anthropic
  `messages`. Lifecycle and output return through the same sink.
- `nativeHistoryImport` is null and there is no native source, so direct
  chats have no Reload action (L10); their permission and lifecycle
  history is never discarded by a pointless view rotation.
- `legacyHistoryImport` is non-null while released pre-V5 Direct workspaces
  remain supported. Each Direct package privately discovers, relocates when
  required, and reads its released Garcon JSONL into the normalized import
  stream exactly once during genesis adoption. The importer is not reachable
  from ordinary serving or Reload.

New V5 turns never write or read a parallel Direct JSONL.
`DirectSessionStore` has no serving or writing role; only the narrowly scoped
legacy reader survives until pre-V5 support is retired. Core never imports a
Direct parser, names a Direct agent ID, or branches for Direct adoption.
`direct-anthropic-compatible` participates in every shared suite alongside the
other two Direct integrations.

## 14. Per-Provider Notes

Each note states edge dedup, `providerMeta` use, and the probe's
relevant-entry definition under the 10.2 obligation.

- **Claude**: persist-before-notify append-only JSONL native format.
  Micro-compaction re-appends dedupe at translation by uuid; uuid is
  stamped into `providerMeta` for native-fidelity fork and import dedup.
  The session file itself may materialize asynchronously after a turn's
  result — the CLI has been observed with no JSONL on disk moments after
  a completed turn — so a fork point resolved before the file exists
  refuses as not settled and the client retries or asks for handoff
  consent. Probe: last conversation entry timestamp (creation-stamped,
  satisfying the obligation), excluding file-history snapshots, queue
  operations, and summary bookkeeping. Importer excludes carryover seed
  context by seed receipt.
- **Codex**: the live app-server stream is the display truth and does
  not match the rollout row-for-row; the rollout is resume state and the
  reload source for the current binding. Item ids dedupe redelivery at
  the edge; native-fidelity fork retained. Probe: last
  conversation-relevant rollout entry, excluding turn markers. Note the
  stateful Responses API can itself desync from the rollout across a
  crash — the same accepted risk class this design carries.
- **OpenCode**: part-id dedup at translation; provider errors emit as normal
  `provider-row`s; real-binary scripted tier retained. A typed
  `session.status` retry arm is attached only to the session's active turn and
  emits one titled producer notice per distinct scheduled attempt; busy, idle,
  foreign-session, duplicate-attempt, and post-terminal statuses emit nothing.
  Both history facets use the same supported directory-scoped source and
  translation implementation,
  through occasion-specific wrappers where needed; they remain explicitly
  declared and are invoked only for their respective occasions. A chat that
  records no native session is the only positive legacy absence; a recorded
  session that is missing or outside the recorded directory scope fails
  legacy migration exactly as it fails Reload or native-fidelity seeding, so
  adoption creates no false-empty view and a later open retries once the
  source returns.
  This release does not add unscoped discovery for released directoryless
  sessions; improved legacy import moves with the eventual V2/support follow-up.
  Normal execution, previews, and Reload remain directory-scoped. Pinned V1
  automatic compaction runs with marker-part routing (#529): OpenCode marks
  its compaction control and continuation parts, the runtime adopts them into
  the owning turn's route, and a successful overflow summary continues the
  turn with only user-facing output. Session-latest routing remains forbidden
  and deleted. The integration has no manual compaction facet. Native-fidelity
  fork uses the provider's server-side session fork at an exclusive
  message boundary resolved from the anchor row's `providerMeta`; the boundary
  is message-granular, an unpersisted anchor refuses as not settled, and
  discard deletes the forked provider session. Probe: storage
  tail message timestamps.
- **Pi**: notify-before-persist; the ledger is the only trustworthy
  durable copy. All V4 settlement machinery (`pi-turn-settlement.ts`,
  occurrence ordinals, item aliases) is deleted. Crash-buffered Pi
  output that Pi itself persisted is detectable by the drift check and
  recoverable by manual reload; output lost before Pi persisted is gone,
  accepted. Probe: session-file entry timestamps (creation-stamped).
- **Amp / Factory / Cursor**: best-effort edge dedup where their
  protocols can redeliver; a duplicate without a real provider identity
  is an honest additional occurrence. Cursor remains unit-only; its
  probe may return `unavailable`. An integration here that cannot
  provide a reliable bounded native slice for its current binding may
  keep a private append-only import ledger; core never reads it.
- **Direct (openai-compatible, openai-responses-compatible,
  anthropic-compatible)**: context-fed producers per section 13;
  integration-owned legacy JSONL import for genesis adoption;
  `nativeHistoryImport` null; probe `unavailable`; drift check inert; no
  Reload action and no post-adoption JSONL serving.

## 15. Failure Semantics

| Window | Outcome |
| --- | --- |
| Crash before an input's acceptance commit | Input never existed; the client retries with the same `clientMessageId` and it appends once. |
| Crash after an input's commit, before dispatch | Accepted loss: a retry returns the existing row and never re-dispatches; the row shows the will-send-with-next-message affordance and the next fresh input's scan is the recovery path. |
| Pending preamble boundary with enabled matches receives an otherwise-unhandled slash command | Typed `PREAMBLE_SLASH_COMMAND_BLOCKED`; no input, notice, prefix, or dispatch; the prepared target and boundary remain available for a later ordinary input. An identical command retry returns the same typed rejection. |
| Candidate preamble catalog exceeds the combined budget after `{{chat_id}}` expansion | Mutation fails before persistence; every valid chat ID is 16 digits, so the fixed validation sample exactly bounds runtime output. |
| Crash after a preamble boundary input commits but before the registry clear is durable | The input's private boundary proof suppresses reapplication and repairs the stale pending boundary only for the matching ownership epoch. |
| Reload cannot durably flush the current registry before view replacement | Reload aborts before cutover; it cannot delete the only zero-match proof while disk still records the boundary as armed. |
| Native import contains an exact receipt-matched preamble prefix | Core strips the receipt-covered prefix, reconstructs its title-only notice, and restores the private receipt and boundary proof on the imported input. |
| Native import contains a malformed, unmatched, or multi-signature leading preamble frame, or more framed occurrences than matching receipts | Typed `PREAMBLE_ENVELOPE_MISMATCH`; Reload preserves the current view and native-fidelity target creation aborts. Raw framed content is never presented. |
| Ledger preamble evidence has no native occurrence and no later provider-origin terminal before the next ordinary input | Allowed as the commit-before-dispatch crash window; unrelated native messages import normally. |
| A completed preamble turn has fewer native occurrences than its required receipt-signature count | Retryable `HISTORY_LOAD_FAILED`; Reload preserves the current view and native-fidelity target creation aborts until native persistence catches up. |
| Crash with entries in the future-turn queue | Queue lost by design; no rows; resubmission is the user's explicit choice, idempotent by `clientMessageId`. |
| Commit failure during dequeue | The entry stays queued while the chat fences; dequeue is one synchronous block, so a retry observes exactly one identity. |
| Duplicate submission retry, same `clientMessageId`, identical content | Existing queue disposition or ledger row returned via the submission unique index; no second row; no re-dispatch. |
| Same `clientMessageId`, different content or attachments | Typed conflict; nothing appended. |
| Submission qualified by a stale view after reload | Rejected with the typed stale-view error; never deduplicated into the replacement view. |
| Presentation-only chat-row retry, same `clientMessageId`, type, title, and content | Existing row address returned; no second row, broadcast, or agent work. |
| Presentation-only chat row changes a reused ID, collides with user input, names a stale view, or races pending ownership | Typed conflict or fence failure; nothing appended or dispatched. |
| Genesis adoption positively determines no frozen or legacy rows exist | Initializes a valid empty current view; absence is not inferred from an exception. |
| Frozen-prefix or `legacyHistoryImport` discovery/read/parse/sanitation failure | Typed failure; no current view is created; later open retries; unrelated chats continue. |
| Search maintenance reaches a registered chat without a current view | A non-materializing probe invokes the sole adoption service under pacing. Success enters ordinary derived indexing; failure creates no view and is reported as a per-chat search failure until a later adoption or maintenance retry. |
| Search query names an unadopted chat while maintenance is incomplete | No ledger access or adoption occurs on the request path. The chat contributes to `unindexedChatCount`, returns no result, and remains visible as incomplete coverage. |
| Durable carryover migration quarantine | Positively known prior loss: adoption creates a usable first view with no quarantined prefix rows, one durable warning carrying the artifact reference and error code, the current session fact when present, and any successfully imported current-binding rows. The notice survives frozen-projection flows; the quarantine artifact remains available for support. |
| Dispatch failure (start or steer rejected/thrown) | Best-effort kill; core appends `run-ended: failed` with optional sanitized error detail for a turn-starting failure; preceding inputs remain eligible for the next scan only if no conversational provider output or non-interrupted `run-ended` intervenes. |
| User interrupt | Run marked stopped in memory; `run-ended: interrupted` appended immediately; provider abort best-effort; the interruption row is transparent to the resend scan. |
| Interrupt when the run already ended | Idle no-op; nothing appended. |
| Duplicate or stale `run-ended` (stopped or unknown `runId`) | Ignored; never becomes a row; cannot stop the current run. |
| Late provider content or session fact from an ended run | Commits normally in observed order while the sink is open; may interleave with a later run's output; cannot change processing state or actionability. A late session fact preserves the native ref resume and reload depend on. |
| Producer notice is blank or does not name the active run | Ignored; no row or broadcast. Provider retry behavior is unchanged because the notice is observation only. |
| Permission event lacks its concrete operation/run correlation | Structured transcript-content-free warning and drop; no synthetic run ID, durable permission row, or conversational fallback. If the dropped fact is `requested`, its provider may remain waiting on an unanswerable decision; the warning is the diagnostic and user interrupt is the remediation. |
| Permission response capability rejects | Core abandons the ephemeral claim; no resolved row is appended and the same live occurrence may be retried if its other fences remain valid. |
| Crash mid-run | No `run-ended` row; restart synthesizes nothing; the transcript simply ends; preceding inputs remain scan-eligible only if no conversational provider output intervened; accepted. |
| Runtime writes natively after its run ended | A later active newest-history load may send a transient warning when the tail is strictly newer than the integration-emitted watermark; manual reload adopts it. |
| Pinned OpenCode V1 reaches its context limit | Marker-routed automatic compaction summarizes and continues under the owning operation; a failed summary surfaces as that operation's visible provider failure. No unnamed continuation is routed by session. |
| Commit failure or unknown commit outcome | No broadcast; the chat's ledger fences for writes (4.4). |
| OS or power failure under `synchronous=NORMAL` | Recent committed-but-unsynced transactions may be lost; process-crash recovery is unaffected; within the accepted-loss posture. |
| Ledger corruption (`SQLITE_CORRUPT` on open or query) | That chat fences with a typed error; other chats are unaffected; `.recover` is the support path. |
| Publish racing sink close | Both are synchronous on the event loop: whichever begins first wins; a closed sink rejects; no race protocol exists. |
| Handoff crash after close and checkpoint, before the decision | Presumed abort: source stays authoritative; a fresh source sink is issued; nothing durable was staged. |
| Handoff crash after the decision | Roll forward from the decision record's watermark; the verified checkpoint guarantees the decided prefix survives any power loss the decision survives. |
| Incomplete handoff checkpoint (busy frames) | The operation remains pre-decision; retry or abort, never a decision over an unverified prefix. |
| Reads during a pending handoff | Served normally; only admission and publication are fenced (12.4). |
| Reload or handoff requested with queued entries | Rejected with guidance to run or remove them; nothing silently cleared or rebound. |
| History (imported or live) ending in unanswered user rows | Eligible for the next resend scan; intended behavior, not a crash inference. |
| Crash during reload staging | Staging rows are inert; the current view is untouched; stale `staging` views are deleted lazily on open. |
| `nativeHistoryImport` cannot locate, open, read, parse, sanitize, or finish the concrete session selected for Reload or a native-fidelity target seed | Typed failure. Reload performs no cutover, reissues a sink for the unchanged current view, and may be retried; native-fidelity target creation aborts and applies the existing best-effort artifact rollback rather than pairing the session with a fabricated feed. |
| Crash at reload cutover | The one-transaction delete-then-promote exposes a valid old or valid new current view — never zero or two. |
| Requests against the deleted replaced view | Typed stale-view error, identical whether or not the rows still exist; shares are unaffected because they are snapshots. |
| Fork requested at a row the provider has not persisted yet | The integration refuses with a typed retryable error; core propagates it unchanged. The same fork succeeds once native history settles, and no session-less fork is produced in the meantime. |
| Target-chat creation crash before registration | Unregistered target directory removed at startup; a native-fidelity fork may orphan a provider artifact — best-effort rollback, named accepted loss. |
| Crash-missed native output after genesis | The activation-time check compares against the integration-emitted watermark, so core-authored rows cannot mask it; a transient warning may surface it, and manual reload remediates while the binding is current. |
| Native session used externally while Garcon is idle | Expected, not a violation; a later active newest-history load may warn, and manual reload adopts it. |
| Chat deletion | Tombstone first; the ledger connection closes before the chat directory is removed. |
| HTTP client abort or five-second search deadline during synchronous reader work | The request fails with `SEARCH_TIMEOUT`; its one reader Worker is quarantined and replaced, its peer remains admissible, and no abandoned query retains a pool slot. |
| A compiled search clause has more than 10,000 matching rows | The reader consumes only the 10,000 newest rows plus the successor probe and returns `resultsTruncated: true`; the UI discloses that recent-match sampling occurred. |

## 16. Consciously Accepted Losses and Limitations

Every deliberate gap, in one place, so it is not "fixed" later:

1. A process crash loses events the provider emitted that core had not
   yet handled, and the tail of the interrupted run; a later activation may
   warn where newer native evidence exists, and manual reload recovers it;
   otherwise it is gone. This is the same loss window a provider's
   own native JSONL carries. Under `synchronous=NORMAL`, an OS or power
   failure can additionally lose recently committed transactions;
   process-crash recovery is unaffected, and the same detection and
   remediation apply.
2. There is no producer retry: a commit failure fences rather than
   retries, and whatever the fence interrupted is loss 1.
3. A crash between an input's commit and its dispatch strands that
   dispatch: a same-ID retry returns the row without re-dispatching, and
   recovery is the next fresh input's backward scan. Deliberate: the
   UUID deduplicates the command, not just the row.
4. Best-effort abort means old output can arrive after an interruption and
   interleave with a later run's output. Late conversational content
   participates normally in rendering, search, preview, context, and resend
   boundaries — it can move them. Late errors remain presentation-only. None
   of these cases receives reconciliation.
5. Crashes create no inferred interruption row. A crash with no stored
   conversational provider output leaves the preceding inputs eligible for the
   next resend scan; a crash after conversational output may not. Accepted.
6. Future-turn queued entries are lost on restart, by design, with no
   rows and no markers.
7. Resend opt-out is ephemeral: restart resets composer chips and the
   scan re-collects trailing inputs — duplication over silent omission.
   A declined input remains history and still reaches stateless
   providers as prior context; history cannot be un-said.
8. The resend scan can deliver the same input to a provider more than
   once across failures and restarts; same bias.
9. A steer followed by already-in-flight output is not collected by a
   later scan; a run that ended `failed` (visibly) also stops the scan —
   the user saw the failure and decides. Manual re-send covers both.
10. External native truncation or rewriting whose tail timestamp is not
    newer than the integration-emitted watermark goes undetected; the
    drift probe's timestamp obligation also admits false negatives, and
    `unavailable` probes are silent. The warning is process-lifetime and may
    be missed or repeated across activations.
11. Silent bit-level corruption that SQLite does not detect is
    undetected by Garcon as well (pages carry no checksums by default);
    detected corruption fences that chat only.
12. Pi output lost before Pi itself persisted is unrecoverable.
13. External or crash-missed native activity is adoptable only while its
    session is the current binding; handoff freezes the displayed prefix
    permanently.
14. Manual reload deletes the replaced view in the cutover transaction;
    there is no undo and no retained copy. Shares survive as
    self-contained snapshots; the confirmation dialog is the safeguard.
15. A native-fidelity fork that crashes before target registration may
    orphan a provider artifact; best-effort rollback only.
16. Pinned OpenCode V1 automatic compaction is adopted through marker-part
    routing into the owning turn; a compaction OpenCode fails to mark, or
    whose summary fails, surfaces as that operation's visible failure rather
    than an unnamed continuation. Released directoryless OpenCode history
    remains outside this release's supported migration discovery and is not
    recovered through an unscoped fallback; a recorded session the scoped
    lookup cannot return fails adoption visibly and retryably instead of
    adopting an empty view, so the chat stays unadopted until its source
    returns or it is deleted.
17. A carryover migration quarantine proves that some pre-V5 prefix could not
    be converted. The original artifact remains available for support, but its
    rows are absent from the ledger. A durable warning keeps that loss visible
    while allowing the chat and its current binding to remain usable.
18. A query clause matching more than 10,000 derived rows is evaluated over
    only its newest 10,000 matches. Multi-clause intersection, ranking, counts,
    and snippets can therefore omit older qualifying chats or rows. The
    response and UI disclose this with `resultsTruncated`; exact queries below
    the cap remain complete. This bounded degradation is preferred to an
    unbounded synchronous reader monopolizing the fixed pool.
19. After a chat-ID disclosure control turn is scheduled, a request marker in
    provider content with no active-run attribution is suppressed until view
    replacement or deletion. Core cannot distinguish that row from late output
    produced by the control turn. After the pending discovery delivery settles,
    a marker correlated to a different active run remains eligible; the
    conservative bias is against recursive control.
20. A chat-ID disclosure control turn uses the ordinary background lifecycle.
    The requesting turn and control turn may therefore each emit an idle or
    attention notification. Only the control input is absent from user-authored
    transcript rows; processing and provider output are ordinary.
21. While one discovery delivery is pending, later request markers for that
    chat are suppressed without a separate outcome, including markers correlated
    to a different run. The serialized delivery remains bound to its original
    emitting run; avoiding duplicate control input takes priority over an outcome
    for every overlapping marker.
22. After a discovery delivery settles, a later marker is eligible again even
    when it belongs to the same emitting run. Provider turns may survive multiple
    compactions, so run identity cannot bound discovery requests. A looping
    provider can therefore request repeated disclosures within one run; each
    iteration requires another provider emission and control delivery.

## 17. Testing Strategy

Normative case identifiers, cross-tier traceability, and gate status live in
`docs/transcript-ledger-v5-cts.md`. Shared Agent Server Conformance Suite
coverage lives under `integration-tests/tests/sacs/` and tests
provider-interface compatibility rather than duplicating the CTS inventory.
The catalog cites this revision, but its inventory is not repeated here.

- **Publisher routing (per provider)**: an event delayed until after its
  sink was closed and replaced reaches its own closed sink and is dropped
  with a warning, never the replacement; one provider session with two
  operations keeps two publishers, each event arriving through its own; a
  named route still delivers content emitted after its run's terminal; an
  event the provider did not name is dropped rather than attributed; a
  name from one chat never resolves against another chat's route;
  every supported named `runExisting` operation publishes through the same
  capability as start and resume; a provider operation with no immutable
  native carrier is disabled or dropped rather than routed by session; a new
  session retires the routes the previous source owned. Provider emitters are
  covered where they can
  drop a name: Codex's turn-item ledger names live items and the items it
  recovers after an interrupt, and its error, approval, and cancellation
  paths carry the originating turn's metadata. OpenCode exercises its one
  process-wide global stream; Codex exercises same-runtime isolation across
  independent per-operation app-server clients and processes; Claude exercises
  the reuse of one `agentSessionId` across a reload.
- **Store suite (core, once)**: transaction atomicity (a multi-row
  producer event commits all rows or none); submission unique-index
  behavior (retry returns the existing row and does not re-dispatch;
  content mismatch conflicts; staged preserved rows covered under the
  staging view); raw keyset paging (newest page and older pages by
  `(view_id, ordinal)`, one bounded query per request, ordinal density,
  raw-cursor stability through hidden rows); the
  one-current partial unique constraint with delete-then-promote cutover
  fault injection (kill between staging and cutover, and mid-cutover: a
  valid old or new current view, never zero or two; stale staging views
  deleted lazily on open); replaced-view deletion with stale-view errors
  unchanged; `user_version` validation and lazy transactional migration;
  the verified checkpoint (busy-frame handling) before the handoff
  decision; commit-failure fencing through an injected database port
  (deterministic, no chmod); per-chat corruption isolation (an injected
  `SQLITE_CORRUPT` fences one chat while others serve); WAL recovery as
  normal startup; connection close before chat directory deletion;
  in-memory next-ordinal seeding from the primary-key seek at open.
- **Queue boundary**: queued entries are not rows; dequeue is one
  synchronous block (commit row, remove entry, dispatch) with
  exactly-one-identity retries; queue removal appends nothing; restart
  loses the queue; a paused queued entry blocks reload and in-place
  handoff with guidance; steers and immediate inputs committed before
  dispatch/delivery; the no-redispatch rule for duplicate committed
  submissions.
- **Chat-ID discovery**: the cleaned assistant remainder and hidden request row
  commit atomically before synchronous delivery capture, including a
  marker-only batch. Reopen preserves the physical row. Page, replay, fanout,
  rendering snapshot, share, export, conversation, search, preview, resend,
  frozen projection, Reload, handoff, continuation, and fork surfaces never
  expose it. Native import reconstructs it without dispatch. Control tests pin
  one exact emitting-run steer, ambiguity without fallback, exact-attempt
  settlement after definitive non-delivery, one direct control reservation,
  no successor retarget or retry, no user/prepared/queue input, reservation
  release on every blocked path, and the control-turn recursion fence. Scripted
  reference providers retain immediate-steer coverage; a server integration
  case proves the direct control turn.
- **Presentation-only chat rows**: strict view-qualified notice/error request
  and response contracts; exact content plus normalized title boundaries; the
  shared submission index returning one row for an identical retry and
  rejecting changed or cross-kind collisions without fencing; the shared
  mutation lock excluding Reload and pending ownership; no agent execution,
  processing, search, preview, model-context, resend, carryover, or fork side
  effect; committed broadcast, restart, fixed-watermark replay, active and
  background browser delivery, exact-once addressed rendering, stable composer
  and preview metadata, and self-contained share formatting.
- **Sink and teardown**: capability semantics — a closed sink rejects
  synchronously, no token exists, object identity may be verified
  against the single active sink; publish commits inline and no ledger
  transaction spans an `await` (asserted via an instrumented ledger
  port); broadcast ordering through the per-chat server-event queue
  preserves the chat-messages-before-terminal-derived contract;
  publish-versus-close is decided by synchronous execution order;
  staging failure issues a fresh current-view sink; the per-flow
  teardown preconditions.
- **Run lifecycle and event rules**: interrupt marks the run stopped and
  appends `run-ended: interrupted` immediately; a duplicate or stale
  `run-ended` is ignored and never stored; a delayed old-run end signal
  cannot stop a new run; an interrupt with no active run is an idle
  no-op; late provider content commits normally; a session fact
  arriving after an interrupt still commits and restores the native ref
  (resume, probe, and reload all see it); `runId` is required on
  `run-ended`, permission, and producer notice events and absent from stored
  rows and session events; an active nonblank producer notice commits once as
  display-only history while blank and stale-run controls commit nothing; the
  prior run's rows and `run-ended` commit before the next queued turn starts;
  crash leaves no `run-ended` and restart synthesizes nothing; session as sole
  metadata writer with the registry cache repaired from the authoritative row
  at open; `start()` returns only an opaque handle; `run-ended: failed` carries
  the optional sanitized error detail through restart. OpenCode's scripted
  retry case proves one titled notice, one user occurrence, and successful
  recovery through the real pinned binary.
- **Resend scan**: pure ledger-function tests of the literal backward
  scan: the current input initializes the prompt exactly once;
  interruption `run-ended` rows are transparent; conversational provider rows,
  any `permission-requested` row, and non-interrupted `run-ended` rows stop the
  scan; notices, provider errors, sessions, and permission bookkeeping are ignored;
  steers send only themselves but are collected by later scans; dequeued
  entries run the scan; the insert-plus-scan method admits no
  interleaving; chip removal excludes for one composition only; restart
  recomputes the identical set; current-prompt rows excluded from
  context exactly once; imported histories ending in unanswered user
  rows are collected as intended.
- **Permissions**: every owning integration generates one UUID-v4
  `permissionOccurrenceId` per concrete native occurrence and requested plus
  terminal events reuse it exactly; two simultaneous occurrences with the
  same provider-native request ID have distinct UUIDs, and delayed terminals
  and decisions affect only their own occurrence. Requested events carry the
  exact response capability and are rejected when its
  `permissionOccurrenceId` differs from the lifecycle fact; terminal events
  carry none; core-authored `permission-resolved` appends only after that
  capability succeeds, and a failed response abandons the claim for retry.
  Server-instance, current-run, unresolved-state, and live-capability checks
  keep restarted history inert.
  Provider-native IDs never cross the integration boundary. Unowned events
  emit one structured transcript-content-free warning and no row. API, WebSocket,
  presentation, and browser round trips expose only
  `permissionOccurrenceId`. A codec reopen fixture loads an existing schema-v1
  `{requestId, incarnation}` payload as the sole public UUID, while an encode
  assertion proves the durable key remains `incarnation`.
- **Read folds**: the section 9 matrix as executable assertions per surface;
  the ledger-private chat-ID request is hidden from every public and
  conversational fold, while ordinary, CLI, and producer advisories remain
  notice rows; provider errors
  remain presentation-only provider rows, and rendered notice and error titles
  round-trip only through their top-level field while CLI detail remains
  provenance. Search stays suffix-only within a live view;
  replaced-view entry deletion is ordered with commits per chat, with
  current-view query admission;
  preview selection; share snapshots copied at publish and unaffected by
  reload and view deletion; ordinary export stripping `providerMeta` and
  session native refs with the raw support export separate; direct
  providers receive resent inputs exactly once; late conversational content
  participates normally in every fold while late errors remain display-only.
  Search fixtures include a clause with 10,001 matching rows and assert the
  10,000-row ceiling, successor-derived `resultsTruncated`, newest-row
  selection, multi-clause intersection within the sample, and a later exact
  query proving no persistent reader state leaked from the bounded search.
- **Drift check**: fixture native files; the probe obligation per provider
  (reported timestamps never exceed core append times for observed entries);
  successful active newest-history completion precedes scheduling and never
  awaits the probe; earlier, replay, background, preview, failed-read,
  dispatch, timer, and startup paths schedule nothing; equal pending work
  coalesces while every changed eligibility dimension aborts, supersedes, and
  fences stale results. The native-evidence watermark is `(ordinal, at)` from
  the bounded descending scan with the payload predicate; request, disclosure,
  and disabled chat-ID notices qualify, generic failure does not, and imported
  rows count. Timeout, failure,
  `unavailable`, ownership change, invalid timestamps, and abort-ignoring
  probes emit nothing. A strictly newer idle tail emits only a transient
  `chat-operational-notice`, appends no ledger row, and may warn again on a
  later activation; manual Reload alone reconciles the transcript.
- **Genesis adoption**: every integration explicitly declares
  `legacyHistoryImport`; core calls only that facet, never infers it from or
  falls back to `nativeHistoryImport`. Frozen-prefix and legacy-source
  discovery/read/parse/conversion/sanitation failures create no current view
  and retry on a later open; a completed empty stream proves that the supported
  source is absent or validly has no importable rows. Initialization orders the
  frozen prefix, optional quarantine notice, current session fact at
  `content_start_ordinal`, and legacy rows. A pre-recorded carryover quarantine
  instead proves prior loss: adoption remains usable, preserves the warning
  through frozen-projection flows, and retains the support artifact. Released
  Direct JSONL is imported once by each Direct package and remains unreachable
  from ordinary serving and Reload. Claude, Codex, Pi, Amp, Factory, and
  Cursor reuse their existing provider-owned import implementation behind both
  occasion-specific facets; OpenCode does the same for its directory-scoped
  source. Tests assert capability and behavior rather than reference equality.
  The seven scripted SACS drivers each prove supported-source absence and an
  injected read failure that creates no view and retries from the beginning;
  Amp, Factory, and unit-only Cursor prove the equivalent provider boundary at
  their strongest deterministic tier. OpenCode adoption remains
  directory-scoped; directoryless discovery is a documented follow-up, not a
  runtime fallback. Static architecture tests allow Direct package imports
  only in `server/agents/default-agent-integrations.ts` for registration and
  reject Direct IDs, Direct leaf-package or
  `@garcon/server-agent-common/direct/*` imports, `DirectSessionStore` serving
  paths, or Direct-specific adoption branches throughout core. The scan still
  inspects `default-agent-integrations.ts`; only its package-root Direct import
  declarations are excepted, and it may contain no Direct parser, store,
  common/direct import, ID branch, or adoption logic. Provider-side tests also
  lock that the restored legacy Direct module has no session-content JSONL
  write/append surface; its separate versioned relocation hook remains allowed.
  The architecture tests assert the two facets are referenced only by their
  owning flows. Search-specific coverage creates a large synthetic registry
  with only a subset adopted, proves that resync and query requests create no
  missing ledger files, and proves enabled maintenance adopts every remaining
  chat sequentially through `TranscriptAdoptionService` under pacing. It
  asserts truthful total/indexed/pending/failed/unindexed status throughout,
  visible adoption failure and later repair, no duplicate catalog work from
  the adoption callback, and a real-Worker synthetic corpus that becomes fully
  searchable without opening each chat interactively. HTTP cancellation is
  traced from `Request.signal` to the controller; a deterministic reader test
  abandons one synchronous query, proves only its Worker retires and restarts,
  and serves an immediate query through the peer.
- **Preambles**: `TLV5-PREAMBLE.01-CONTRACT-01` locks the exact public
  title-only notice and rejects private fields;
  `TLV5-PREAMBLE.02-STORE-UNIT-01` proves the adjacent atomic row group,
  boundary proof, receipt, transient prefix, and stored-body exclusion;
  `TLV5-PREAMBLE.03-SERVER-01` exercises ordered enabled matching and
  exactly-once application across new chat, fork, continuation, and in-place
  agent-switch boundaries through the server boundary;
  `TLV5-PREAMBLE.04-NATIVE-UNIT-01` proves exact receipt sanitation, including
  exact UTF-16 code-unit hashing without lone-surrogate replacement,
  completed-turn persistence-lag refusal, signature-counted identical
  receipts, and reconstructed immutable evidence;
  `TLV5-PREAMBLE.05-READ-FOLDS-CORE-UNIT-01` proves presentation/export
  inclusion and exclusion from every conversational fold; and
  `TLV5-PREAMBLE.06-LIGHTPANDA-01` exercises catalog management, enabled
  state, scoped rules, the accessible chat-ID legend, and application-row
  rendering through the SPA. Shared/store and scripted-provider cases prove
  active `{{chat_id}}` expansion, escaped literal handling, target-chat
  selection across boundary kinds, and expanded combined-budget enforcement.
  Supporting focused cases cover zero-match proof durability, blocked slash
  retention and typed replay, registry flush before Reload cutover, absent
  native evidence, fail-closed mismatches, duplicate admission, reserved
  separator boundaries, share/export privacy, and provider-neutral scripted
  prompt delivery. `server-agents/**` contains no preamble-specific code.
- **Reload**: gated on a native-bound binding with a non-null
  `nativeHistoryImport` (direct chats expose no Reload); staged build
  under a `staging` view with schema-enforced uniqueness; the frozen
  projection (retained `clientMessageId`; carryover-quarantine notice and the
  one current-session row preserved; other lifecycle rows dropped; no origin
  provenance); the
  single native import with seed-receipt exclusion; the
  delete-then-promote cutover with the replaced view gone and stale-view
  errors intact; search deletion-then-index ordering; queued entries
  blocking the flow; continuation/fork copying the projection
  into the target chat database transactionally, building fully before
  registration, with unregistered-directory startup cleanup and later
  source appends excluded. Missing, NotFound, unreadable, malformed, or
  incomplete evidence for the selected concrete native session fails before
  cutover and preserves the current view; the corresponding target-seed
  failure remains fatal to a native-fidelity fork. A successfully opened,
  validly empty native session remains a valid zero-row import.
- **HTTP paging and browser retention**: an expected view is rejected before
  any high-watermark or page scan; each HTTP request reads at most its raw-row
  budget and returns the specified raw ceiling and `nextBeforeOrdinal`,
  including a lifecycle-only page with no rendered messages. One case places a
  visible row behind a hidden run substantially longer than the raw budget and
  proves every response is bounded, continuation strictly decreases across
  several requests, and the visible row is eventually delivered. The client
  validates chat, view, limit, ordinal bounds, strict order, and continuation
  progress before mutation. The bounded cache persists the raw earlier cursor
  independently of visible rows; a hidden-only page remains resumable after
  switch-away/back and storage hydration. Active append, prepend, append-page,
  and programmatic scroll mutations never trim either edge under a reader.
  Switching chats discards the expanded interval; returning restores at most
  the bounded recent cache in exact order and can page earlier rows again. A
  fake-time case retains a bottom-pinned expanded transcript beyond the old
  180-second interval, and a static assertion proves the timer,
  `history-pruned`, and immediate-compaction machinery are absent. Compact and
  wide Chromium coverage locks final-row visibility and position.
- **OpenCode V1 compaction**: the owned process does not force autocompaction
  off and preserves operator overrides; the session-latest continuation map
  and plugin remain absent. Scripted fixtures prove threshold and first-turn
  overflow compaction continue with only user-facing output through the
  owning turn's route, overflow replay inherits operation metadata without
  duplicating the user row, and interruption during summary and continuation
  leaves the next turn clean.
- **Handoff**: the 12.1 ordering (reservation, empty queue, close,
  verified checkpoint, then decision) with fault injection at an
  injected sync/rename seam; crash before the decision restores the
  source with a fresh sink and no durable staging residue; crash after
  rolls forward from the decision record's watermark; ambiguous-retry;
  the pending fence blocking admission and publication while every read
  surface stays served; `content_start_ordinal` advancing with the
  current session null until the new owner's session row; carryover
  recomputed from the immutable watermark after restart; carryover-fork
  completeness for every provider and native-fidelity fork for
  Claude, Codex, and OpenCode. Native-fork conformance is SACS-shared:
  the oracle lives at the public transcript and registry boundary, each
  native-fork driver declares a `forking` facet whose unsettle hook
  removes a fork point from that provider's native store, and the shared
  cases prove prefix seeding with independent resume plus the
  not-settled refusal that becomes a sessionless handoff fork only with
  consent.
- **Scripted tiers**: the existing real-binary scripted suites (Claude,
  Codex, OpenCode, Pi) are retained and re-anchored on end-state ledger
  assertions through direct V5 assertions. Live credential suites
  unchanged and excluded from routine runs.

## 18. Deletions From V4

- `server-agents/common/src/transcript-projection/`: `native-audit.ts`,
  `native-boundary.ts`, identity/alias derivation in `seed-entries.ts`,
  the admission prepare/commit/promotion machinery, mutation-gate
  handoff staging, epoch/reset events in `stream.ts`/`apply.ts`,
  offset/replay/duplicate classification, and the V4 conformance kit
  (`testing.ts`).
- Provider identity work: `pi-turn-settlement.ts`, the V4 audit's
  reliance on canonical source identity, and every core read of a
  provider row ID. `attachNativeMessageSource` and
  `codex/message-source-identity.ts` survive deliberately, demoted to
  integration-private carriers: an integration stamps native identity on
  its own in-flight messages and converts it to `providerMeta` at the
  publish boundary, which is how the Claude compaction uuid and the
  OpenCode error identity reach fork and import dedup. The stamp is a
  non-enumerable symbol property, so it never crosses the shared
  boundary and never reaches a stored payload.
- Interface: `openSegment`, `loadPage`, `replay`, `commitOffset`,
  `prepareInput`, `resolveInputAdmission`, `promoteActiveInput`,
  `settledInputRequests`, `nativelyBoundInputRequests`,
  `settleNativeBoundary`, `prepareHandoffLease`,
  `prepareOwnershipSegment` (projection-level), `updateNativeReference`,
  `resolveIndexSource`/`refreshIndexSource`, source-identity and alias
  types, and the settlement hook.
- Server: projection-ingress offset classification, browser
  generation/reset protocol surfaces, content-epoch search fencing,
  pending-input settlement readers and delivery-status tracking,
  transient-only permission control plumbing (replaced by durable typed
  permission history plus ephemeral overlay), and `DirectSessionStore`'s
  serving role.
- Tests asserting deleted semantics — anything framed in terms of
  answered state, delivery evidence, durable run or attempt attribution,
  send-time durability of queued inputs, resend markers or retraction
  rows, producer batch identity, buffer-eviction drops or persisted closure
  bits, kill confirmation, producer acceptance-capacity/byte budgets,
  ownership tokens, producer FIFOs or flush protocols, retained views,
  read-fencing during pending handoff, or
  closed-component native re-import — are rewritten against section 17,
  not weakened in place.

## 19. Implementation Plan

V4 was never deployed and has no dual-format serving period. The core ledger,
producer cutover, view-qualified addressing, native Reload, and V4 deletion
precede this revision. Released pre-V5 chats still require a one-time migration
path, but revision 18 separates that occasion from Reload and closes the final
stabilization defects. The current case inventory and gate status live in
`docs/transcript-ledger-v5-cts.md`; this section fixes the architectural order.

1. **Lock regressions before each production boundary moves.** Register the
   CTS and SACS cases for one permission UUID, codec compatibility, migration
   failure/retry and quarantine, bounded multi-page hidden-row paging,
   OpenCode context exhaustion, and raw-cursor-aware switch-time browser cache
   restoration. Tests may be intentional-red only for the exact production
   behavior about to change; their owner controls the oracle.
2. **Finish exact publisher ownership.** Every provider event publishes
   through the capability captured on its concrete native operation. Complete
   the remaining unowned permission warning/drop cases. Keep the already
   stabilized stale-view validation, Factory drain isolation, and OpenCode
   event-waiter generation isolation.
3. **Migrate permission identity as one coordinated contract change.** Each
   permission-producing integration creates `permissionOccurrenceId`, carries
   the exact response capability, and keeps native request IDs private. Remove
   the composite public fields and nested maps across interface, core, API,
   WebSocket, presentation, and browser. Keep schema-v1 payload JSON stable by
   translating only in `server/ledger/codec.ts`; add an old-payload reopen
   fixture before changing production readers.
4. **Separate legacy migration from Reload.** Add required nullable
   `legacyHistoryImport` beside `nativeHistoryImport` on every integration.
   Adoption calls only the former and propagates frozen-prefix and import
   failures without creating a view; a recorded carryover quarantine instead
   creates a usable view with its persistent warning. Native providers reuse
   their supported provider-owned source and translation implementation behind
   both occasion-specific facets where appropriate. The Direct integrations
   share provider-side helpers for
   released-JSONL discovery, relocation, parsing, and streaming only through
   their legacy facets while leaving Reload null. OpenCode reuses only its
   directory-scoped source; unscoped directoryless recovery is deferred.
   Land provider-neutral static guards with this boundary.
5. **Bound HTTP presentation work and finish browser retention.** Replace the
   server's presentation-sized scan loop with one raw keyset page and expose
   the exact raw ceiling and `nextBeforeOrdinal`. Update shared/client
   relational validation, make the client continue across empty rendered
   pages, and persist the raw earlier cursor through bounded cache restoration.
   Remove the three-minute prune timer and timer-only cases; preserve
   non-destructive active mutations, then discard expanded state on chat switch
   and prove bounded-cache restoration.
6. **Route OpenCode V1 automatic compaction through the owning turn.** Keep
   the session-latest compaction plugin/map deleted, adopt OpenCode's marked
   compaction control and continuation parts into the active turn's route
   (#529), and keep autocompaction unforced on the owned process while
   preserving operator overrides. An unmarked or failed compaction surfaces
   as that operation's visible failure. Track V2/improved compaction and
   directoryless history import as follow-up work, not alternate release
   paths.
7. **Close the remaining stabilization inventory.** Complete search, native
   probe, handoff, fork, replay, LRU, duplicate-input, adoption, and migration
   checks recorded in the CTS catalog; remove temporary diagnostics and
   deprecated V4 paths within that catalog's active gate scope. Run focused
   package gates after every boundary and the complete repository release gate
   only at the final integrated HEAD.

## 20. Resolved Decisions

1. The governing posture is simplicity over crash-perfect attribution or
   recovery: no producer identity, no retry protocol, no delivery
   evidence, no durable run attribution, and no producer acceptance-capacity
   protocol; commit failures fence; a later activation may warn about crash
   loss where newer native evidence exists, and manual reload repairs it. HTTP
   pages and WebSocket replay frames have their own bounded transport
   contracts; those are not producer flow control.
2. `publish()` commits synchronously: acceptance and durability are the
   same point; no ledger transaction spans an `await`; observed order is
   synchronous-call order on the event loop; broadcast follows commit
   through the per-chat server-event queue; there is no producer FIFO,
   no flush, no close-and-drain, and no publish/close race protocol;
   commit latency is rationale, never contract.
3. The sink is a capability object and the only producer fence: core
   closes it at handoff, reload, deletion, and shutdown; no
   `agentOwnershipToken` exists. Transcript addressing and submission have
   exactly two identities — `transcriptViewId` and `clientMessageId` — while
   `permissionOccurrenceId` separately identifies one specialized permission
   fact and confers no authority. The durable ownership revision for handoff
   recovery lives in the registry/journal, never exposed through the sink.
4. Event correlation: `runId` is mandatory on `run-ended`, permission
   lifecycle, and producer notice events and absent from stored content,
   notice, and session rows. Late provider content and session facts always
   commit while the sink is open; a producer notice commits only for its
   active run; a duplicate or stale `run-ended` is ignored and never stored;
   session facts are ownership-scoped durable state fenced only by the sink.
5. Resend is the literal backward scan: initialize the prompt with the
   current input, collect preceding user inputs, skip interruption
   `run-ended` rows, notices, and provider errors, stop at conversational
   provider output, any `permission-requested` row, or any other `run-ended`;
   opt-out is ephemeral composer state; a steer sends only itself but is
   collected by later scans; the insert-plus-scan step is one synchronous
   method.
6. Runs are ephemeral in-memory correlation: a user interrupt
   immediately appends `run-ended: interrupted` and marks the run
   stopped; provider abort is best-effort with no kill confirmation and
   no fence; an idle interrupt is a no-op; a crashed run has no
   `run-ended` and restart synthesizes nothing. `run-ended: failed` may
   carry an optional sanitized `error { code, message? }` so restart
   preserves why a run failed (user-approved shape extension).
7. The session ledger row is the durable session authority: the latest
   `session` row at or after `content_start_ordinal` defines the current
   native session; the registry is an execution/listing cache repaired
   from the row at open; there is no stored binding object; reload
   carries exactly the one current-session row into the replacement
   view; handoff advances `content_start_ordinal` with the current
   session null until the new owner binds.
8. The transcript boundary is durable-before-dispatch: immediate inputs
   and steers commit before dispatch/delivery, dequeue is one
   synchronous block, and future-turn queued inputs remain
   process-ephemeral. A duplicate committed `clientMessageId` retry
   returns the row and never re-dispatches; the crash window between
   commit and dispatch is an accepted loss recovered by the next scan.
   Chat-ID discovery commits its ledger-private request evidence before one
   emitting-run steer or one direct control reservation; the disclosure itself
   creates no user input or queue entry, and its visible outcome notice is the
   sole transcript representation of accepted control delivery.
9. Submission idempotency uses the existing `clientMessageId` contract,
   scoped `(chatId, transcriptViewId, clientMessageId)` and enforced by
   the partial unique index; stale-view submissions are rejected with a
   typed error; `(transcriptViewId, ordinal)` is the canonical row
   address — there is no `rowUuid` and no origin provenance. The
   presentation-only chat-row surface shares that identity and mutation lock,
   appends no agent work, and exposes optional titles only at the top-level
   rendered message contract; ledger-private CLI detail remains idempotency
   metadata and provenance.
10. `execution.start()` returns an opaque handle; the session row is the
    sole source of session metadata.
11. Pre-V5 migration and Reload are separate capabilities.
    `legacyHistoryImport` is declared explicitly by every integration and is
    consumed only by genesis adoption; `nativeHistoryImport` is declared
    independently and is consumed only by Reload/native-fidelity operations.
    Core never falls back from the former to the latter. Adoption occurs on
    first open or from explicit paced search maintenance, and completes only by
    creating the first current view after the frozen prefix and every supported
    migration source were positively absent or read successfully. Search
    queries never invoke adoption or probe missing views. Any unknown/failing
    read aborts without a view, remains visibly unindexed or failed in search,
    and is retryable. An already-durable carryover quarantine is positively known
    prior loss: adoption creates a usable view with an empty history prefix and
    persistent warning while retaining the artifact. Direct owns its released
    JSONL reader behind the legacy facet, writes no V5 JSONL, and keeps Reload
    null. OpenCode remains directory-scoped; released directoryless recovery
    is deferred.
12. A successful active newest-history load returns before scheduling the
    native drift check for the current binding. No other read or execution
    path schedules it. Equal pending eligibility coalesces, changed exact
    eligibility supersedes it, and every result revalidates execution
    ownership. The integration-emitted watermark is `(ordinal, at)` — user
    inputs, notices, `permission-resolved`, and core-origin `run-ended` rows
    never raise it because they do not evidence native provider history. It is
    computed by a bounded descending scan with a payload predicate. A newer tail emits only a transient operational
    warning; there is no ledger notice, persisted warning state, cache, or
    cooldown. Ownership is concurrent-exclusive: non-concurrent external use
    is the reload product case, not a violation.
13. Permission lifecycle is durable typed history with one
    integration-generated `permissionOccurrenceId` UUID per native occurrence.
    Requested and terminal events reuse that UUID; provider-native request IDs
    stay private. A requested event carries the exact ephemeral response
    capability, whose occurrence ID must equal the lifecycle fact, and core
    appends `permission-resolved` only after invoking it successfully. UUID is
    identity, possession is authority, and restarted rows are inert. Unowned
    events log and drop without synthetic correlation.
    Ledger schema v1 keeps durable key `incarnation`; only the codec translates
    it, ignoring an old extra `requestId`, so no row rewrite or dual public
    field exists.
14. Shares are self-contained snapshots copied at publish (the existing
    product behavior); they never read the ledger afterward, are
    unaffected by reload or view deletion, and L8 has no exceptions.
15. Manual reload's cutover atomically deletes the replaced view in the
    same transaction that promotes staging (user choice): no `retained`
    status, no retained reads, no disk reporting, no GC policy, no undo;
    stale-view requests receive the same typed error either way; the
    same database file is reused — a fresh database per reload is
    rejected because it would resurrect pointer-file machinery — and
    freed pages are reused, with optional post-cutover `VACUUM` as
    housekeeping.
16. Handoff staging is an in-memory validated plan; the durable decision
    record contains the target identity/configuration and the captured
    `(transcriptViewId, ordinal)` watermark; carryover is recomputed
    from that watermark, including after restart; the decision is
    written only after sink close and a verified `wal_checkpoint(FULL)`
    (zero busy frames), with an empty future-turn queue; the pending
    fence blocks admission and publication only, and reads stay
    available.
17. Export privacy: authenticated ordinary user export captures a pinned
    current-view watermark, strips `providerMeta`, excludes session rows and
    their native refs, and preserves original ordinals. The typed response
    discloses semantic filtering; Markdown carries only nonzero omission counts,
    and XML carries them only in an optional compact `<omitted .../>` element
    whose positive attributes follow canonical category order. XML carries no
    requested exclusions or zero counts. Entry roles and types replace
    redundant rendered category and timestamp labels. A raw support export for
    explicit diagnostics is separate.
18. The storage engine is SQLite via `bun:sqlite`: one database per chat
    holding the current view and transient staging; `transcript_views`
    is the sole current-view authority under a one-current partial
    unique index; `content_start_ordinal` is the only normalized
    view-level field; canonical JSON payloads over normalized query
    keys; WAL with `synchronous=NORMAL` (FULL is configuration); one
    transaction per event committed inside the synchronous append; one
    protocol checkpoint, verified, before the ownership-journal
    decision; `user_version` validated with lazy transactional
    migration; no persisted ordinal counter; no routine integrity scans,
    with lazy per-chat corruption fencing; backups via the backup API or
    `VACUUM INTO`; direct synchronous use behind the ledger port with no
    Worker; the ownership journal stays a separately synced file; the
    workspace FTS search database stays separate, derived, and
    rebuildable, with replaced-view entries deletable and per-chat
    ordering between commits and view replacement.
19. Forkability is decided by the owning integration, not core, and a
    fork that cannot be native is offered rather than substituted: the
    request states whether a handoff fork is acceptable, the integration
    refuses when it is not, and the client asks the user. Core never
    reads `providerMeta` to decide, never falls back silently, and never
    raises the question for providers that cannot fork natively or for
    core-authored and presentation-only error rows, which resolve to the
    preceding conversational provider row. A fork with a native session seeds its feed from that session; a
    handoff fork keeps the frozen projection.
20. The handoff boundary is a durable `agent-switch` row rather than a
    marker synthesized from carryover segments at read time, so it
    survives chat switch, reload, continuation, and fork. Handoff writes
    it past the captured watermark and advances `content_start_ordinal`
    past it, keeping the marker with the owner it closes; roll-forward
    adopts an existing marker instead of appending a second.
21. Carryover fork is complete at cutover for every provider;
    native-fidelity fork ships only where reliable (Claude, Codex, and
    OpenCode via the provider's server-side message-boundary fork);
    target-chat creation builds the ledger fully and registers
    last, with unregistered-directory startup cleanup and fork-orphan
    provider artifacts as a named accepted loss.
22. HTTP history paging validates an expected view before reading, performs one
    bounded raw-row keyset query, reports `pageNewestOrdinal` as the clamped raw
    interval ceiling, and returns the oldest raw ordinal as
    `nextBeforeOrdinal` when more dense rows precede it, even when no messages
    render. The client owns visible-row demand: it validates every response and
    follows strictly decreasing ordinals until it has enough rows or reaches
    null. No opaque cursor, presentation-sized server scan, second existence
    query, or third transcript identity exists.
23. The selected browser transcript never trims either edge during active
    append, paging, or scroll mutations. Expanded state is selected-chat-only
    and is discarded on chat switch or reload; returning restores the bounded
    recent cache, including its raw earlier-page continuation, and pages older
    rows from the ledger. The three-minute live-edge prune timer and its state
    machine are deleted.
24. Pinned OpenCode V1 automatic compaction is marker-routed: OpenCode marks
    its compaction control and continuation parts, the runtime adopts them
    into the owning turn's route, and a successful overflow summary continues
    the turn with only user-facing output, while an unmarked or failed
    compaction surfaces as that operation's visible failure. Session-latest
    continuation routing stays deleted. Directoryless legacy import remains
    an explicit follow-up.
25. Preambles are provider-neutral core composition. The current enabled
    catalog resolves once at the first ordinary input after new chat, fork,
    continuation, or in-place agent switch. Each active `{{chat_id}}` in a
    matched body expands to that target chat's 16-digit ID, escaped tokens
    become literal, and unsupported variables remain unchanged; catalog
    validation applies the same fixed-length rendering before persistence. A nonempty slash-leading provider
    command is rejected before admission and leaves the boundary armed; core
    does not change native slash-command parsing. A matched application is one
    adjacent atomic notice/input group with a transient receipt-covered prefix
    whose digest hashes exact UTF-16 code units in little-endian order;
    a zero match still stores the boundary proof. Reload and native-fidelity
    fork use exact ledger evidence to strip and reconstruct the application,
    fail closed on an unprovable leading Garcon frame, and tolerate evidence
    absent from native history after commit-before-dispatch failure. Core
    flushes current registry state before Reload can delete the only zero-match
    proof. Provider integrations retain their existing opaque-prompt and
    normalized-history contracts; `server-agents/**` gains no preamble logic.

Also resolved across revisions: store-what-you-showed with one core ledger and
view-wide ordinals; pre-V5 adoption reconstructing the served composite from
the frozen prefix strictly before the current binding plus the explicit legacy
facet; and no V4 migration or dual-serving period.
