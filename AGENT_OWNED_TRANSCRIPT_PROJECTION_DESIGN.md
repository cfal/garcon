# Agent-Owned Conversation Ledger And Event Stream

- Status: Draft after independent architecture review
- Date: 2026-08-10
- Repository baseline: `origin/main` at `ce525b75`
- Diagnostic branch: `fix/codex-newest-line-duplication` at `e13eeae6`
- Supersedes: the split transcript/control/terminal protocol in Review 5

## Summary

Each server-agent integration owns one authoritative event stream for the current
ownership segment of a chat. The stream is the only integration-to-core order for:

- transcript commits and resets;
- integration-originated transient controls such as permissions;
- provider session creation metadata;
- execution terminal outcomes; and
- the causal identities needed for command receipts.

Core folds that stream into two different client-facing projections:

- a durable transcript projection, composed with immutable carryover segments; and
- an ephemeral transient-control projection, cleared on server restart.

Those projections have different retention and browser transport rules, but they do
not require separate integration event logs. Keeping transcript, controls, and
terminals in one source order removes the barriers, cross-facet pins, acknowledgement
tokens, and causal rejoining rules that made earlier drafts fragile.

Every integration binds one normalized, append-oriented conversation ledger as the
rendering authority for the full life of an ownership segment. Finalized notifications
write it; native history may bootstrap it, import a crash-missed suffix, or audit native
execution continuity, but native reads never become a competing page/reload renderer.
Routine provider compaction, retry, rollback, and context pruning change provider
execution state, not rows that Garcon already showed. The store may be the shared Garcon
journal, an existing integration-owned JSONL implementation, or an equivalent private
database. Core does not know the physical strategy. The observable contract is:

- exactly one writer per `(chatId, agentOwnershipEpoch)` segment;
- one unchanging rendering authority whose committed envelopes are re-served byte for
  byte;
- one append-only conversation ledger whose ordinary provider context changes cannot
  rewrite previously committed occurrences;
- one fencing epoch on every request and event;
- one stream epoch, monotonically increasing offset, and canonical event digest;
- explicit serialized entry identity and operation provenance;
- durable journal or provider persistence before durable event publication;
- idempotent application with replay and relist recovery;
- projection-state-pinned pagination unaffected by transient-only events;
- projection-owned input admission before provider execution;
- terminal events ordered after all emitted transcript/control events and carrying a
  mandatory producer-completeness assertion;
- a single core consumer-offset commit for replay retention; and
- a single durable coordinator decision record for ownership handoff.

Core continues to own command admission, queueing, execution reservations, immutable
carryover, cross-agent handoff coordination, browser generations, HTTP/WebSocket
delivery, bounded view caches, and provider-neutral search.

The central invariant is:

> Within one ownership epoch, exactly one integration assigns current-segment entry
> identity, exactly one integration projection store defines rendered history, and
> exactly one integration stream orders every causally relevant event.

## Decision

The design adopts a single-writer, event-sourced current segment backed by a durable
conversation ledger. It rejects both the current dual-authority architecture and the
earlier proposal to expose three ordered integration channels and rejoin them in core.

The coordinated API version 4 cutover makes these changes:

- `AgentIntegration.transcript` becomes a required `AgentTranscriptStream` facet.
- `AgentExecutionEvent.messages`, `finished`, and `failed` are removed.
- The separate execution event callback is removed; transcript commits, resets,
  transient controls, session metadata, and terminals become variants of
  `AgentStreamEvent`.
- Accepted input is prepared and committed through the stream owner before execution.
- Core applies one event chain and commits one consumer offset.
- A terminal carries a mandatory accepted-input set and attributable-entry count. This
  does not replace provider-specific preterminal completeness tests.
- Every transcript-row removal rotates the stream epoch and browser generation.
- Provider context compaction appends an observable compaction entry when one exists and
  advances private native-retention metadata; it never rewrites the conversation ledger.
- Transient controls remain process-only and are never journaled or reconstructed.
- Browser transcript and transient state remain separate, joined by one compound
  generation transition when a reset occurs.
- Cross-agent handoff uses a mutation-excluding outgoing lease and the core ownership
  journal as the sole durable transaction decision record.

Codex uses finalized app-server notifications to write a full normalized conversation
journal and uses rollout history only for native bootstrap, suffix repair, and
continuity audit. Claude and Pi use the same journal model with their provider-specific
repair and settlement rules. Direct providers adapt their existing fsynced JSONL as the
same logical authority. Search, preview, sharing, export, carryover, and fork lookup all
read these stored envelopes rather than asking a provider to render them again.

## Why The Previous Design Kept Growing

Garcon currently has two active transcript writers:

1. `AgentExecutionEvent.messages` supplies finalized live rows.
2. `AgentTranscript.load()` and `loadPage()` supply provider-native history.

Core reconciles them in `ChatViewStore`, although core cannot know whether provider
persistence leads a callback, whether a read is safe during execution, whether one
native item renders several rows, or whether a changed history is append growth or a
rewrite.

The first projection draft correctly moved transcript authority into integrations but
kept three integration-to-core orders:

- transcript transitions;
- transient-control transitions; and
- execution terminals.

It then needed transcript watermarks to rejoin terminals, transcript anchors to rejoin
controls, reset dispositions to rejoin resets and controls, two acknowledgement
namespaces, cross-facet retention pins, and special proofs for an empty control epoch.
Review repeatedly found races at those joins. The source integration already serialized
all three under one mutation gate, so discarding that order was unnecessary.

This revision preserves the separate durable and ephemeral projections but folds them
from one source stream.

## One Authority, Multiple Evidence Channels

"One source" means one store whose normalized envelopes define rendering, identity, and
order for a segment. It does not mean one physical observation channel. Notifications
remain the low-latency doorbell; provider-native history remains necessary for first
import, crash repair, external-edit detection, and native fork/resume mapping. Both write
or audit the projection store and neither is a second serving source.

This removes permanent live-versus-history rendering parity, Codex's native-content plus
metadata join, provider-specific runtime paging, audit-driven row morphing, and native
reads during handoff freeze. The native importer and live converter need to agree on
canonical source identity, but they do not both render an already committed occurrence.

The conversation ledger and provider context are deliberately different records. The
ledger answers "what did Garcon show in this conversation?" Provider-native storage
answers "what context can this provider resume or fork?" Automatic compaction, retry,
microcompaction, and native retention may change the second answer without changing the
first. A provider-observed new suffix appends to the ledger. Divergence at an already
committed source degrades native continuity and requires an explicit user/operator
adoption before it can rewrite the ledger.

This does not remove browser generations because `input-not-sent`, explicit user
revert/truncate, deliberate external-history adoption, journal repair, schema migration,
handoff, and process restart can still invalidate an address. It also does not remove
native-continuity tracking, terminal completeness, or handoff leases: those protect
provider execution state, producer completeness, and ownership transfer rather than
choosing a transcript source.

## Goals

- Make provider strategy private to the owning integration.
- Guarantee one canonical identity and order for every current-segment occurrence.
- Bind each segment to one rendering authority and never re-derive committed rows from a
  different source at reload, paging, search, or handoff time.
- Preserve the complete conversation ledger across routine provider context compaction,
  rollback, retry, and retention changes.
- Preserve equal-content distinct occurrences and reject content-based deduplication.
- Make initial load, live updates, paging, reconnect, restart, search, fork, and handoff
  derive from the same normalized projection.
- Preserve low-latency finalized output where providers support it.
- Make accepted-input and terminal completeness explicit protocol obligations.
- Preserve one immutable receipt owner across an initial input and every steer.
- Keep permissions and other execution state ephemeral across restart.
- Keep carryover and cross-provider composition provider neutral.
- Make provider-context retention and native fork availability explicit without using
  them as transcript retention policy.
- Replace inferred reconciliation with append events and explicit resets.
- Reuse one shared engine and conformance kit across integrations.
- Delete central native/live reconciliation after cutover.

## Non-Goals

- Replacing provider-native execution, resume, or fork storage.
- Giving the current integration authority over prior carryover segments.
- Forcing every provider to use the same file format or physical storage engine. Every
  provider does expose the same normalized projection-store semantics. "Equivalent
  private database" means an existing integration-owned store or a future explicitly
  approved architecture change; it does not waive the no-new-SQLite rule below.
- Streaming token deltas.
- Recovering queue entries, pending inputs, command-ledger state, permissions,
  processing, or active turns after restart.
- Preserving API version 3 compatibility. Server and client ship together.
- Inferring identity from content, timestamps, or physical array position.
- Adding another SQLite database. Provider-neutral transcript search remains the only
  SQLite owner.
- Supporting multiple core consumers or distributed server replicas in this version.
  One process-local core consumer is a structural assumption.

## Complexity Budget And Product Tradeoffs

The design keeps the constraints that define the product: low-latency finalized output,
exact receipts, ephemeral controls, explicit rewrites, and one provider-owned active
segment. It deliberately pays simpler visible recovery in three places instead of
building hidden coordination:

- A provider context change discovered at turn settlement does not rewrite the
  conversation. The integration appends any newly observed occurrences, advances its
  private native-retention floor when provider evidence proves old context was pruned,
  then emits the terminal. Divergence at an already committed source degrades native
  continuity and fences unsafe resume/fork operations; it does not silently reset rows.
- Every server/integration stream restart rotates the stream and browser generation.
  The client performs one complete resync rather than the server recovering volatile
  offsets, control state, or clean-shutdown markers.
- Removing a known-not-sent active input rotates generation. That visible reset avoids
  reusable sequence numbers, transcript tombstones, and a second browser mutation
  cursor.

At most one unresolved active admission is also an intentional throughput limit: a
later steer waits until the prior input is promoted, discarded, or repaired. It makes
the only mid-turn removal exactly identifiable and bounded.

Two larger relaxations would remove more machinery but change the product too much.
Withholding all assistant/tool rows until terminal would eliminate the low-latency
changefeed requirement, but regress the core chat experience. Persisting executions and
permissions would permit a Temporal-like durable workflow, but would resurrect stale
actions after restart unless the whole execution model changed. Neither is adopted.

One rendering authority removes live-versus-history transformation; it does not make
provider execution history immutable. Garcon stops treating that mutability as UI
history mutability. Only an explicit destructive conversation operation,
`input-not-sent`, approved repair/migration, handoff, or process restart causes a reset
or generation rotation. The generation protocol addresses real address invalidation and
browser cache safety, not source selection or ordinary provider compaction.

## Feasibility And Cost

This constraint is feasible for every built-in integration if the unchanging source is
the integration-owned normalized ledger. It is not feasible at current UX latency if it
means "Codex native pages only": `thread/turns/list` is a full replay/pagination API,
merges active memory, can contend during execution, and does not persist Garcon
provenance. Waiting until terminal would make it technically single-source but would
remove live assistant/tool updates. Tailing private rollout storage would still require
a provenance sidecar and would bind the hot path to an upstream internal format. The
full journal is the smaller and more stable boundary.

The price is explicit:

- Codex, Claude, Pi, and similar providers duplicate normalized rendered content next
  to native execution storage;
- each adapter still needs a native importer/auditor, but it is a private producer and
  continuity checker rather than a second renderer;
- cross-process provider/journal commits have crash windows that conformance tests must
  repair or surface as degraded;
- committed rows do not silently benefit from later converter improvements; deliberate
  re-rendering is a migration with a new content epoch;
- automatic provider compaction no longer shrinks Garcon's UI/search ledger, so physical
  journal/search retention needs explicit product policy; and
- a displayed row may remain available after its provider-native fork point has been
  compacted, which the UI must report honestly.

Those costs buy one stable user-visible history, deterministic search/share/carryover,
provider-neutral core logic, and removal of the live/native reconciliation layer. The
design therefore recommends this constraint. Storage and initial import latency should
be measured, but they are optimization inputs, not reasons to preserve dual authority.

## Protocol Basis And Prior Art

The protocol borrows contract shapes from established systems rather than claiming
cross-system exactly-once delivery:

| Prior art | Relationship | Adopted lesson | Garcon use |
| --- | --- | --- | --- |
| [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | Direct pattern | Fold one ordered event log into projections; rebuild from snapshots and replay. | The integration stream is the process-incarnation source order; transcript and control maps are folds. |
| [CQRS](https://martinfowler.com/bliki/CQRS.html) | Direct read-model precedent | Keep the write model authoritative and build disposable, purpose-specific read models from it. | The conversation ledger is authoritative; search, previews, browser pages, shares, and receipts are projections and never repair the ledger backward. |
| [The Log](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying) | Direct architectural precedent | A durable ordered log decouples the historical fact record from downstream materializations and service-specific state. | Provider execution context may compact independently while the user-visible conversation record remains stable. |
| [KurrentDB catch-up subscriptions](https://docs.kurrent.io/clients/node/legacy/v6.2/subscriptions.html) | Closest protocol precedent | Read from a checkpoint, then continue with live events; persist a processed position for recovery. | `openSegment()` plus buffered subscription and `replay()` form a local catch-up subscription. |
| [Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html) | Direct pattern | Commit durable state before publishing; assume the relay may deliver more than once. | Journaled integrations sync durable transitions before emitting them. |
| [Idempotent Receiver](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html) | Direct pattern | Deduplicate by stable delivery identity, never payload similarity. | `(epoch, offset, digest)` is the uncommitted inbox identity; entry IDs preserve equal content. |
| [Kafka delivery semantics](https://docs.confluent.io/kafka/design/delivery-semantics.html) and [KIP-98 control records](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging) | Direct pattern | Consumer offsets bound replay; filtered records may occupy positions without becoming application data. | Core folds before committing one offset; volatile events explain non-contiguous durable journal offsets. |
| [Kubernetes LIST/WATCH](https://kubernetes.io/docs/reference/using-api/api-concepts/) and [etcd watch compaction](https://etcd.io/docs/v3.5/learning/api/) | Direct recovery precedent | Versions are opaque; an expired watch position requires relist, not guessed deltas. | Replay returns a contiguous chain or `expired`; core relists through `openSegment()`. |
| [Matrix `/sync`](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync) | Partial precedent | One sync response can carry persistent room timelines and explicitly ephemeral state under one continuation token. Matrix does not promise Garcon's total cross-kind order. | It supports the mixed-durability transport shape, not the stronger source-order guarantee. |
| [IMAP `UIDVALIDITY`](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.1.1) and [JMAP `/changes`](https://www.rfc-editor.org/rfc/rfc8620.html#section-5.2) | Direct sync-recovery precedent | A local materialization may consume incremental upstream evidence, but an invalid generation or `cannotCalculateChanges` response requires explicit resync. | Native history feeds the segment's projection store; it never silently replaces that store's addressed rows. |
| [Kafka log compaction](https://kafka.apache.org/documentation/#compaction) | Useful contrast | Compaction is a retention policy for one log, not permission for a downstream audit trail to reinterpret already consumed occurrences. | Provider context compaction advances native availability metadata while the separate Garcon conversation ledger keeps what the user saw. |
| [Elasticsearch alias changes](https://www.elastic.co/guide/en/elasticsearch/reference/current/aliases.html) | Search cutover precedent | A rebuilt index becomes queryable through an atomic versioned cutover instead of mixing old and new result spaces. | Search queries carry the expected composite content epoch; a destructive transcript replacement hides stale rows immediately until the matching index seals. |
| [Fencing tokens](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) | Direct pattern | Every effect carries an ownership generation and stale owners are rejected at the resource. | `agentOwnershipEpoch` fences requests, events, offset commits, fork points, and leases. |
| [Consensus on Transaction Commit](https://s2.smu.edu/~mhd/8330f11/p133-gray.pdf) and [R* presumed abort](https://dl.acm.org/doi/10.1145/214451.214456) | Direct handoff precedent | One durable coordinator record decides commit; before that decision recovery may presume abort, and after it recovery rolls forward. | The core ownership journal's `commit-decided` record is the sole durable handoff decision. |
| [xDS state-of-the-world updates](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol) | Analogy | Install complete related state atomically instead of exposing partial halves. | A browser generation reset carries the complete transient map in one message. |
| [Temporal activity idempotency](https://docs.temporal.io/activities) | Analogy | Ambiguous completion is resolved by query/retry with an idempotency key, not compensating a maybe-committed effect. | Input admission is keyed by ownership epoch and client request ID. Garcon deliberately does not persist execution history. |
| [CDC resolved frontiers](https://www.cockroachlabs.com/docs/stable/change-data-capture-overview) | Analogy | A frontier says no earlier source mutation remains, while retention protects the needed range. | A terminal is an ordered turn frontier with a producer-completeness assertion. |

The browser generation/sequence contract and the split between projection durability
and provider-native continuity are Garcon-specific. None of these precedents turns the
single-process design into a distributed consensus protocol.

## Terminology

**Ownership segment**

Rows and events produced while one integration owns a chat under one
`agentOwnershipEpoch`.

**Conversation ledger**

The append-oriented normalized record of occurrences Garcon committed and showed for
one ownership segment. It is the rendering system of record. Ordinary provider
compaction, retry, rollback, or context pruning cannot delete or reinterpret its rows.

**Provider execution context**

The provider-native state used for resume, continuation, compaction, and native fork.
It may retain less history or a different summarized context than the conversation
ledger without becoming a second rendering authority.

**Fencing epoch**

The ownership epoch attached to every effect. A stale epoch is rejected before any
stream comparison.

**Stream epoch**

An opaque generation for one append-only stream interpretation. It changes on every
row removal, rewrite, or integration process restart. Offsets and ordinals are meaningful
only inside this epoch.

**Ledger content epoch**

An opaque durable-content lineage for one segment. It is stable across append,
promotion, `input-not-sent`, provider context compaction, and process restart when the
durable ledger prefix is unchanged. It rotates only when durable ledger rows are
removed, reordered, or rewritten by an explicit destructive operation or approved
repair/migration.

**Stream offset**

An opaque monotonically increasing event position within a stream epoch. It is the only
integration-to-core causal cursor.

**Projection state**

The current transcript materialization address and integrity proof: stream epoch,
counts, ordered durable revision, and active-suffix state revision. Transient-only
events do not change it. Pages pin projection state rather than the latest stream
offset; `stateRevision` detects corruption but is not another cursor or generation.

**Entry ordinal**

The one-based position of an entry inside a stream epoch. Appends do not change earlier
ordinals. A reset creates new ordinals in a new epoch.

**Durable prefix**

The contiguous prefix included in restart, preview, sharing, export, carryover, search,
and fork lookup. One accepted but not yet provider-owned user input may form an active
suffix.

**Projection durability**

Garcon can reproduce the rendered row after restart. It does not imply that the
provider can resume or fork from the corresponding native state. Native continuity is
tracked separately.

**Native retention floor**

Integration-private, monotonic metadata naming the greatest ledger ordinal at or below
which exact provider-native alignment is no longer expected. Audit identity matching is
required above the floor. A fork at or below it returns typed native-unavailability
rather than treating a rendered row count as a provider offset.

**Rendering authority**

The one integration-owned normalized projection store bound when a segment is created.
It supplies every rendered page, reload, search row, frozen carryover entry, and entry
lookup for that segment. Provider notifications and native history are evidence written
through this authority, never alternate read-time renderers.

**Composite search content epoch**

Core's durable-content fence for a complete visible chat, derived from carryover
revision, current ownership identity, and current ledger content epoch. Append-only
growth preserves it. Destructive durable replacement, carryover recomposition,
handoff, or deletion invalidates it immediately even while the derived search index
catches up. Core durably mirrors the current segment content epoch in the chat registry
so cold-chat query admission does not depend on the search database itself.

**Event digest**

A canonical digest of one complete stream event with the digest field omitted. It
proves duplicate identity and detects contradictory offset reuse.

**Consumer offset commit**

Core's idempotent acknowledgement that it atomically applied every event through one
checkpoint. It releases process-local replay retention; it does not acknowledge browser
delivery.

**Turn-receipt owner**

The immutable non-steer command identity captured when a turn acquires execution.
Steers retain separate delivery receipts but cannot take terminal output ownership.

**Terminal completeness assertion**

The exact accepted-input entry IDs and attributable-entry count declared by the
integration at the terminal frontier and independently checked by core.

**Compound generation transition**

One browser event that installs a new transcript generation and its complete transient
state together.

**Handoff decision record**

The single durable ownership-journal record that makes a transfer committed. Before it,
recovery aborts; after it, recovery rolls forward.

## Normative Invariants

The implementation and conformance kit use these identifiers rather than restating the
rules in each later section.

**INV-1 One writer.** The owning integration is the sole source of current-segment
entry identity and event order. Core only folds and composes.

**INV-2 Fencing.** Every request, event, page, replay, offset commit, terminal, fork
point, and handoff handle names `(chatId, agentOwnershipEpoch)`. Stale ownership is
rejected before stream comparison.

**INV-3 One causal order.** Transcript, integration control, session, and terminal
events share one stream epoch and offset sequence. Core never reconstructs causality
from callback arrival order.

**INV-4 Append-only epoch.** No surviving entry changes identity, ordinal, provenance,
or payload within an epoch. The one typed active-to-durable promotion binds source and
lifetime exactly once. Every removal, reorder, or payload rewrite is a reset to a new
epoch.

**INV-5 Explicit identity.** Entry, source, semantic subrow, and operation identities
are ordinary serialized fields. Equal content with different entry IDs survives.

**INV-6 Idempotent inbox.** Above core's committed offset, equal `(epoch, offset)` plus
equal event digest and complete checkpoint is a duplicate; unequal data at that address
is corruption. An event at or below the committed offset is settled past and is ignored
without needing an evicted digest proof. An unknown gap causes replay; an expired
position causes relist.

**INV-7 Mixed durability.** Transcript commit/reset state may be journaled. Control and
terminal events are never journaled or reconstructed. Every integration process restart
creates a new stream epoch and an empty control fold.

**INV-8 Outbox ordering.** A durable transition is synced in the authoritative
integration store, or proven provider-durable, before it is published.

**INV-9 Projection paging.** Pages are pinned to projection state. A control, session,
or terminal event may advance the stream offset without invalidating an otherwise
identical page chain.

**INV-10 Input admission.** An input cannot become runnable before its projection commit
is applied. Admission is idempotent by `(ownershipEpoch, clientRequestId)`, and at most
one unresolved active input exists per segment.

**INV-11 Reset discipline.** `input-not-sent` removes exactly one proven trailing active
input and preserves the durable prefix, ledger content epoch, and control fold. A
durable reset is allowed only for an explicit user revert/truncate, user-confirmed
external adoption, or approved journal/schema repair. It installs a fully durable target
and clears controls only when the producer has no open turn. Routine provider context
changes are commits or private continuity metadata, never resets.

**INV-12 Receipt ownership.** One immutable non-steer owner receives all assistant
output and terminal state for a turn. A steer owns only its delivery receipt.

**INV-13 Terminal frontier.** A terminal is an ordered stream event. Success requires
the complete accepted-input set, matching attributable-entry count, no active suffix,
and confirmed native settlement. Failure to prove these fails the command and fences
later admission until repair.

**INV-14 Offset retention.** The integration retains every process-local event after
core's committed offset. Core retains duplicate proofs for exactly the applied offsets
above its last successfully committed offset. Offset commits are monotonic, idempotent,
provider-IO-free, and release only the acknowledged prefix on both sides.

**INV-15 Control lifetime.** Control rows belong to the current turn owner, use
`(id, incarnation)` identity, and are cleared by terminal, handoff, deletion, restart,
or a destructive durable reset. They never enter transcript pages, search, carryover,
or fork state.

**INV-16 Browser atomicity.** A transcript reset and transient rebase/clear reach the
browser as one state-of-the-world transition. Network ordering is guarded by server
instance, generation, transient revision, and state digest.

**INV-17 Safe reads.** Every provider-touching read returns typed
ready/deferred/degraded state. Stream apply, replay, and offset commit never perform
provider IO.

**INV-18 Handoff commit.** The outgoing lease fences mutations from freeze through a
durable core decision. The ownership journal contains the only durable decision record.
Recovery aborts before it and rolls forward after it.

**INV-19 Native continuity.** Projection durability and provider resume/fork continuity
are independent. Audit cannot delete or morph a committed row merely because provider
history is shorter or differently rendered. A monotonic native-retention floor limits
identity comparison and fork eligibility without limiting ledger visibility.

**INV-20 Source parity.** Runtime pages, search, preview, share/export, handoff freeze,
and fork entry lookup are reads of the same projection store and therefore use the same
durable envelopes and ordered revision. Only the final entry-to-native fork resolution
touches provider execution storage.

**INV-21 Core neutrality.** Core never branches on provider ID, provider error text,
native shape, or projection strategy.

**INV-22 Unchanging rendering authority.** One normalized projection store defines a
segment's envelopes for its full lifetime. Live notification, native import, and audit
may append through it or justify an explicit epoch-resetting replacement inside it.
No page, restart, search, handoff, or fork lookup derives rendered content by joining or
switching between provider-native and Garcon stores.

**INV-23 Conversation/context separation.** Automatic provider compaction,
microcompaction, retry, rollback, or retention cannot change a committed ledger
envelope. Observable finalized summaries and attempts append as new occurrences;
unobservable native changes update only continuity metadata.

**INV-24 Search fencing.** Search is a rebuildable projection of the durable composite
ledger. Every query and result is qualified by the expected composite search content
epoch. Append lag may expose a verified old prefix inside that epoch; a destructive
change makes the prior epoch ineligible after core applies and durably mirrors the new
epoch. A query already linearized on the old epoch may return only old-epoch-qualified
results, which current-state validation rejects. A reset committed only in the
integration store before a crash remains the last core-applied search state until cold
open observes it; navigation is still fenced.

## API Version 4 Contract

Phase 1 introduces version 4 names alongside API version 3. The coordinated cutover
replaces the old surface only after every built-in integration and core caller compiles.

### Identity And Checkpoints

```ts
import type { ChatMessage, UserMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';

declare const streamEpochBrand: unique symbol;
declare const streamOffsetBrand: unique symbol;
declare const entryIdBrand: unique symbol;
declare const eventDigestBrand: unique symbol;
declare const projectionRevisionBrand: unique symbol;
declare const transcriptContentEpochBrand: unique symbol;

export type AgentStreamEpoch = string & { readonly [streamEpochBrand]: true };
export type AgentStreamOffset = string & { readonly [streamOffsetBrand]: true };
export type AgentTranscriptEntryId = string & { readonly [entryIdBrand]: true };
export type AgentEventDigest = string & { readonly [eventDigestBrand]: true };
export type AgentProjectionStateRevision = string & {
  readonly [projectionRevisionBrand]: true;
};
export type AgentTranscriptContentEpoch = string & {
  readonly [transcriptContentEpochBrand]: true;
};

export interface AgentSegmentIdentity {
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
}

export interface AgentProjectionState {
  readonly epoch: AgentStreamEpoch;
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly total: number;
  readonly durableCount: number;
  readonly durableRevision: AgentTranscriptRevision;
  readonly stateRevision: AgentProjectionStateRevision;
}

export interface AgentStreamCheckpoint extends AgentSegmentIdentity {
  readonly offset: AgentStreamOffset;
  readonly projection: AgentProjectionState;
}
```

`offset` is the causal position. `projection` is a derived state identity. A control,
session, or terminal event advances only `offset`; its previous and resulting projection
values are identical. Transcript pages pin `AgentProjectionState`, so chatty progress or
permission events do not invalidate history paging.

Offset zero is the installed genesis state of an epoch. A non-reset event keeps the
projection epoch and advances to the next offset. A reset consumes the old checkpoint
and installs offset zero in a fresh projection/stream epoch; the reset digest is the
transition proof for that genesis address. `input-not-sent` preserves `contentEpoch`
because it changes only the active suffix. A durable destructive reset rotates it. The
shared comparator is the only code that interprets offset encoding.

Every new process incarnation rotates `AgentStreamEpoch`, even after clean shutdown.
This intentionally trades one reconnect-generation reset for simpler, fail-closed
recovery. Entry IDs and durable revisions remain stable; offsets are never recovered or
reused across processes. The ledger content epoch remains stable when recovered durable
content is identical, so search and immutable exports do not churn merely because the
server restarted.

### Operation Identity

```ts
export type AgentOperationCommandTypeV4 =
  | 'chat-start'
  | 'agent-run'
  | 'fork-run'
  | 'agent-compact'
  | 'steer';

export interface AgentTurnReceiptOwner {
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly commandType: Exclude<AgentOperationCommandTypeV4, 'steer'>;
  readonly clientRequestId: string;
  readonly turnId: string;
}

export interface AgentOperationIdentityV4 {
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly commandType: AgentOperationCommandTypeV4;
  readonly clientRequestId: string | null;
  readonly clientMessageId: string | null;
  readonly turnId: string;
  readonly turnOwner: AgentTurnReceiptOwner | null;
}

export interface AgentTurnBoundOperationIdentityV4
  extends AgentOperationIdentityV4 {
  readonly turnOwner: AgentTurnReceiptOwner;
}

export interface AgentTurnOwnerOperationIdentityV4
  extends AgentTurnBoundOperationIdentityV4 {
  readonly commandType: AgentTurnReceiptOwner['commandType'];
  readonly clientRequestId: string;
}

export interface AgentTranscriptAdmissionIdentity
  extends AgentTurnBoundOperationIdentityV4 {
  readonly commandType: Exclude<AgentOperationCommandTypeV4, 'agent-compact'>;
  readonly clientRequestId: string;
}
```

Core constructs one `AgentTurnReceiptOwner` when execution ownership begins. Every
steer carries that nested owner while retaining its own command type and request ID.
Internally initiated terminal-bearing work receives a core-generated request ID. Base
identities with a null owner are limited to non-turn lifecycle work and cannot produce
entries, controls, or terminals.

### Entry And Event Types

```ts
export interface AgentTranscriptSourceIdentity {
  readonly namespace: string;
  readonly itemId: string;
  readonly subrowId: string;
}

export interface AgentTranscriptProvenance
  extends AgentTurnBoundOperationIdentityV4 {
  readonly upstreamRequestId: string | null;
}

export interface AgentTranscriptEntry {
  readonly id: AgentTranscriptEntryId;
  readonly lifetime: 'durable' | 'active';
  readonly source: AgentTranscriptSourceIdentity | null;
  readonly provenance: AgentTranscriptProvenance | null;
  readonly message: ChatMessage;
}

export interface AgentTranscriptPromotion {
  readonly entryId: AgentTranscriptEntryId;
  readonly source: AgentTranscriptSourceIdentity;
}

interface AgentStreamEventBase extends AgentSegmentIdentity {
  readonly previous: AgentStreamCheckpoint;
  readonly checkpoint: AgentStreamCheckpoint;
  readonly digest: AgentEventDigest;
}

export interface AgentTranscriptCommitEvent extends AgentStreamEventBase {
  readonly kind: 'commit';
  readonly promoted: readonly AgentTranscriptPromotion[];
  readonly appended: readonly AgentTranscriptEntry[];
}

export interface AgentTranscriptResetEvent extends AgentStreamEventBase {
  readonly kind: 'reset';
  readonly reason:
    | 'input-not-sent'
    | 'user-revert'
    | 'user-truncate'
    | 'adopt-external'
    | 'journal-repair'
    | 'migration';
}

export interface AgentControlRow {
  readonly id: string;
  readonly incarnation: string;
  readonly operation: AgentTurnBoundOperationIdentityV4;
  readonly anchorEntryId: AgentTranscriptEntryId | null;
  readonly displayOrder: number;
  readonly message: ChatMessage;
}

export interface AgentControlEvent extends AgentStreamEventBase {
  readonly kind: 'control';
  readonly operation: AgentTurnBoundOperationIdentityV4;
  readonly mutation:
    | { readonly kind: 'upsert'; readonly row: AgentControlRow }
    | { readonly kind: 'remove'; readonly id: string; readonly incarnation: string }
    | { readonly kind: 'clear' };
}

export interface AgentTransientControlCapabilityV4 {
  readonly protocol: 'ordered-stream-v1';
}

export interface AgentSessionEvent extends AgentStreamEventBase {
  readonly kind: 'session';
  readonly operation: AgentOperationIdentityV4;
  readonly session: AgentStartedSession;
}

export interface AgentTerminalCompleteness {
  readonly acceptedInputEntryIds: readonly AgentTranscriptEntryId[];
  readonly attributableEntryCount: number;
}

export interface AgentTerminalEvent extends AgentStreamEventBase {
  readonly kind: 'terminal';
  readonly operation: AgentTurnOwnerOperationIdentityV4;
  readonly outcome:
    | { readonly kind: 'finished'; readonly exitCode: number }
    | { readonly kind: 'failed'; readonly error: AgentIntegrationError };
  readonly completeness: AgentTerminalCompleteness;
  readonly sourceSettlement: 'confirmed' | 'unresolved';
}

export type AgentStreamEvent =
  | AgentTranscriptCommitEvent
  | AgentTranscriptResetEvent
  | AgentControlEvent
  | AgentSessionEvent
  | AgentTerminalEvent;
```

`AgentStreamEvent.digest` is SHA-256 over `stableJsonStringify()` of a version tag and
the complete event with `digest` omitted. The helper first applies ordinary JSON
serialization semantics and then recursively sorts object keys while preserving array
order. Parser reconstruction or late assignment of optional message fields cannot
change a digest.

The existing carryover revision helper keeps its current byte contract during Phase 1.
The shared serializer replaces it only after a compatibility fixture proves identical
output for every persisted carryover shape; otherwise carryover receives a deliberate
revision-version bump. This avoids silently changing existing `carry-v5` values.

A canonical provider item may render several entries by sharing `namespace` and
`itemId` while using distinct semantic `subrowId` values. One complete
`(namespace, itemId, subrowId)` tuple binds exactly one entry. `namespace` identifies
the logical source, not the observation channel; notifications, native JSONL, and
journal aliases normalize through an integration-private alias map.

`active` is reserved for one projection-admitted `UserMessage`. Finalized assistant,
tool, and imported-history entries are durable on publication. Actionable controls use
`AgentControlEvent`, never an active transcript entry.

### Stream Facet

```ts
export interface AgentSegmentOpenResult {
  readonly checkpoint: AgentStreamCheckpoint;
  readonly idle: true;
}

export interface AgentTranscriptPage {
  readonly projection: AgentProjectionState;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly firstOrdinal: number;
  readonly hasMore: boolean;
}

export type AgentTranscriptPageResult =
  | { readonly kind: 'ready'; readonly page: AgentTranscriptPage }
  | { readonly kind: 'expired'; readonly current: AgentProjectionState }
  | { readonly kind: 'deferred'; readonly retry: 'execution-settled' }
  | {
      readonly kind: 'degraded';
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export type AgentStreamReplayResult =
  | {
      readonly kind: 'events';
      readonly events: readonly AgentStreamEvent[];
      readonly checkpoint: AgentStreamCheckpoint;
    }
  | { readonly kind: 'expired'; readonly checkpoint: AgentStreamCheckpoint }
  | {
      readonly kind: 'degraded';
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export interface AgentInputPreparation {
  commit(): Promise<AgentTranscriptCommitEvent>;
  rollback(): Promise<AgentInputRollbackResult>;
  discardCommitted(): Promise<AgentTranscriptResetEvent>;
}

export type AgentInputAdmissionState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'prepared' }
  | { readonly kind: 'rolled-back' }
  | { readonly kind: 'committed'; readonly event: AgentTranscriptCommitEvent }
  | { readonly kind: 'discarded'; readonly event: AgentTranscriptResetEvent }
  | {
      readonly kind: 'committed-settled';
      readonly entryId: AgentTranscriptEntryId;
    }
  | {
      readonly kind: 'discarded-settled';
      readonly entryId: AgentTranscriptEntryId;
    }
  | {
      readonly kind: 'degraded';
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export type AgentInputRollbackResult =
  | { readonly kind: 'rolled-back' }
  | { readonly kind: 'conflict'; readonly state: 'committed' | 'discarded' };

export interface AgentConsumerOffsetCommit extends AgentSegmentIdentity {
  readonly applied: AgentStreamCheckpoint;
}

export interface AgentTranscriptStream {
  openSegment(
    request: AgentTranscriptRequest,
  ): Promise<AgentTranscriptAccessResult<AgentSegmentOpenResult>>;
  subscribe(listener: (event: AgentStreamEvent) => void): () => void;
  replay(request: AgentTranscriptRequest & {
    readonly after: AgentStreamCheckpoint;
  }): Promise<AgentStreamReplayResult>;
  loadPage(request: AgentTranscriptRequest & {
    readonly limit: number;
    readonly beforeOrdinal: number | null;
    readonly expectedProjection: AgentProjectionState | null;
  }): Promise<AgentTranscriptPageResult>;
  commitOffset(request: AgentTranscriptRequest & {
    readonly commit: AgentConsumerOffsetCommit;
  }): Promise<void>;

  prepareInput(request: AgentTranscriptRequest & {
    readonly message: UserMessage;
    readonly operation: AgentTranscriptAdmissionIdentity;
  }): Promise<AgentInputPreparation>;
  resolveInputAdmission(request: AgentTranscriptRequest & {
    readonly operation: AgentTranscriptAdmissionIdentity;
  }): Promise<AgentInputAdmissionState>;

  prepareHandoffLease(request: AgentTranscriptRequest & {
    readonly handoffOperationId: string;
  }): Promise<AgentTranscriptAccessResult<AgentOutgoingHandoffLease>>;
  prepareOwnershipSegment(request: AgentTranscriptRequest & {
    readonly handoffOperationId: string;
  }): Promise<AgentTranscriptAccessResult<AgentIncomingOwnershipPreparation>>;

  resolveNativeSession(
    request: AgentTranscriptRequest,
  ): Promise<AgentTranscriptAccessResult<AgentNativeSessionRef | null>>;
  preview(
    request: AgentTranscriptRequest,
  ): Promise<AgentTranscriptAccessResult<AgentTranscriptPreview | null>>;
  resolveIndexSource(
    request: AgentTranscriptRequest,
  ): Promise<AgentTranscriptAccessResult<AgentTranscriptIndexSourceRefV4 | null>>;
  refreshIndexSource(
    request: AgentTranscriptIndexRefreshRequestV4,
  ): Promise<AgentTranscriptAccessResult<AgentTranscriptIndexSourceRefV4 | null>>;
  describeSource(
    request: AgentTranscriptRequest,
  ): Promise<AgentTranscriptAccessResult<AgentTranscriptSourceLocation | null>>;
  release(request: AgentTranscriptReleaseRequest): Promise<void>;
}
```

API version 4 also adds
`AgentIntegration.transientControls: AgentTransientControlCapabilityV4 | null`.
The marker exposes conformance scope without creating another event channel: a null
integration may not emit `AgentControlEvent`; a non-null integration must pass the
shared control-order, incarnation, restart, and action tests. It is deliberately a
marker, not a second source or an optional method on `AgentTranscriptStream`.

`openSegment()` handles initial chats and cold restart, not only handoff. Core installs
the process-wide subscription first, then opens a segment before admitting execution.
The ready full-fold checkpoint is legal only while the segment has no open turn and its
control map is empty. Bootstrap and ownership preparation may touch provider storage,
so either method may instead return typed deferred/degraded state. Core buffers events
during open/load, installs the durable projection plus an empty control fold, and
applies the unique contiguous buffered chain.

Core never discards ingress state for an open turn. If that invariant is violated, it
fails and fences the turn rather than attempting a mid-turn cold control snapshot. An
idle ingress record may be recreated with `openSegment()`.

The retained access-result union remains:

```ts
export type AgentTranscriptAccessResult<T> =
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'deferred'; readonly retry: 'execution-settled' }
  | {
      readonly kind: 'degraded';
      readonly errorCode: string;
      readonly retryable: boolean;
    };
```

Every method that might otherwise touch a provider serves retained state, acquires the
integration's private safe-read gate, or returns typed deferred/degraded state. Core
does not infer safety from method name or provider ID.

`AgentTranscriptRequest` includes a required branded `agentOwnershipEpoch` in its chat
reference. Every returned checkpoint/event and nested operation must agree with it.
Journal directories are keyed by chat ID plus ownership epoch, so reacquiring a chat
cannot reopen the prior owner's stream.

### Execution Lifecycle

API version 4 has no separate integration execution-event callback. The execution facet
accepts start/steer/abort commands; all integration-originated lifecycle output is in
`AgentStreamEvent`. `start()` keeps returning `AgentStartedSession` for execution-call
correlation, and the request's existing `AgentExecutionAdmission` remains the owner of
`markStarted()`/`markAbortable()` stop behavior. The return value is not a second state
writer: it must match the ordered `AgentSessionEvent`, and core does not persist or
broadcast session creation from the return path.

On `AgentSessionEvent` apply, core flushes `agentSessionId`, native-session reference,
and native seed receipt to the chat registry before committing the offset and emits
`ChatSessionCreatedMessage` through the per-chat task. Session metadata alone does not
dirty search; the projection-store source exists before native session binding and only
a durable ledger transition changes searchable content.
The integration persists the native session mapping before publishing the event, so a
crash after provider session creation but before event apply is repaired during the
next `openSegment()`/`resolveNativeSession()` bootstrap rather than creating runnable
execution state. Later stream events cannot overtake the session event. Provider
progress that needs feed presentation is a control event.

Core derives visible processing from the execution reservation and terminal. It emits
the terminal-driven `processing: false`, `chat-session-stopped`, command result, and
`agent-run-finished`/`agent-run-failed` sequence while applying `AgentTerminalEvent` in
the per-chat task. Provider-specific mid-turn `processing: false` hints are deliberately
not preserved; no lifecycle callback can overtake a prior stream event.

## Stream Semantics

### Genesis And Restart

A new segment begins at offset zero with an integration-created stream epoch and an
empty or bootstrapped durable projection. `openSegment()` binds and syncs the segment's
rendering authority before returning ready. Existing native history is converted once
into that authority's genesis projection using stable entry/source identities; it is
not replayed as thousands of synthetic live events and is never re-rendered from native
storage on later reads. Import may be restaged freely before the segment's first V4
publication. After publication, a differing reconstruction is not "bootstrap": it must
either prove the stored envelopes byte-identical, append a canonical suffix, or enter an
explicit repair/adoption flow.

Every integration process restart creates a new stream epoch and offset zero from the
last verified projection-store state. A native audit may append a crash-missed suffix
before open completes, but cannot re-render already committed envelopes. Restart drops
an active suffix and all control state. The server process also has a new
`serverInstanceId`, so browser transient state clears. This rule eliminates recovered
volatile offsets, clean-shutdown markers, and replay ambiguity. A restart may rotate the
browser generation, but stable entry IDs, ledger content epoch, and durable revision
preserve semantic identity. Search keeps the same content epoch and does not rebuild
unless bootstrap appended new durable occurrences.

Before opening segments, startup terminates or fences any orphan provider process from
the prior server incarnation. Execution state is intentionally not recovered, so an old
provider cannot remain blocked on a permission whose control row was discarded.

If an adapter loses its process-local stream state while core remains alive, it starts
a fresh stream epoch. It cannot manufacture a reset chained to the checkpoint it lost.
The next event is therefore an unknown-epoch event: idle core relists through
`openSegment()`, while an open turn fails/fences and is repaired after settlement. An
adapter never silently reuses an old offset.

### Application And Duplicate Classification

After rejecting a stale ownership epoch, core's event classifier is total over the
event's relation to its applied and last successfully committed checkpoints:

- an event at or below the committed offset in the current stream epoch is settled
  past and is ignored with a diagnostic; the successful offset commit is the proof that
  core already applied it;
- an address in `(committed, applied]` always has a retained core proof; equal digest and
  complete checkpoint is a duplicate, while different data is corruption;
- an event whose complete `previous` equals core's applied checkpoint is next, including
  a reset whose resulting checkpoint introduces a new stream epoch;
- a future event with a mismatched `previous` is a gap and triggers inline replay;
- an event from a retained superseded stream epoch is stale;
- an event from an unknown epoch requires relist; and
- message content never participates in classification.

Core retains duplicate proofs for exactly the applied offsets above its committed
offset. Once a successful commit moves that boundary, an older proof is unnecessary;
cursor comparison classifies the event as settled past rather than asserting payload
equality without evidence.

Core applies one event in a no-throw atomic state update, performs required ledger and
browser publication preparation, then advances its checkpoint. Failed validation
mutates nothing. Returned admission events and subscription delivery share the same
identity, so either may win without duplicating application.

Core commits offsets after its local state transition and required command-ledger
mutation are durable enough for the process contract. WebSocket delivery is not part of
the offset transaction; a client recovers missed transport from the complete chat
snapshot and generation/revision rules.

`commitOffset()` is monotonic, idempotent, retained-state-only, and provider-IO-free. A
lost or ambiguously completed commit leaves core's local committed boundary unchanged,
so core retains extra duplicate proofs even if the integration conservatively released
its copy. The integration logs and bounds consumer lag; at the hard limit it fences new
admission rather than evicting uncommitted events.

### Replay And Fail-Stop Recovery

`replay(after)` returns the complete contiguous event chain after the supplied
checkpoint through the integration's current checkpoint. Core invokes it inline from
the current per-chat task. It must never wait for a separately scheduled apply task on
that same queue.

If replay is expired while no turn is open, core re-enters the subscribe/open/load
sequence. `openSegment()` supplies both the latest projection and its stream-offset
baseline; `loadPage()` alone can never establish a causal replay point. Core rotates the
client generation when the epoch changed. If open or paging is deferred/degraded, core
surfaces that typed state and keeps admission fenced. If replay expires or corrupts
while a turn is open, core:

- fails the turn with `TRANSCRIPT_STREAM_UNREACHABLE`;
- atomically replaces the turn owner with the transcript-snapshot reservation;
- clears browser controls through a revisioned failure transition;
- releases the turn owner in a nonthrowing `finally`; and
- keeps later admission fenced until audit/relist repairs the segment.

The per-chat ingress queue may contain retained-state work only. Provider IO, unbounded
waits, and background retries cannot sit ahead of a terminal and strand execution
ownership.

### Projection Revisions

`durableRevision` is the ordered digest of canonical durable entry envelopes, including
ordinal, ID, source, provenance, and parsed message. It is independent of a requested
page window.

`stateRevision` canonically hashes the durable revision plus the at-most-one active
suffix envelope. It is an integrity check for the addressed materialization, not a
causal cursor or browser-generation constituent. A transient-only event leaves it
unchanged. Promotion updates the durable revision and removes the matching active suffix
without changing the entry ID, ordinal, provenance, or payload.

`contentEpoch` is not a hash of the latest durable revision. It names the lineage in
which durable ordinals and entry anchors remain valid, so normal append and promotion
preserve it. `input-not-sent` also preserves it because the durable prefix is identical.
Only a reset that removes, reorders, or rewrites durable envelopes creates a new content
epoch. Core derives its composite search fence from this value rather than from the
process-scoped stream epoch or ever-changing tail revision.

The shared implementation uses a non-finalizing Node `crypto.Hash.copy()` accumulator
for the durable prefix and `stableJsonStringify()` for canonical serialization. Multiple
checkpoints from one accumulator remain valid. Runtime startup rejects a crypto
implementation without non-finalizing copy support.

## Transcript Commit And Reset Rules

### Commits

Within one atomic commit, promotions apply before appends. Structural validation
requires:

- unique entry IDs and complete ownership agreement;
- `checkpoint.projection.total` equals prior total plus appended entries;
- the durable count advances by promotions plus new durable entries;
- durable entries remain one contiguous prefix;
- ordinary commits preserve stream and ledger content epochs;
- promotion binds the next active entry exactly once;
- a durable entry is never demoted;
- a source tuple never binds two entries;
- every causally attributable entry carries the current turn owner; and
- a control/session/terminal event changes no projection field.

A provider item that renders several semantic rows is one atomic commit. Partial
application is invalid.

### Conversation-Ledger Evolution

The normal durable operation is append. Provider execution-context mutation is not a
conversation rewrite:

- an observable automatic compaction or microcompaction appends one normalized
  `CompactionMessage` and advances private native-retention metadata;
- an explicit `agent-compact` command is an ordinary terminal-bearing turn whose
  compaction message appends without rotating any content or browser generation;
- an aborted/retried provider attempt leaves already finalized and published rows in the
  ledger, while replacement output receives distinct entry/source identities;
- a native audit that proves the ledger is a canonical prefix appends only the missing
  suffix, with null Garcon provenance for genuinely external pre-Garcon occurrences; and
- provider history that is shorter, summarized, or differently rendered at a committed
  source advances the native-retention floor or degrades continuity. It never deletes or
  morphs the stored envelope.

An automatic compaction occurrence emitted while a turn is open carries that turn's
immutable owner provenance and participates in its terminal attributable-entry count.
The same provider-initiated occurrence discovered at true idle has null provenance.
Adapters may not classify the row differently between the live write and later audit.

The native-retention floor starts at zero and is monotonic within one ledger content
lineage. Identity parity is required only above it. An audit may bind new native aliases
or move the floor forward, but neither operation changes projection state, search
content, browser generation, command receipts, or stream order unless it also appends a
new visible entry. The journal persists the floor and alias map as execution-continuity
metadata outside the ordered durable-revision accumulator.

External provider edits follow the same rule. A proven suffix appends. Divergence at an
already committed source records `PROJECTION_NATIVE_DIVERGENCE`, keeps the ledger
visible, and disables unsafe resume/fork operations. Adopting the external history as
the displayed conversation is a separate explicit user operation, not an audit policy.

### Destructive Durable Resets

A durable reset exists only for an intentional conversation mutation or an approved
reconstruction:

- `user-revert` removes a suffix selected by a content-epoch-qualified entry anchor;
- `user-truncate` applies an explicit user retention decision;
- `adopt-external` replaces the ledger with user-confirmed external native history;
- `journal-repair` installs a reviewed reconstruction when byte-identical recovery is
  impossible; and
- `migration` deliberately re-renders stored envelopes for a new schema.

Byte-identical journal recovery and first-publication bootstrap do not reset. Routine
provider compaction, rollback, retry, and audit mismatch are not legal reset reasons.

A destructive reset occurs only when the integration producer has no open turn. The
replacement is committed inside the same bound projection store; the physical rendering
authority does not change. Its target:

- uses a new stream epoch and a new ledger content epoch;
- is fully durable (`durableCount === total`);
- is loaded from pages pinned to the declared projection state;
- recomputes the declared durable and state revisions;
- has an empty process-only control fold; and
- replaces every derived core structure in one transaction.

An explicit destructive request waits behind the current turn and acquires the
transcript-snapshot reservation before construction. Journal corruption discovered
mid-turn fails/fences that turn and repairs only after the producer is idle; it never
changes the epoch against which an in-flight terminal is validated.

Reset preparation is pure. Core stages the complete target materialization, entry index,
per-turn receipt summaries, command-result invalidations, search content-epoch cutover,
and browser generation transition. Failure or abort changes none of the old
materialization, lineage, command results, search visibility, or browser state.

Core computes affected retained turn owners by comparing compact per-turn summaries of
the old and target projections. The integration does not declare that redundant list.
An already-terminal command result whose attributable output changed becomes
`turnResultAvailability: 'projection-reset'`; core never silently rewrites it. Search
queries reject the old composite content epoch immediately, before asynchronous
reindexing begins.

A converter/audit mismatch without explicit adoption or repair authority is not a
reset. The integration records `PROJECTION_AUDIT_MISMATCH`, retains the committed
rendering, and degrades native-continuity state.

### `input-not-sent` Reset

`input-not-sent` is the only reset allowed inside an open turn. It removes the one
trailing active admission after the provider proves it was not sent. Core derives the
removed ID from its current materialization; no discard list crosses the wire.

Validation requires:

- `previous.projection.total === previous.projection.durableCount + 1`;
- target `total === target.durableCount === previous.projection.durableCount`;
- target durable count and durable revision equal the prior durable prefix;
- target ledger content epoch equals the prior ledger content epoch even though its
  stream epoch changes;
- every retained durable envelope remains byte-identical at the same ordinal;
- the active row belongs to the exact admission being discarded;
- the outcome is known-not-sent, never unknown; and
- the reset preserves the current control map and its `(id, incarnation)` values.

The prior ordered durable revision is core's normative O(1) full-prefix proof. A
journaled integration independently validates its private immutable content root. No
private root crosses the interface. Retained-envelope comparison is bounded diagnostic
validation, not a forced full-prefix load.

The journal records a fixed-size new-epoch manifest referencing the prior immutable
durable content root. It does not rewrite a large transcript. The manifest points
directly to the content root rather than chaining reset manifests.

Core rotates the client generation and emits one compound generation transition. The
unchanged permission/control map is reanchored to the new generation in that same
browser event. Any unprovable anchor rejects the reset instead of dropping the action.

## Pagination And Cold Materialization

Provider page cursors remain private. Core pages by stable entry ordinal inside one
projection state:

- the latest page uses `beforeOrdinal: null` and no expected projection;
- every continuation carries the complete `AgentProjectionState` returned by the first
  page and the oldest loaded current-segment ordinal;
- a transcript commit changes projection state but not earlier ordinals;
- a control, session, or terminal event changes no projection state and cannot invalidate the
  page chain;
- a reset or evicted old projection state returns `expired`; and
- a page never combines entries from different projection states.

Projection-page retention is independent of stream replay retention. A consumer offset
commit may release old event envelopes without evicting a projection state still pinned
by an HTTP page chain. Evicting that bounded snapshot changes only recovery cost: the
next request receives `expired` and relists.

An integration serves every page from its bound normalized projection store. It never
re-runs a provider-native renderer on the serving path and never calls a provider API
that might contend with execution. A store that cannot finish first bootstrap safely
returns `deferred`, never empty history or overlapping retained output.

Core's `OrderedChatTranscriptReader` composes immutable carryover counts with the current
segment ordinal. It no longer converts rendered row counts into provider offsets.

Cold initialization follows a list/watch pattern:

1. Install the process-wide stream subscription.
2. Buffer events for the segment.
3. Call `openSegment()` and load pages pinned to its projection state.
4. Atomically install the projection, empty control fold, and returned stream checkpoint.
5. Apply the buffered contiguous chain after that checkpoint.

Execution admission cannot begin before this initialization. During an open turn, the
core ingress checkpoint and control fold are non-evictable. This is why version 4 needs
no independent control-snapshot protocol.

The client history response keeps explicit complete/deferred/degraded states. Deferred
is not exhaustion, and cold selection retries once on the matching execution-to-idle
transition. Earlier-page gestures require a fresh user gesture rather than a hidden
retry loop.

## Accepted Input Admission

Core removes the direct optimistic append in
`server/chat-execution/accepted-input-transcript.ts`. The projection owner admits the
row through this transaction:

1. Core validates the command under the current ownership fence.
2. A new turn captures its immutable `AgentTurnReceiptOwner`; a steer copies that owner
   while retaining its own non-null request ID.
3. Core owns a non-runnable execution reservation. An unselected queue item creates no
   transcript row.
4. Core calls `prepareInput()` with the normalized `UserMessage` and admission identity.
5. Core registers its process-only pending-input bookkeeping.
6. Core calls the preparation's idempotent `commit()`.
7. Core applies and broadcasts the returned commit event.
8. Only then does the reservation become runnable and provider execution start.

The active input has `lifetime: 'active'`, no provider source, and the next ordinal. The
integration promotes it when provider ownership is established. Promotion may share one
commit with the first durable provider output.

`prepareInput()` is idempotent by
`(agentOwnershipEpoch, clientRequestId)`. Reusing that identity with a different payload,
turn, or receipt owner is a typed conflict. Equal text with a different request ID is a
distinct occurrence.

Durable entry provenance and `input-not-sent` manifests retain the final admission
identity across restart even though queue/ledger state does not. A retry of an already
durable or discarded identity therefore cannot create another row. If a pre-crash
active delivery might have reached the provider, startup audit must resolve it before
`resolveInputAdmission()` may return `absent`; unavailable evidence returns degraded,
not a speculative absence.

Because restart creates a new stream epoch, a durable prior outcome has no replayable
event in the new process. `committed-settled` names the entry already present in the
opened projection; core verifies its stored admission identity and applies no event.
`discarded-settled` names the entry retained by the discard manifest; core verifies it
is absent from the active suffix and applies no event. Either is an idempotency answer,
not recovered runnable work. A caller that reuses the request ID with a different
payload, turn ID, or receipt owner receives the existing typed conflict before either
settled variant can be returned.

At most one unresolved active input exists per segment. A later steer or queued turn is
not eligible until the current input is promoted, discarded as known-not-sent, or
repaired after an unknown outcome.

### Ambiguous Commit Outcome

`commit()` may install and emit its event, then reject before the result reaches core.
Core must not roll back a possibly committed row. It leaves the reservation non-runnable
and queries `resolveInputAdmission()` or retries the same idempotent commit.

- `committed` returns the current-process event for application.
- `committed-settled` verifies an already materialized durable entry and applies no
  event.
- `prepared` may be rolled back.
- `discarded` returns the current-process reset event.
- `discarded-settled` verifies the durable discard outcome and applies no event.
- `rolled-back` closes the reservation.
- `absent` is safe only after the owner authoritatively checked retained state/journal.
- `degraded` or unresolved installs the repair/admission fence.

`rollback()` is idempotent from prepared/rolled-back state. From committed/discarded it
returns a typed conflict and changes nothing. The provider never starts under ambiguity.

A known-not-sent failure after commit calls `discardCommitted()` and must install its
reset before releasing the reservation. An unknown delivery outcome keeps the active
row, fails the turn, and fences later execution/handoff until audit promotes or resets
it.

Queue and pending-input state remain process-only. An unclean restart drops the active
suffix by opening a new stream epoch from the durable projection; it does not replay a
queued command.

## Terminal Frontier And Command Receipts

A terminal is the final ordered event for one open turn. The integration emits it only
after all transcript and control events it knows belong to that turn have entered the
same stream.

Core maintains process-only per-turn summaries independent of bounded view pages:

- immutable receipt-owner key;
- attributable entry count;
- exact expected accepted-input ID set in ordinal order;
- current-turn entry ID to ordinal mapping for control anchors; and
- a compact result summary used to detect command-output changes across a later
  destructive durable reset.

Open-turn summaries are non-evictable. Terminal summaries are pruned with the matching
command-ledger receipt or chat deletion and disappear on restart; core does not create a
second durable receipt store.

Every applied transcript entry increments the matching provenance count exactly once.
Every core admission adds its returned entry ID to the expected input set. Promotion
does not change the count or ID. An `input-not-sent` reset removes the one derived active
ID from both summaries.

When applying a terminal, core validates:

- terminal operation and nested owner agree exactly;
- the top-level command is not a steer and identifies the immutable owner receipt;
- every attributable entry uses that owner and current ownership epoch;
- `completeness.attributableEntryCount` equals core's summary;
- `acceptedInputEntryIds` equals core's exact expected set with no duplicate;
- every accepted input is now durable for a successful terminal;
- `checkpoint.projection.durableCount === checkpoint.projection.total` on success; and
- `sourceSettlement === 'confirmed'` on success.

The count is a producer assertion, not magic proof that the adapter observed every
provider callback. Stream order prevents channel reordering; deterministic
provider-specific tests remain the only way to prove preterminal completeness.

Assistant output is appended incrementally to the command ledger using the owner key
carried by entry provenance. Turn ID alone is never an output-write key. Steer receipts
record delivery only. Terminal finalization validates the accumulated result and does
not append output a second time.

Terminal application and lifecycle publication run in the per-chat task:

```ts
await scheduleChatTask(chatId, async () => {
  let repairFence: TranscriptSnapshotReservation | null = null;
  let prepared: PreparedTerminalOutcome;
  try {
    try {
      const terminal = await projectionIngress.applyThroughTerminalInline(
        event,
        AbortSignal.timeout(STREAM_REPLAY_TIMEOUT_MS),
      );
      await commandLedger.finalizeProjectionOutput(
        chatId,
        terminal.operation.turnOwner,
      );
      prepared = prepareTerminalOutcome(terminal);
    } catch (error) {
      if (projectionIngress.requiresRepairBeforeAdmission(chatId, error)) {
        repairFence = queue.replaceTurnWithTranscriptSnapshotReservation(
          chatId,
          event.operation,
        );
      }
      prepared = await prepareFailedTerminal(chatId, event.operation, error)
        .catch(transcriptFailureFallback);
    }
    await publishPreparedTerminal(chatId, event.operation, prepared);
  } finally {
    queue.onAgentTurnTerminal(chatId, event.operation, repairFence);
  }
});
```

`applyThroughTerminalInline()` normally receives an already-next event. If callback
delivery skipped an earlier offset, it pulls replay inside the current task rather than
waiting for a queued apply behind itself. Replay and reporting have bounded abort
signals. The release in `finally` is idempotent and nonthrowing.

A completeness mismatch, unresolved settlement, unreachable replay, or corrupt event
cannot publish terminal success. Core marks command output unavailable with reason
`transcript-barrier`, emits a structured diagnostic, fails the turn, and preserves the
repair reservation so queued work cannot append to an unhealthy projection.

## Transient Control Fold

Integration-originated permissions, progress, retries, and abort acknowledgements are
`AgentControlEvent` variants in the same stream. Core-owned queue and processing state
remain under their existing owners.

The integration and core both fold control events in stream order:

- `upsert` creates or updates one `(id, incarnation)` row;
- `remove` names the exact incarnation;
- reuse of a removed pair is corruption;
- reuse of an ID for a new lifecycle requires a new incarnation;
- `clear` removes the current turn's rows;
- terminal clears the matching turn after the terminal is validated; and
- a destructive durable reset clears the map while `input-not-sent` preserves it.

Control events are limited by the interface validator to approved active-only message
classes. A permission resolution that should become durable history is a separate
transcript commit with its own entry identity.

The default control anchor is the last durable ordinal at the control event's position.
An explicit `anchorEntryId` must resolve in the current turn summary to a durable
ordinal no later than that position. Because transcript and control share one stream,
the anchor is already applied; no anchor-replay, pending-candidate, cross-facet pin, or
deadline protocol exists.

Core maps the anchor ordinal to
`afterSeq = carryoverMessageCount + ordinal`. It does not need the anchor row in the
bounded view window. The browser renders a control inline only if its generation
matches, it has applied through `afterSeq`, and the exact anchor row is loaded. Otherwise
the row appears in the dedicated active-control surface and moves inline when the anchor
loads.

## Browser Transport

The browser never sees integration stream offsets. Core exposes a server-instance
transient revision and state digest because HTTP and WebSocket delivery are independent
transports.

```ts
export interface TransientFeedRow {
  readonly id: string;
  readonly incarnation: string;
  readonly operationTurnId: string;
  readonly turnOwner: AgentTurnReceiptOwner;
  readonly transcript: {
    readonly generationId: string;
    readonly afterSeq: number;
  };
  readonly displayOrder: number;
  readonly message: ChatMessage;
}

export interface ChatTransientFeedMutation {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly transientRevision: number;
  readonly stateDigest: string;
  readonly mutation:
    | { readonly kind: 'upsert'; readonly row: TransientFeedRow }
    | { readonly kind: 'remove'; readonly id: string; readonly incarnation: string }
    | {
        readonly kind: 'clear-operation';
        readonly turnOwner: AgentTurnReceiptOwner;
      };
}

export interface ChatProjectionGenerationTransition {
  readonly type: 'chat-projection-generation-transition';
  readonly resetTransactionId: string;
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly previousGenerationId: string;
  readonly generationId: string;
  readonly transientRevision: number;
  readonly stateDigest: string;
  readonly rows: readonly TransientFeedRow[];
}

export interface ChatTransientFeedSnapshot {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly generationId: string;
  readonly resetTransactionId: string | null;
  readonly transientRevision: number;
  readonly stateDigest: string;
  readonly rows: readonly TransientFeedRow[];
}

export interface ChatTransientControlAction {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly turnOwner: AgentTurnReceiptOwner;
  readonly id: string;
  readonly incarnation: string;
}
```

Each ordinary mutation advances `transientRevision` by exactly one. A gap requests a
complete chat snapshot. Equal revision requires equal state digest and reset transaction
identity. A snapshot may jump because it contains the complete map.

`stateDigest` is SHA-256 over `stableJsonStringify()` of the complete row map sorted by
row ID and incarnation, including turn owner, transcript anchor, display order, and
message payload. Reusing a revision, generation, or reset transaction ID with a
different digest is a protocol error.

The WebSocket handshake is authoritative for `serverInstanceId`. The browser rejects
late HTTP/WS state from another instance and clears transient rows when the instance
changes. This prevents an old snapshot from resurrecting a removed permission.

A projection reset emits one `ChatProjectionGenerationTransition`; there is no
separately renderable generation-reset/control-rebase pair. A destructive durable reset
carries an empty map because it is idle-only. An `input-not-sent` reset carries the
preserved map reanchored to the new generation. Until the new transcript page loads, the
same control incarnation remains exactly once in the detached action surface.

Permission decisions are fenced by server instance, ownership epoch, turn owner,
control ID, and incarnation. Transcript generation is deliberately not an action fence,
so an unchanged permission remains actionable during an input-reset transition.

Terminal clearing is one revisioned `clear-operation` mutation applied before terminal
lifecycle broadcasts. Delayed browser events are rejected by transient revision;
delayed integration events are rejected earlier by stream offset/epoch and inactive
turn ownership.

## Core Composite Projection

The visible chat remains:

```text
immutable carryover segment 0
immutable carryover segment 1
...
current integration transcript projection
transient control overlay
```

Only carryover and the current transcript participate in transcript sequence, paging,
search, sharing, and forking. Core assigns browser `seq` from carryover counts plus
current entry ordinal. Integration entry IDs remain server-side for exact application,
anchor mapping, and fork resolution.

Carryover freezes the full durable conversation ledger, including rows that the source
provider no longer retains and explicit compaction markers. The separately generated
`CarriedContext` injected into a destination provider may be bounded or summarized for
model context limits. That lossy execution seed never replaces, truncates, or
re-sequences immutable UI carryover.

The immutable browser-generation fence contains:

- carryover revision;
- ownership epoch; and
- stream epoch.

Tail commits update projection revisions without rotating the generation. A reset,
handoff, carryover repair, ownership change, or process-restart stream epoch rotates it.

The composite search content epoch is a different fence. It survives tail append,
`input-not-sent`, and process restart with unchanged durable content, but rotates for a
destructive durable reset, carryover recomposition, handoff, or deletion. Browser cache
safety therefore does not force an unnecessary search rebuild.

`ChatViewStore` no longer needs provider-native prefix digests, live/native overlap
matching, evicted-live digests, or publication proofs. It stores current projection
state, retained entry pages, a compact entry/turn index, and the composite sequence
offset.

## Handoff And Deletion

### Outgoing Lease

The outgoing integration exposes a process-local lease, not a second durable transaction
coordinator:

```ts
declare const handoffSealBrand: unique symbol;
declare const handoffDecisionBrand: unique symbol;
export type AgentHandoffSeal = {
  readonly [handoffSealBrand]: true;
};
export interface AgentHandoffDecision {
  readonly operationId: string;
  readonly targetOwnershipEpoch: AgentOwnershipEpoch;
  readonly [handoffDecisionBrand]: true;
}

export interface AgentFrozenSegment {
  readonly checkpoint: AgentStreamCheckpoint;
  readonly entries: readonly AgentTranscriptEntry[];
}

export interface AgentOutgoingHandoffLease {
  readonly operationId: string;
  readonly frozen: AgentFrozenSegment;
  sealForDecision(): AgentHandoffSeal;
  commitAfterDecision(
    seal: AgentHandoffSeal,
    decision: AgentHandoffDecision,
  ): Promise<void>;
  rollbackBeforeDecision(): Promise<void>;
}

export interface AgentIncomingOwnershipPreparation {
  readonly checkpoint: AgentStreamCheckpoint;
  commitAfterDecision(decision: AgentHandoffDecision): Promise<void>;
  rollbackBeforeDecision(): Promise<void>;
}
```

The outgoing lease is acquired under the integration's transcript/provider mutation
gate after proving true provider idle and draining every source mutation already
admitted to the integration. Its frozen segment is fully durable. From acquisition
until outcome, no old-segment transcript/control/terminal event or projection-journal
write may apply. Later callbacks are buffered and classified relative to the lease
boundary.

Freeze reads the bound projection store; it never performs a final provider-native
render or parity join. True provider idle remains necessary to prove that no earlier
native mutation can arrive after the ownership boundary and to preserve resume/fork
continuity.

While core stages carryover/incoming state, any buffered mutation marks the lease dirty
and makes `sealForDecision()` fail. The seal is a synchronous, no-yield operation under
the same gate: it rechecks that the buffer is empty and fixes the final inclusion
boundary. A callback after the seal is post-boundary. The deterministic conformance test
yields a microtask immediately after sealing and proves no pre-seal mutation can slip
past the check.

The lease is process-local. Durable recovery is owned only by core's existing ownership
journal. This avoids two participant commit records that could disagree after a crash.

### Single Decision Record

The transaction is:

1. Core acquires the transcript-snapshot reservation and verifies no active suffix or
   open turn.
2. Core writes the durable ownership-journal intent with source/target epochs and a
   stable handoff operation ID.
3. Core acquires the outgoing lease and records its frozen checkpoint in the journal.
4. Core stages the normalized frozen entries in the immutable carryover store.
5. Core prepares the incoming ownership segment. A ready preparation is durable but
   inert and cannot emit or serve through the registry; deferred/degraded preparation
   aborts before the decision and rolls back all staged state.
6. Core records every staged artifact reference in the still-undecided journal intent,
   then synchronously seals the clean outgoing lease.
7. Core writes `commit-decided` to the ownership journal. This fsynced record is the
   transaction's only durable decision and its linearization point.
8. Core updates and flushes the chat registry to the target epoch, activates the
   incoming segment, commits the sealed outgoing/incoming preparations, records completion, and
   publishes one compound handoff generation transition.
9. Outgoing provider/projection cleanup begins only after roll-forward is recoverably
   complete.

The ownership-journal decision write is deterministic and idempotent by operation ID.
It uses an atomic replacement: write and sync a temporary file, rename it, then sync the
parent directory. If any part rejects ambiguously, core re-executes that same
idempotent replacement until one call returns success while the reservation and lease
remain held. Same-process read-back is never durability proof after an `fsync` error,
even if page-cache contents show the record. Step 8 cannot begin and rollback cannot run
under that ambiguity. If storage cannot make progress, the handoff remains fenced or
the process stops; post-restart recovery reads the durable journal state and chooses the
two outcomes below. Only a successfully persisted matching record constructs
`AgentHandoffDecision`; both preparations validate its operation/target identities
before committing.

There are exactly two crash outcomes:

- **No decision record:** presumed abort. Recovery keeps/restores the source registry,
  discards staged carryover and incoming state, reopens/audits the outgoing projection,
  and only then serves the chat. Buffered process-local callbacks are recovered from
  the authoritative provider/journal source; a source that cannot prove parity remains
  degraded.
- **Decision record present:** roll forward. Recovery writes the target registry if
  needed, activates the incoming segment, finishes outgoing cleanup bookkeeping, and
  only then releases the transcript reservation.

The materialized chat registry and later `complete` journal phase are applications of
the decision, not additional decision records. Recovery never chooses outcome from a
participant-local lease flag.

An event admitted before lease acquisition is drained into the frozen projection. A
callback buffered before the seal aborts the undecided transfer and is replayed in source
order. A callback after the seal is post-boundary: presumed-abort recovery audits/replays
it, while commit rejects its old ownership epoch and records a provider-artifact repair
diagnostic. Handoff is allowed only at true provider idle, so a legitimate post-boundary
transcript mutation indicates a provider/adapter settlement defect.

Incoming preparation is idempotent by
`(handoffOperationId, chatId, targetOwnershipEpoch)`. It emits nothing before the durable
decision and registry roll-forward. Handoff away from and back to one integration uses
fresh ownership and stream epochs, so delayed old events remain stale.

### Release

`release(reason: 'deleted')` removes the integration projection and provider artifacts
owned under deletion policy. `transferred` removes old projection/provider artifacts
only after the decision has rolled forward and carryover is rooted. External provider
sessions remain provider-owned where current policy says so.

The durable deletion decision first removes the chat from the registry/current search
catalog and installs the search-service tombstone. Only then may integration release
delete the ledger. This makes new queries and transcript reads fail closed while SQLite
row cleanup and filesystem deletion retry asynchronously. A previously published share
is a separate artifact and follows the product's existing explicit revocation policy;
it is never kept alive by the search index.

The ownership journal retains failed cleanup records for retry; cleanup failure cannot
undo a committed ownership transfer.

## Forking

Core passes an exact current-segment point rather than a rendered row count:

```ts
export interface AgentForkPoint {
  readonly kind: 'projection-entry';
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly entryId: AgentTranscriptEntryId;
  readonly durableRevision: AgentTranscriptRevision;
}

export interface AgentNativeForkRef {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly value: JsonObject;
}

export type AgentNativeForkResolution =
  | { readonly kind: 'ready'; readonly reference: AgentNativeForkRef }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'below-native-retention-floor'
        | 'no-native-source'
        | 'projection-ahead-of-provider'
        | 'not-settled'
        | 'source-diverged';
    }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };
```

The nullable provider `forking` facet resolves that point to a native reference or a
typed not-currently-forkable result. An active input is not forkable. A point in
carryover follows the existing cross-provider path. Stale ownership or ledger content
epochs are rejected before provider access.

Core first resolves the exact entry from the conversation ledger and then asks the
integration for native availability. The integration maps the canonical source tuple
through its private alias table. An ordinal at or below the native-retention floor is
still viewable, searchable, shareable, and exportable but returns
`below-native-retention-floor`; core never infers a native item count from rendered
rows. An entry above the floor can still return another typed unavailability when it was
external, journal-ahead, or unsettled.

Whole-session resume remains native-session based. It may resume provider context that
contains a summary rather than the full conversation ledger; resume never uses native
context to rewrite the displayed ledger. A cross-provider fork/handoff may inject a
bounded or summarized `CarriedContext`, but that execution seed and its receipt are not
the immutable carryover transcript shown to users.

## Derived Transcript Consumers

The conversation ledger is the only durable input to transcript-derived features.
Search, preview, metadata, sharing, export, carryover, and fork lookup may choose
different projections or retention policies, but none may load provider-native history
or use the search database as a transcript fallback.

### Search Source Contract

`resolveIndexSource()` returns a reference to the same durable projection state served
by runtime pages. Codex, Claude, and Pi reference their normalized journals. Direct
providers reference their existing Garcon-owned JSONL through a normalized adapter.
Other integrations expose an equivalent retained store. Integration-specific index
modules may decode a physical store, but they may not invoke a provider renderer or
return independently normalized `ChatMessage[]`.

Version 4 replaces the current message-only index source with an envelope and checkpoint
contract:

```ts
export interface AgentTranscriptIndexCheckpointV4 extends AgentSegmentIdentity {
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly durableCount: number;
  readonly durableRevision: AgentTranscriptRevision;
}

export interface AgentTranscriptIndexEntryV4 {
  readonly ordinal: number;
  readonly entry: AgentTranscriptEntry & { readonly lifetime: 'durable' };
}

export interface AgentTranscriptIndexSourceRefV4 {
  readonly apiVersion: 2;
  readonly ownerId: string;
  readonly checkpoint: AgentTranscriptIndexCheckpointV4;
  readonly value: JsonObject;
}

export interface AgentTranscriptIndexRefreshRequestV4
  extends AgentTranscriptRequest {
  readonly failedSource: AgentTranscriptIndexSourceRefV4;
  readonly failureCode: string;
}

export type AgentTranscriptIndexOpenResultV4 =
  | { readonly kind: 'unchanged'; readonly checkpoint: AgentTranscriptIndexCheckpointV4 }
  | {
      readonly kind: 'append';
      readonly previous: AgentTranscriptIndexCheckpointV4;
      readonly checkpoint: AgentTranscriptIndexCheckpointV4;
      readonly batches: AsyncIterable<readonly AgentTranscriptIndexEntryV4[]>;
    }
  | {
      readonly kind: 'snapshot';
      readonly checkpoint: AgentTranscriptIndexCheckpointV4;
      readonly batches: AsyncIterable<readonly AgentTranscriptIndexEntryV4[]>;
    }
  | { readonly kind: 'expired'; readonly checkpoint: AgentTranscriptIndexCheckpointV4 }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };
```

The source reference pins an immutable target checkpoint. Given a prior indexed
checkpoint in the same content epoch, the store validates that exact prefix revision and
returns the contiguous durable suffix. If the prefix checkpoint is unavailable or does
not match, it returns `snapshot`/`expired`; it never guesses from counts. A pinned load
does not need the current `probe/load/probe` race. Empty or non-searchable messages still
advance the durable checkpoint even when the projector emits no FTS row.

For a frozen checkpoint, runtime and index batches have identical ordered entry IDs,
sources, provenance, messages, ordinals, and durable revision. `source_anchor` derived
from non-enumerable message metadata is deleted. The index stores an explicit projection
anchor:

```ts
export type TranscriptSearchEntryAnchor =
  | {
      readonly kind: 'carryover-entry';
      readonly segmentId: string;
      readonly localOrdinal: number;
    }
  | { readonly kind: 'agent-switch'; readonly segmentId: string }
  | {
      readonly kind: 'current-entry';
      readonly agentOwnershipEpoch: AgentOwnershipEpoch;
      readonly entryId: AgentTranscriptEntryId;
    };
```

Core streams immutable carryover separately, preserving each carryover segment ID and
local ordinal, then the worker appends current-segment envelopes from the index source.
The search projector extracts text from `entry.message`; it never reconstructs source
identity after parsing.

### Search Content Epoch

Core derives one opaque `TranscriptSearchContentEpoch` from a version tag,
`carryOverRevision`, current `agentOwnershipEpoch`, and current segment
`contentEpoch`. It is a lineage fence, not the latest content digest:

- durable tail append and promotion preserve it;
- provider compaction appends a compaction row and preserves it;
- `input-not-sent` and process restart preserve it because the durable composite is
  unchanged;
- explicit durable reset, carryover repair/recomposition, or ownership handoff rotates
  it; and
- deletion tombstones it and removes the chat from the current allowlist.

Core durably mirrors the integration-owned segment content epoch in
`ChatRegistryEntry.transcriptContentEpoch`. The mirror is a query-admission fence, not a
second transcript authority. It makes global search over cold chats implementable
without opening every segment or trusting `search_chat_state` to validate itself.

Creating/opening a V4 segment and applying a destructive reset use this order:

1. Validate and stage the complete integration checkpoint and all core derived state.
2. Flush the matching `transcriptContentEpoch` to the chat registry.
3. Atomically install the in-memory projection/search-catalog cutover and publish the
   browser transition.
4. Commit the integration consumer offset.

The pure staged install cannot fail after the registry flush. Handoff writes the
incoming epoch as part of its already-durable registry roll-forward. A missing epoch on
a legacy/unopened chat makes that chat search-pending until safe `openSegment()` fills
it; core never substitutes the epoch stored in SQLite.

If the registry flush rejects, core installs none of the staged projection, search, or
browser state, does not commit the stream offset, and keeps the transcript-snapshot
reservation/admission fence while retrying the same staged event. The previously
mirrored, last-visible epoch remains the only search-eligible state.

There is one unavoidable two-store crash boundary. The integration may durably commit a
reset and crash before core receives/applies it, leaving the registry mirror at the last
core-applied, last-user-visible epoch. Cold search may continue serving that qualified
old state after restart. The first `openSegment()` observes the newer ledger epoch,
flushes the registry mirror, and cuts search over before serving transcript pages.
Every result remains epoch-qualified, so navigation cannot resolve it against the newer
ledger. Eliminating even this stale-snippet window would require a distributed
transaction or eagerly opening every segment and is not part of the single-process
design.

At V4 cutover, pre-existing registry entries have no mirror. A rate-limited migration
sweep enumerates them and, only while each chat is idle, acquires the transcript-snapshot
reservation, calls `openSegment()`, validates the returned ownership/content epoch, and
flushes it to the registry before releasing the reservation. The operation is
idempotent by chat/ownership epoch and resumes after crash. Deferred/degraded chats stay
search-pending and retry after their typed safe-read condition clears.

The sweep runs with a measured per-integration concurrency cap because first open may
perform the one-time native import, especially for Codex. It emits no transcript,
notification, unread, or execution side effects. Search remains available for already
backfilled chats while the sweep progresses; it does not leave never-reopened chats
pending indefinitely. The search database or index worker may signal work priority but
cannot supply the mirror value itself.

This fence closes a gap in the current search implementation. Today a rebuild leaves old
rows in SQLite while state is `pending`, and queries allowlist only by chat ID without
joining the current source revision. A reset can therefore return removed content or an
ordinal that now names another row. Version 4 query admission sends
`{ chatId, contentEpoch }` pairs from one registry-backed core-catalog snapshot. Every
FTS query joins `search_chat_state` on both values. A request admitted after epoch
rotation cannot see
old rows even before the indexer sees the dirty hint. The service rechecks result epochs
against its latest catalog before responding; a request that linearized before the
reset may still race it, so the returned epoch remains mandatory for browser display
and navigation validation.

The SQLite read model records at least:

- current visible content epoch;
- indexed composite message count;
- indexed current-segment durable count and durable revision;
- target count and revision when catch-up is pending;
- carryover revision, projector version, and schema version; and
- status and last typed failure.

Each chunk records its composite message ordinal, explicit entry anchor, and content
epoch. The epoch is repeated or enforced through a foreign key so an inconsistent row
cannot become queryable. Search remains the repository's only SQLite store and is fully
rebuildable; none of these fields make it a transcript authority.

### Incremental Indexing And Visibility

Append-only growth uses an incremental path:

1. Core publishes a catalog target with the same content epoch and a newer durable
   checkpoint.
2. The index source validates the previously sealed prefix and streams the suffix.
3. The worker stages projected suffix rows and a resulting checkpoint.
4. One SQLite transaction appends rows and advances the indexed checkpoint.

While this work is pending or has retryably failed, the previously sealed prefix remains
searchable because its content epoch and anchors are still valid. Index status reports
the lag and indexed count; it does not pretend the tail is covered. A source mismatch,
evicted prefix proof, projector/schema change, corruption, handoff/carryover change, or
destructive reset takes the snapshot path.

For a new content epoch, every newly admitted expected query allowlist hides the old
index immediately.
The worker builds the replacement in staging and atomically seals it. It never mixes
chunks from two content epochs. Failure leaves the new epoch pending/failed and returns
no stale rows for that chat. Deletion installs a service tombstone before asynchronous
worker dispatch, removes the chat from query allowlists, and transactionally cascades
its state/chunks when the worker applies it.

Search dirties only on a durable entry append/promotion, destructive reset, carryover
composition change, handoff, deletion, or index-format change. Control, terminal,
session metadata, native-retention-floor movement, alias repair, and browser-generation
rotation do not dirty it. Automatic provider compaction dirties it only because the
observable compaction entry is an ordinary append; all pre-compaction rows remain
searchable.

### Search Results And Navigation

`ChatSearchResult` carries the content epoch, and each snippet carries both the
presentation `messageOrdinal` and `TranscriptSearchEntryAnchor`. Ordinal alone is never
used as a durable navigation identity.

When a user opens a result, core compares the returned content epoch to the current
composite epoch and resolves the anchor through the composite reader. A mismatch returns
`SEARCH_RESULT_STALE`; the client removes/requeries the result instead of scrolling to a
possibly reused ordinal. Tail append after the query is safe because content epoch and
prior anchors remain stable. A result from an append-lagged prefix is therefore valid,
while a result that races revert, handoff, or carryover repair is rejected.

Projector or FTS schema upgrades rebuild the derived index under a new index-format
version without changing ledger envelopes or their content epoch. Query workers serve
only their matching format. Search snippets may improve after rebuild; transcript rows
do not re-render.

### Preview And Metadata

`preview()` reads durable entries from the bound ledger and returns typed
ready/deferred/degraded state. Core composes segment preview with immutable carryover for
chat title/first-message/last-activity metadata. Its cache key includes carryover
revision, ownership epoch, ledger content epoch, and durable revision. Active input,
controls, queue state, and provider-native summaries that were not emitted as ledger
entries do not become persisted preview text.

Cold chat lists, background previews, archive routes, and metadata repair use this same
composite reader. They never call native history opportunistically. A durable commit may
update preview/last activity; a session or terminal-only event cannot. `describeSource()`
may still return a provider-native path/reference for diagnostics, but it is explicitly
not a transcript-content source and follows the safe-read result contract.

### Sharing And Export

Share creation/update and export open one composite snapshot pinned to a carryover
revision, ownership epoch, ledger content epoch, and durable checkpoint. All pages come
from that snapshot; an expired pin retries from a new complete snapshot rather than
mixing versions. The stored share may continue to contain plain serialized
`ChatMessage[]`, but its metadata records the composite content epoch and revision from
which that immutable artifact was produced.

Shares and exports contain the durable conversation ledger, including historical rows
that provider context later compacted and any visible compaction markers. They exclude
the active suffix, controls, pending-input overlays, local notices, and queue state.
They read neither FTS results nor provider-native history. A published share is an
independent point-in-time artifact governed by the existing revocation/deletion policy;
later transcript append or reset does not silently mutate it.

### Other Derived Consumers

Core fans out side effects only after one stream event is validated and applied:

- command receipts use immutable entry provenance and are not invalidated by routine
  provider compaction;
- attention, unread, notification, and background-chat caches consume newly applied
  commit entries, never a provider reload;
- cold open/relist does not replay notifications for the already materialized ledger,
  while a first application recovered through same-process replay is still one new
  event;
- pending-input settlement uses admission entry identity and source promotion rather
  than scanning native user-message text;
- HTTP history/archive readers use the composite ordinal reader; and
- read cursors remain browser-generation qualified, while search navigation uses the
  longer-lived content epoch and entry anchor.

These consumers may project or omit message types, but parity tests start from the exact
same stored envelopes. No derived consumer can feed a transformed row back into the
conversation ledger.


## Shared Projection Engine

`server-agents/common/src/transcript-projection/` owns provider-neutral mechanics:

- `identity.ts`: branded constructors and structural validation;
- `revision.ts`: canonical event, durable, state, and per-turn summary digests;
- `state.ts`: transcript materialization, active-suffix and control fold;
- `apply.ts`: pure event validation and transactional reducer;
- `stream.ts`: subscription, replay retention, duplicate proofs, and consumer offsets;
- `paging.ts`: projection-state-pinned ordinal pages;
- `index-source.ts`: checkpoint-pinned envelope snapshots and validated incremental
  suffixes for the shared search worker;
- `admission.ts`: input preparation and ambiguous-outcome state;
- `journal.ts`: default fsynced normalized projection store and adapters for an
  equivalent existing integration-owned store;
- `reset.ts`: target staging, prefix manifests, and epoch lineage;
- `handoff.ts`: outgoing lease and incoming inert preparation; and
- `testing.ts`: deterministic conformance harness.

The engine is a toolkit, not a provider registry. It contains no agent-ID branches.

### Build Versus Buy

Garcon should borrow the protocol shapes above without deploying Kafka, NATS
JetStream, KurrentDB/EventStoreDB, or Temporal. Those systems solve durable
multi-process replication or workflow recovery that this single-process application
does not need; Temporal would directly conflict with the requirement that execution
state disappears on restart. The live stream itself needs only the shared reducer, a
bounded replay buffer, and process-local subscriptions.

The closest embedded alternative for the authoritative projection journal is
`bun:sqlite`, which is already available to the search package. Version 4 nevertheless
keeps the existing fsynced JSONL plus atomic-snapshot pattern: it matches provider
storage already in the repository, stays integration-private, and avoids a second
SQLite durability domain. The rebuildable search database must never double as the
authoritative outbox. A separate SQLite journal requires a new architecture decision
and an explicit change to the repository's one-SQLite-store rule; reconsider it only if
the shared journal grows beyond append, direct-prefix manifest, and idle snapshot
compaction, or fault injection exposes another filesystem atomicity defect. The stream
and journal interfaces deliberately leave that implementation replaceable.

## Journal And Recovery

### Durable Filter

The integration stream is process-local. Each segment's normalized projection store is
both the rendering system of record and a durable projection outbox; it is not a promise
to replay volatile events after restart. The store is bound at genesis and cannot be
replaced by a provider-native serving path later in the segment.

Projection stores persist:

- a segment header and schema version;
- durable appended entries;
- promoted entries as complete resulting durable envelopes;
- destructive reset snapshots;
- `input-not-sent` prefix-reference manifests;
- provider-native checkpoints, the monotonic native-retention floor, and
  alias/provenance metadata; and
- repair/degradation metadata required to preserve rendered identity.

They do not persist:

- active input appends;
- control events or control tombstones;
- session events as stream records (native session metadata is persisted separately);
- terminal events;
- queue, pending-input, processing, or command-ledger state; or
- consumer offsets from an earlier process.

This does not erase admission idempotency. Durable entry provenance reconstructs a
committed admission, and an input-reset manifest retains its discarded admission key.
Prepared/active-only state remains process-local; after a crash, native audit must prove
whether it became provider-owned before the key is reusable.

The segment header versions the envelope schema and canonical serializer. Compatible
read migrations preserve stored entry identity and rendered payload. A converter or
renderer improvement does not retroactively change old rows at read time; a deliberate
re-render is an explicit idle migration/reset with a new stream epoch. This is the
storage and schema-evolution cost of stable rendering.

Durable journal records may correspond to non-contiguous prior stream offsets because
volatile events and active-only commits are filtered out. Recovery validates durable
content-root/revision continuity, not stream-offset contiguity. Startup always creates a
fresh stream epoch and offset zero over the recovered durable state.

The append path follows the existing `DirectSessionStore` pattern:

- validate/truncate an incomplete invalid tail;
- append one complete record;
- sync the file before publishing the durable event;
- sync the parent directory after first creation;
- ignore only an incomplete trailing record; and
- treat a malformed complete record as degraded corruption requiring repair.

Destructive reset replacement writes and syncs a complete new snapshot before rename and
directory sync. An input-only reset writes the fixed-size direct content-root manifest
described earlier. Physical journal compaction writes a byte-equivalent temporary
snapshot, syncs, renames, syncs the directory, then removes obsolete extents. It is
storage maintenance, not provider compaction, and preserves every envelope, entry ID,
content epoch, latest revision, and search anchor. It may discard an unpinned historical
prefix checkpoint. A later index catch-up from that checkpoint must return
`expired`/`snapshot` and rebuild; count equality is never substituted for the discarded
proof. Implementations may retain recent per-record checkpoints as an optimization, not
a correctness requirement.

If the normalized store is corrupt, the integration reports degraded state before
serving. Redundant ledger evidence may repair it in place only after proving the exact
stored envelope sequence and public revision. Provider-native evidence alone may build
a candidate, but installing a different rendering requires an approved
`journal-repair` reset and new content epoch. Incomplete evidence cannot silently become
a new authority. Direct providers without independent evidence remain degraded until
their existing repair policy succeeds.

### Crash Matrix

| Crash window | Required recovery |
| --- | --- |
| Durable journal commit synced, core event not applied | New process opens a fresh epoch over the committed projection; the row appears once. |
| Provider persisted, projection store missing a suffix | Provider-specific bootstrap/audit appends the missing canonical source occurrences through the store. Codex's persist-before-notify ordering makes its healthy journal a native-order prefix. |
| Provider and store diverge before the suffix | Audit retains every committed envelope, advances the native-retention floor when compaction explains the loss, or reports degraded divergence. Only explicit `adopt-external` may replace displayed history. |
| Projection journal committed, provider not persisted | Row remains visible and projection-durable; terminal success, resume, and native fork stay degraded until repair. |
| Live notification received, journal append incomplete | Invalid tail is removed; provider audit repairs the missing durable item. |
| Projection store corrupt, redundant byte-identical ledger evidence available | Repair the bound store in place after validating entry IDs, envelopes, content epoch, and revision; no reset or search churn occurs. |
| Projection store corrupt, only native reconstruction available | Stay degraded. A staged reconstruction becomes authoritative only through an approved `journal-repair` reset with a new content epoch; no partial or silent read-time fallback occurs. |
| Active input committed only in memory | Input and queue state disappear on restart; fresh epoch exposes the durable prefix. |
| Input `commit()` mutated then rejected | Core resolves the idempotency key while the turn remains non-runnable. |
| Core applied an event but offset commit failed | Integration retains extra replay; retry is idempotent. |
| Destructive reset synced in the integration store, registry epoch not flushed | Core continues exposing only the last-applied qualified search state. Restart/cold open observes and flushes the new epoch before serving transcript pages; old-result navigation is rejected. |
| Registry epoch flushed, core reset install/offset commit missing | Restart query admission already excludes old search rows. `openSegment()`/relist installs the matching ledger state idempotently before serving the chat. |
| Control or terminal existed | Volatile state disappears; new server instance and stream epoch reject stale delivery. |
| Handoff staged, no decision record | Presumed abort and audited source restoration. |
| Handoff decision recorded, registry/incoming incomplete | Roll forward target ownership before serving. |
| Terminal completeness/replay failure | Fail turn, release owner, retain repair reservation, block later admission. |

No recovery path uses equal content as identity evidence.

## Provider Strategies

### Codex 0.146.0

Garcon pins `@openai/codex` 0.146.0 at upstream commit
[`5d1fbf26`](https://github.com/openai/codex/tree/5d1fbf26c43abc65a203928b2e31561cb039e06d).

Codex persists `ItemCompleted` before notifying the app-server channel, but
`thread/turns/list` replays the rollout and merges an in-memory active turn. It is not a
safe low-latency changefeed.

The initial adapter:

- converts safe settled native history once into a full normalized journal genesis;
- consumes finalized item/raw-item notifications under the stream mutation gate;
- assigns canonical native item plus semantic subrow identity;
- syncs the complete rendered envelope, identity, provenance, and alias metadata before
  durable commit publication;
- never calls `thread/turns/list` per item;
- emits terminal only after completed/aborted settlement and audit;
- imports a crash-missed native suffix through the journal by canonical source identity;
- retains committed journal rendering on ordinary converter/audit mismatch; and
- treats rollout compaction/rollback as provider-context evidence: it appends an
  observable compaction or replacement occurrence, advances the native-retention floor,
  and keeps previously committed rows.

The planned metadata sidecar is therefore a full projection journal, not a read-time
join with rollout content. Runtime pages, reload, search, preview, handoff freeze, and
entry lookup all re-serve journal envelopes. Rollout history remains the source of
record for execution resume/fork continuity and evidence for import/audit because it
does not preserve Garcon ownership, request, message, turn, or receipt-owner provenance.
A notification converter renders a committed row once; the native importer never
re-renders that row on reload.

### Claude

Claude uses a normalized integration journal:

- native JSONL import creates the initial projection;
- accepted input goes through stream admission;
- finalized live batches sync before commit events;
- the integration remains owner through true background-task idle;
- restart/resume/idle audit compares canonical source identities;
- crash-missed native rows are imported once; and
- compaction and microcompaction append any observable summary, advance native-retention
  metadata, and leave earlier ledger entries intact; converter or committed-source
  disagreement retains the journal rendering and degrades.

Claude native JSONL remains execution resume/fork storage. The journal remains UI,
paging, reconnect, handoff, and search authority. Native import/audit writes only
through it. Core never sees them as competing histories.

### Pi 0.83.0

Pi emits `message_end` before `SessionManager.appendMessage()` persists and may defer the
first file flush until an assistant row exists. Pi therefore journals normalized
finalized entries before emitting stream commits and audits only at `agent_settled`.

A crash after journal sync but before Pi persistence preserves the row, records native
continuity degradation, withholds terminal success, and makes resume/native fork typed
unavailable. Audit may later bind a native alias; it never deletes or reshapes the
committed row to match a shorter Pi file. The journal is Pi's sole rendering authority.

### Direct Providers

Direct providers adapt the existing fsynced `DirectSessionStore`. It already persists
complete rendered messages before publication, so it already is their normalized
rendering authority. The adapter adds explicit entry identity, projection state, and
stream events without duplicating message storage.

Before the coordinated V4 activation, any new direct-store fields must remain parse
compatible with the V3 reader or live in a sidecar. After the first V4-only authoritative
record is written, incident response rolls forward as stated in the execution plan; the
design does not claim a lossless V3 binary rollback.

### Other Integrations

OpenCode, Amp, Factory, and Cursor initially use the shared engine with current finalized
event translation plus one-time/repair native import into a normalized projection store.
OpenCode retains its real-binary scripted tier. Cursor remains unit-only. A physical
store strategy may change for a newly created segment or explicit schema migration, but
never silently inside an existing segment.

## Failure Semantics

### Stream Gap

Core receives an event whose complete predecessor is not applied. It performs inline
replay from its checkpoint. A contiguous chain applies exactly once. `expired` while
idle causes relist; `expired` while a turn is open fails/fences the turn.

### Duplicate Or Contradictory Offset

Within `(committed, applied]`, equal address, digest, and checkpoint is a no-op
duplicate. Equal address with any different data is `PROJECTION_EVENT_CORRUPT`,
clears/fails the open turn, and requires relist/audit. At or below the committed offset,
the event is ignored as settled past because core's successful acknowledgement proves
application; no content claim is made after the bounded proof was released. Cursor
equality alone is never duplicate proof inside the uncommitted window.

### Superseded Epoch Delivery

Core retains a bounded epoch-tombstone LRU independently of view pages. An event from a
known superseded epoch is ignored without reload or generation churn. After tombstone
eviction, the same event takes the conservative gap/relist path. A stale ownership epoch
is rejected before this logic.

### Consumer Lag

Offset-commit failure retains events. A measured soft limit emits
`PROJECTION_CONSUMER_LAG`; a hard limit fences new input/handoff rather than discarding
uncommitted proof. Retry occurs outside execution ownership and performs no provider IO.

### Destructive Reset Failure

Any target-page, revision, receipt-summary, command-ledger, search, or browser staging
failure leaves the old projection and epoch untouched. The source remains degraded and
repair runs at a later safe idle boundary.

### Provider Audit Failure

The committed projection remains visible. Audit failure marks it dirty and retries on a
later idle/reload/resume boundary. A source-identity divergence may append a proven
suffix, advance the native-retention floor, or fence native resume/fork. Different
native converter output for an already committed source is diagnostic only and cannot
become authoritative. Replacing displayed history requires a separately authorized
`adopt-external` or `journal-repair` operation.

### Projection Ahead Of Provider

Garcon pages, searches, shares, exports, and carries over the durable projection.
Provider resume/fork remains typed degraded and terminal success is withheld until
native continuity is confirmed or repaired.

### Handoff Failure

Failure before the decision record aborts staged state. Failure after it rolls forward.
Cleanup failure becomes retained maintenance work and cannot revert ownership. A
post-lease provider mutation is diagnosed and preserves provider artifacts for repair.

### Head-Of-Line Failure

One stream intentionally couples transcript, control, and terminal progress. A corrupt
or unstaged reset blocks later control/terminal events instead of letting projections
diverge. All reducer/replay work is retained-state-only and bounded; timeout converts the
whole open turn to one explicit failed outcome.

## Security And Privacy

- Journals contain the same sensitive content as provider history and use agent-scoped
  storage, mode `0600` files, and current workspace controls.
- Browser contracts expose provider-neutral messages, not source IDs or stream offsets.
- Logs contain chat/agent IDs, fencing/stream epochs, offsets, counts, and error codes,
  never message content, tool arguments, credentials, or journal records.
- Search source references remain opaque and credential-free.
- Deletion removes all Garcon-owned journal/replay state and provider artifacts governed
  by the integration's deletion policy.
- The design adds no network service and no new dependency.

## Performance

- Stream commit/control/terminal application is O(event batch size).
- Durable revision updates are O(new/promoted durable entries).
- Pages are O(page size) against retained projection/journal ordinals.
- Transient-only events do not invalidate transcript page snapshots.
- Core commits offsets after each atomic apply batch to bound chatty control retention.
- A maximum-size input-only reset writes fixed metadata independent of transcript length.
- Codex full rollout replay occurs only on bootstrap/coalesced settled audit.
- First import is O(native history) once per pre-existing segment, is staged atomically,
  and may return typed deferred/degraded rather than serve a partial journal.
- Provider-specific native pagination is absent from the serving path; every runtime and
  search page reads the normalized projection store.
- Codex intentionally duplicates rendered transcript content alongside its rollout.
  Measure journal bytes and import latency before introducing content-addressed large
  payloads; schema migrations never re-render rows implicitly.
- Search validates and appends only the durable suffix when its prior count/revision
  matches; full rebuild is reserved for content-epoch, carryover, projector/schema, or
  corruption changes.
- Search continues serving a verified old prefix during same-epoch append lag and
  excludes a prior destructive epoch immediately through the query allowlist fence.
- Search dirties only on durable ledger/composition changes, never control, terminal,
  session, native-retention, or process-generation events.
- Journal compaction is threshold-driven and idle-only.
- Per-open-turn ingress summaries and control maps are non-evictable but bounded by
  provider event/control limits; hard limits fail/fence rather than discard identity.

## Observability

Provider-neutral diagnostics include:

- `PROJECTION_EVENT_APPLIED`
- `PROJECTION_DUPLICATE_IGNORED`
- `PROJECTION_STALE_OWNER_IGNORED`
- `PROJECTION_STALE_EPOCH_IGNORED`
- `PROJECTION_GAP_DETECTED`
- `PROJECTION_EVENT_CORRUPT`
- `PROJECTION_RELIST`
- `PROJECTION_RESET`
- `PROJECTION_READ_DEFERRED`
- `PROJECTION_AUDIT_MISMATCH`
- `PROJECTION_NATIVE_DIVERGENCE`
- `PROJECTION_NATIVE_RETENTION_ADVANCED`
- `PROJECTION_RENDER_AUTHORITY_MISMATCH`
- `PROJECTION_NATIVE_CONTINUITY_DEGRADED`
- `PROJECTION_ADMISSION_AMBIGUOUS`
- `PROJECTION_CONSUMER_LAG`
- `PROJECTION_TERMINAL_COMPLETENESS_FAILED`
- `PROJECTION_HANDOFF_DECISION_AMBIGUOUS`
- `PROJECTION_HANDOFF_POST_BOUNDARY_EVENT`
- `PROJECTION_JOURNAL_RECOVERED`
- `PROJECTION_REGISTRY_EPOCH_MISMATCH`
- `SEARCH_CONTENT_EPOCH_MISMATCH`
- `SEARCH_PREFIX_CATCHUP`
- `SEARCH_RESULT_STALE`

Diagnostics include identities/counts only. Existing native/live reconciliation logs are
deleted with the old layer.

## Execution Plan

Phases are reviewable work packages for one coordinated version 4 activation. API
version 3 stays active until core, all integrations, browser transport, handoff, fork,
and search implement version 4. After version 4 writes journal-only authoritative rows,
incident response rolls forward rather than claiming a lossless version 3 downgrade.

### Phase 0: Contain The Current Regression

Land an independently revertible containment fix before the migration:

- Live append performs no provider transcript IO.
- Existing page-backed views append against their frozen baseline.
- Cold native reads use the existing transcript-snapshot reservation or return typed
  deferred if execution already owns the chat.
- Idle reconciliation remains the only native promotion point.
- Codex declares no concurrent transcript-read capability.
- Preserve exact semantic source identity tests, but do not add more content matching or
  unbounded publication proof.

Primary files:

- `server/chats/chat-view-store.ts`
- `server/server-event-wiring.ts`
- `server/chat-execution/types.ts`
- `server-agents/interface/src/contracts/transcript.ts`
- `server-agents/codex/src/agents/codex/app-server/runtime.ts`
- `common/chat-view.ts`
- `server/routes/chats.ts`
- `web/src/lib/chat/transcript/active-transcript-state.svelte.ts`

Required regressions cover both reservation directions: an active Codex turn defers a
cold/earlier native read, and a held native read finishes before a newly requested turn
starts.

### Phase 1: Version 4 Types And Shared Engine

Add unused version 4 types and shared mechanics while API version 3 remains active:

- fencing/stream/checkpoint/entry/event contracts;
- ledger/search content epochs and native-retention-floor metadata;
- stable canonical JSON and ordered revision helpers;
- transcript/control reducer and event digest validation;
- replay retention, consumer offset commit, and epoch tombstones;
- projection-state-pinned paging;
- input admission state machine;
- journal/reset manifest/recovery primitives;
- checkpoint-pinned index envelope/suffix contracts;
- outgoing lease and incoming preparation; and
- reusable conformance harness.

Primary locations:

- `common/json.ts`
- `server-agents/interface/src/contracts/transcript-stream-v4.ts`
- `server-agents/interface/src/contracts/execution-events-v4.ts`
- `server-agents/interface/src/ownership-epoch.ts`
- `server-agents/interface/src/testing/conformance.ts`
- `server-agents/common/src/transcript-projection/*`

The current carryover serializer remains until compatibility tests prove a shared
replacement. No active API version type becomes a conditional union.

### Phase 2: Core Ingress, Admission, Terminal, Browser State

Core creates one `ProjectionIngress`:

- subscribe/open/load before execution;
- serialize every stream event through the per-chat queue;
- keep non-evictable open-turn ingress/control state;
- route accepted input through the integration transaction;
- attribute command output by immutable receipt-owner provenance;
- apply terminal frontier and lifecycle in one task with unconditional release;
- commit consumer offsets after atomic local application;
- derive transient revisions and compound generation transitions; and
- durably mirror segment content epochs in the chat registry before reset/search
  cutover;
- replace repair-required turns with the transcript-snapshot reservation.

Primary locations:

- `server/agents/event-bus.ts`
- `server/agents/registry.ts`
- `server/server-event-wiring.ts`
- `server/chats/chat-view-store.ts`
- `server/chats/store.ts`
- `server/chats/ordered-chat-transcript-reader.ts`
- `server/commands/command-ledger.ts`
- `server/chat-execution/*`
- `common/ws-events.ts`
- `common/chat-snapshot.ts`
- `web/src/lib/ws/*`
- `web/src/lib/chat/transcript/*`

The browser derives display rows from transcript entries, pending-input overlays, local
notices, and transient rows. It does not mirror collections through a Svelte effect and
does not remount the heavy chat surface on generation change.

### Phase 3: Provider Adapters

Migration order:

1. Direct providers prove the existing durable outbox path.
2. Claude proves journal bootstrap/live/true-idle/crash repair.
3. Codex proves notification-backed full-journal authority and settled native audit
   without active `thread/turns/list` or native rendering on the serving path.
4. Pi proves projection-ahead/native-degraded behavior through `agent_settled`.
5. OpenCode, Amp, Factory, and Cursor adopt behavior-preserving adapters.

Every provider also proves that automatic compaction/rollback changes native-retention
metadata or appends an observable occurrence without rewriting committed ledger rows.

Every adapter passes shared conformance and a provider-specific preterminal
interleaving. Claude, Codex, Pi, and OpenCode also pass their scripted real-binary tier;
Cursor remains unit-only.

### Phase 4: Handoff, Fork, Search, And Deletion

- Replace settled native capture/check-revalidate with the outgoing lease.
- Add the ownership-journal `commit-decided` phase as the single durable decision.
- Make registry/incoming/outgoing recovery apply that decision idempotently.
- Resolve fork points by ownership/content epoch and entry ID, with typed availability
  below the native-retention floor.
- Upgrade the index source from `ChatMessage[]` to durable entry envelopes and pinned
  checkpoints.
- Add composite search content epochs to catalog allowlists, SQLite state/chunks,
  results, and navigation validation.
- Implement validated incremental suffix indexing and snapshot rebuild fallback.
- Make preview, metadata, share/export, and archive reads use the pinned composite
  ledger reader.
- Run the idle-only, rate-limited existing-chat sweep that initializes V4 journals and
  registry content-epoch mirrors before/through cutover; retry typed deferred/degraded
  chats without blocking search for completed chats.
- Enforce runtime/index/share/preview/handoff envelope parity.
- Preserve immutable carryover schema and composition.
- Apply release policy only after decision roll-forward or deletion decision.

### Phase 5: Cut Over And Delete Reconciliation

In one coordinated commit:

- set every built-in integration to API version 4;
- remove execution `messages` and terminal callbacks;
- activate the stream ingress and browser contracts;
- delete central native/live overlap reconciliation, publication proofs, and
  non-enumerable native-source transport; and
- remove per-append provider transcript loaders and Codex's native paginated-history
  serving path while retaining its importer/auditor;
- remove provider-native index renderers and message-only index batches; and
- change search navigation from bare ordinal to content-epoch-qualified entry anchor.

Validation:

```sh
bun run typecheck
bun run check
bun run test
timeout 30s bun run start --port 0
```

The startup check uses a new random port and never touches the user's server.

## Conformance And Test Plan

### Shared Stream Cases

- two equal-content entries with distinct IDs both survive live, reload, and search;
- one committed envelope is byte-identical through live publication, restart, paging,
  search, preview, and handoff freeze;
- native audit of an already committed source with different converter output diagnoses
  mismatch without changing the stored envelope or revision;
- repeated provider compaction appends distinct compaction occurrences, advances the
  native-retention floor, and preserves all earlier envelopes/content epoch;
- provider rollback/retry keeps finalized shown attempts and appends replacement
  occurrences under distinct identities;
- first native import creates journal genesis, while a crash-missed canonical suffix
  appends once through the same store;
- one canonical item expands atomically to several semantic subrows;
- observation-channel aliases normalize to one canonical source;
- same uncommitted offset/digest/checkpoint redelivery applies once;
- the same uncommitted offset with different active payload/checkpoint/digest is
  corruption;
- redelivery at or below the committed offset is ignored as settled past after its
  bounded proof is released;
- every applied offset in `(committed, applied]` retains its duplicate proof;
- old ownership events are rejected after handoff away and back;
- superseded stream-epoch events do not rotate the generation;
- an evicted epoch proof falls back to relist rather than assumed stale;
- subscription plus open/load cannot miss an interleaved event;
- `openSegment()` returns ready/deferred/degraded for provider bootstrap, and every
  relist obtains its new offset baseline through `openSegment()` rather than pages;
- replay is contiguous across commit/control/session/reset/terminal variants;
- a terminal or control callback delivered before an earlier commit triggers inline
  replay and preserves stream order;
- consumer offset commits release only the matching prefix and retry without provider
  IO;
- consumer-lag hard limit fences admission without evicting uncommitted events;
- process restart rotates epoch, drops active/control state, and preserves durable entry
  IDs/revision;
- adapter stream-state loss while core stays alive produces unknown-epoch relist, never
  a synthetic transition chained to lost state;
- volatile events between durable journal records do not affect durable recovery;
- control/session/terminal events leave projection state unchanged and do not invalidate a
  continuation page;
- a null transient-control marker rejects control emission, while a non-null marker runs
  the complete shared control conformance suite;
- every page chain remains pinned to one projection state across tail/control events;
- an expired projection returns relist, never mixed pages;
- parser round-trip and optional-field insertion order do not change revisions;
- schema upgrade preserves stored rendering unless an explicit migration reset is
  requested;
- repeated non-finalizing accumulator checkpoints remain valid;
- every provider-touching read is ready/deferred/degraded and never contends from apply.

### Admission And Reset Cases

- prepare/commit/rollback/retry is idempotent;
- post-mutation/pre-return commit rejection resolves as committed and cannot roll back;
- unresolved admission remains non-runnable and fenced;
- cross-restart committed/discarded resolution returns a settled no-event outcome; the
  same request ID with a new turn or payload is a typed conflict and never starts the
  provider;
- same text under different IDs creates two rows;
- a second distinct admission is blocked while one active input remains;
- promotion preserves ID, ordinal, provenance, payload, and binds source once;
- known-not-sent derives exactly the one active tail ID and rotates epoch/generation;
- input-only reset rejects changed, dropped, reordered, or inserted durable entries;
- maximum-size input reset writes one bounded direct content-root manifest;
- rejected steer with a held permission preserves the same control incarnation exactly
  once through the compound transition;
- unknown delivery keeps the row and fences later work;
- every mid-turn destructive reset is rejected; `input-not-sent` is the sole exception;
- a settlement-discovered provider compaction appends any summary, updates continuity,
  and emits terminal without generation/content-epoch rotation;
- a mid-turn automatic compaction row carries the current owner and increments terminal
  completeness, while an idle external compaction row has null provenance;
- an explicit user revert/truncate or external adoption waits for idle and fences later
  admission until its reset is applied;
- aborted destructive reset staging mutates no projection, receipt, search, or browser
  state;
- approved destructive reset invalidates affected command results rather than silently
  rewriting them; and
- unapproved external divergence keeps the ledger unchanged and makes unsafe
  resume/fork typed degraded.

### Terminal And Control Cases

- initial input plus multiple steers preserves one immutable terminal receipt owner;
- assistant output after each steer reaches only the original owner receipt;
- terminal exact input-set validation catches missing, extra, duplicate, wrong-owner,
  and rejected-steer IDs;
- terminal count mismatch fails/fences the turn;
- successful terminal requires durable full projection and confirmed settlement;
- returned/thrown replay failure releases the owner in `finally` and leaves repair fence;
- no unbounded/provider-IO task can precede terminal application on the per-chat queue;
- `AgentStartedSession` return and ordered session event must agree; a crash between
  provider session creation and event apply repairs registry metadata without reviving
  execution;
- start/resume stop and abortability continue through `AgentExecutionAdmission` after
  the execution callback is removed;
- permission upsert/update/remove applies in stream order;
- delayed old-incarnation updates cannot resurrect or remove a new incarnation;
- terminal clears controls before lifecycle broadcasts;
- restart drops actionable permissions;
- same-server reconnect snapshot preserves a live permission once;
- WebSocket remove before older HTTP snapshot and the reverse order both converge;
- skipped transient revision fetches a complete snapshot;
- equal revision with a different digest is a protocol error;
- off-window anchor stays in the dedicated action surface until its row loads;
- permission decision during input-reset reload accepts the unchanged incarnation;
- rapid chat switching does not leak transient rows or shift composer/dock geometry.

### Handoff Cases

- lease freeze contains exactly the durable segment and excludes later application;
- a mutation admitted before lease acquisition is drained into the frozen segment;
- a callback buffered during staging makes the synchronous seal fail and rollback
  replays it in source order;
- a microtask scheduled at the seal boundary cannot enter as a pre-seal mutation;
- predecision failure rolls back staged artifacts and replays/audits buffered source;
- an injected decision-file `fsync` error permits no step-8 progress or rollback based
  on read-back; repeating the same atomic replacement to a returned success permits
  roll-forward;
- crash immediately before decision yields one outgoing owner;
- crash immediately after decision but before registry flush yields one incoming owner;
- registry updated but incoming activation incomplete rolls forward;
- no participant-local lease record can override the coordinator decision;
- post-seal callback is rejected/diagnosed and blocks destructive cleanup until
  repair disposition;
- incoming preparation failure/rollback leaves no second writer;
- deferred/degraded incoming preparation makes no decision and rolls back the source
  lease only through the predecision path;
- repeated cross-provider handoff preserves each segment once;
- handoff away/back rejects all old epochs;
- deletion and transfer release different artifact sets as policy requires.

### Search And Derived-Consumer Cases

- search, runtime paging, preview, share/export, and handoff freeze receive byte-identical
  envelopes for one pinned projection checkpoint;
- the index source rejects a prior count with the wrong prefix revision and falls back
  to a snapshot instead of appending by count alone;
- index catch-up after physical journal compaction either uses a retained exact prefix
  checkpoint or takes the explicit expired-to-snapshot path;
- a durable append streams only the contiguous suffix and leaves the composite content
  epoch unchanged;
- non-searchable durable entries advance the indexed checkpoint without creating an FTS
  row;
- same-epoch indexing lag continues to serve the verified old prefix and reports the
  exact indexed/target counts;
- restart followed by global search over unopened chats derives expected epochs from the
  durable registry mirror without opening providers or trusting SQLite state;
- upgrade a workspace containing never-opened legacy chats, rate-limit/idempotently
  backfill their journals and registry mirrors, defer one busy chat until idle, and
  prove global-search coverage eventually returns without notification/unread replay;
- a destructive reset changes the expected content epoch and every query admitted after
  that cutover excludes old rows before the replacement index seals;
- a query admitted before reset whose reader result returns afterward is dropped by the
  service's latest-catalog epoch recheck;
- crash after integration reset commit but before registry-epoch flush preserves only
  the last-core-applied qualified search state; cold open discovers the new epoch before
  transcript service and stale-result navigation cannot resolve;
- crash after registry-epoch flush but before in-memory reset install makes old search
  rows ineligible on restart and relist installs the matching ledger state;
- a search result clicked after revert, carryover repair, or handoff returns
  `SEARCH_RESULT_STALE`, while a click after ordinary tail append still resolves its
  exact entry anchor;
- process restart and `input-not-sent` preserve the search content epoch and do not
  rebuild an unchanged durable prefix;
- repeated provider compaction retains all pre-compaction search rows and incrementally
  indexes each visible compaction message;
- handoff/carryover recomposition rebuilds under one new composite epoch with each frozen
  segment and switch boundary exactly once;
- projector/schema upgrade rebuilds search without changing ledger content epoch or
  stored transcript rendering;
- deletion removes the chat from the query allowlist before worker cleanup and cascades
  SQLite rows without allowing stale catalog replay;
- search anchors come from serialized entry/segment identity, never non-enumerable native
  message metadata;
- share/export taken during append uses one pinned durable checkpoint and contains no
  active input or transient control; and
- preview cache invalidates on durable append and destructive reset but not control,
  terminal, native-retention, or process-generation changes; and
- cold open/relist repairs metadata without replaying unread or notification side
  effects for already materialized entries.

### Provider Interleavings

**Codex:** hold model output, place persisted items ahead of notifications, and prove
each full journal envelope publishes once with original provenance before terminal.
Restart and settled audit re-serve the journal and compare entry IDs, revisions, receipt
attribution, tool shape, and search parity without native re-rendering. Crash after
rollout persistence but before journal append imports exactly the missing suffix.
Compact/rollback the rollout and prove older journal/search rows survive while native
fork below the advanced retention floor becomes typed unavailable. Use `gpt-5.4-nano`,
bypass permissions, and lowest reasoning effort.

**Claude:** crash between native JSONL and Garcon journal notification, import one row,
and preserve rendering. Prove background continuation prevents early terminal and
microcompaction does not rewrite committed ledger/search rows. Use Haiku and lowest
supported effort.

**Pi:** delay Pi persistence after `message_end`, prove journal-first projection, then
crash before native persist. Reload keeps the row, terminal success is withheld,
resume/fork is degraded, and audit never deletes/morphs it.

**Direct:** existing suites assert fsync, stream commit, browser message, and terminal in
that order.

### Manual Verification

- Submit identical prompts twice and observe two rows.
- Observe Codex user/tool/result/assistant rows before and after settle and reload.
- Page earlier history during a held turn without provider contention or false
  exhaustion.
- Hold a permission, reject a steer as not sent, delay the replacement page, and verify
  the permission remains actionable once.
- Reconnect during a turn and verify contiguous replay or one explicit relist/reset.
- Compact repeatedly with queued work and verify each compaction appends normally,
  previous UI/search rows remain stable, native fork availability moves only at the
  retention floor, and no generation refresh occurs.
- Verify providers that previously emitted mid-turn `processing: false` do not regress
  stop controls or final processing state when processing derives from reservation.
- Inject a late outgoing callback during handoff and verify one frozen segment and one
  owner after recovery.

## Acceptance Criteria

- Core receives no unrestricted live transcript `ChatMessage[]` and no terminal on a
  separate integration order.
- One integration stream orders every current-segment transcript/control/terminal event.
- One integration-owned normalized store remains the rendering authority for the full
  segment; native history never becomes a competing reload/page/search renderer.
- Automatic provider compaction, rollback, retry, and pruning never remove or morph a
  committed conversation-ledger entry.
- Core never reconciles provider-native and separately ordered live arrays.
- Every transcript occurrence has explicit entry/source/provenance identity.
- Equal content under different identity survives; duplicate event delivery applies once.
- Every effect is ownership-epoch fenced.
- Transient events do not invalidate transcript page snapshots.
- Accepted input is applied before execution and ambiguous commit never starts provider
  work or rolls back a maybe-committed row.
- Every successful terminal validates the exact accepted-input set, attributable count,
  durable full projection, immutable receipt owner, and native settlement.
- A terminal cannot overtake a prior transcript/control event.
- Active input/control/queue/ledger state is not recovered after restart.
- Every row removal rotates stream epoch and browser generation without reusing an
  address.
- Input-only reset preserves the durable prefix and current permission exactly once.
- Browser snapshots/mutations reject stale instance/generation/revision state.
- Destructive durable reset requires explicit user/repair/migration authority, occurs
  only with no open producer turn, installs a fully durable target with a new content
  epoch, and clears transient controls before later admission.
- Provider reads are retained-state-safe or typed deferred/degraded.
- Codex performs no per-item `thread/turns/list` read and preserves complete rendered
  envelopes plus provenance in its normalized journal.
- Claude and Pi crash windows preserve one stable normalized rendering.
- Handoff has one durable coordinator decision record, one mutation-excluding outgoing
  lease, and one inert incoming preparation.
- Fork resolves exact ledger identity and reports native-retention unavailability rather
  than using rendered counts.
- Search consumes durable entry envelopes, serves only an expected composite content
  epoch, safely exposes a verified prefix during append lag, and rejects stale-result
  navigation after destructive change.
- Cold-chat search derives the current segment content epoch from a registry-durable
  mirror flushed before core reset cutover, never from SQLite self-validation.
- Cutover rate-limits and eventually backfills that mirror for pre-existing idle chats,
  so unopened history does not remain search-pending indefinitely.
- Preview, metadata, sharing, export, carryover, and archive reads use the same pinned
  composite ledger and never the search database or provider renderer.
- Central reconciliation and publication-proof code is deleted after cutover.

## Alternatives Considered

### Universal Native-History-Only Projection

Rejected. Providers do not expose one low-latency, durable, concurrency-safe changefeed.
Codex list reads contend/replay, Pi notifies before persistence, Claude result is not
necessarily idle, and some providers have no incremental cursor. Notification-triggered
Codex rollout tailing would couple the hot path to a private drifting format and still
need a provenance sidecar, recreating a read-time join. Native stores remain execution
continuity sources and projection evidence, not rendering authorities.

### Universal Live Stream With Core-Owned Message Journal

Rejected. It makes core responsible for provider bootstrap, native compaction,
fork/resume identity, and crash repair. A normalized journal remains a valid private
integration strategy and is required as the logical rendering authority here; its
ownership behind the integration boundary is the distinction.

### Separate Transcript, Control, And Terminal Streams

Rejected after independent review. The integration already serializes these mutations.
Splitting them requires terminal watermarks to rejoin transcript order, transcript
anchors to rejoin control order, reset/control cross-pins, acknowledgement tokens, and
empty-control proofs. Repeated review found legal races at those joins. One stream keeps
source causality; core still projects durable and ephemeral browser state separately.

### Persist Every Stream Event

Rejected. Persisting permissions and terminals risks reconstructing actionable execution
state after restart. Filtering the journal to durable projection changes and rotating
the stream epoch on every process restart is simpler and safer.

### Keep Central Reconciliation With Better Identity

Rejected. Exact source IDs cannot tell core whether a provider read is safe, whether a
page imported a row before its callback, or whether a terminal includes all output.

### Return Only `ChatMessage[]`

Rejected. Rendered payload does not encode occurrence identity, causal order, durability,
replay, resets, or receipt attribution.

### Avoid Generation Reset For Known-Not-Sent Input

Deferred. Preserving generation would require never-reused sequence high-water marks,
tombstones, and a browser mutation cursor. This migration keeps the current append-only
`(generationId, seq)` contract and pays one reset.

## Resolved Decisions And Deferred Work

Resolved:

- Integration owns its current segment; core owns immutable carryover composition.
- One normalized integration-owned conversation ledger is the unchanging rendering
  authority for each segment; notifications and native history only feed or audit it.
- Provider execution context may compact or retain less history without rewriting the
  ledger; a monotonic native-retention floor carries that distinction into fork/resume.
- One integration stream, not three rejoined channels, carries transcript, controls,
  and terminals.
- Stream offsets are causal; projection state separately pins pages.
- Every process restart rotates stream epoch and drops volatile state.
- Consumer offset commit replaces checkpoint, terminal, and control acknowledgements.
- Accepted input is a projection-owner transaction with queryable ambiguous outcome.
- One immutable receipt owner receives all output across steers.
- Terminal completeness assertion stays mandatory; provider-specific interleavings prove
  the producer actually observed every row.
- Input-only reset preserves current control fold and ledger content epoch; every
  destructive durable reset is explicitly authorized, idle-only, and clears controls.
- Browser generation plus transient state installs as one state-of-the-world event.
- Handoff outcome is decided only by the core ownership journal.
- Codex, Claude, and Pi are notification-backed full-journal authorities with
  provider-specific native settlement audits; direct stores already satisfy the same
  model.
- Search is a derived envelope projection with incremental suffix indexing and a
  composite content-epoch fence; it never renders native history independently.
- Shared mechanics live in `server-agents/common`; no new SQLite store is introduced.

Deferred, non-blocking:

- Carryover may later retain provider-neutral provenance if a product feature needs it.
- Journal compaction thresholds follow measured workspace data.
- Token-delta streaming remains a separate design.
- Multi-process/multi-consumer stream replication would require durable consumer groups
  and state snapshots and is outside this single-server architecture.

None of the deferred items blocks the version 4 single-stream migration.
