# Garcon Transcript Ledger V5: Core-Owned Append-Only Authority

Status: revision 11, approved for implementation. Supersedes `AGENT_OWNED_TRANSCRIPT_PROJECTION_DESIGN.md`
(V4, SHA-256 `12e6efbcbd30419c0b4580d8159f60e2b1948d8dd790857a070dee5b3f6873cf`),
which remains untouched as the historical record of the reconciliation-based
architecture and its implementation through commit `f029424c`.

Revision 11 is the final deletion-and-fix pass, jointly reviewed and
user-approved. `publish()` now commits synchronously, deleting the
producer FIFO, `flush()`, close-and-drain, the publish/close race
protocol, and the queue's `sending` state. The sink is a capability
object closed by core; `agentOwnershipToken` is deleted, leaving the
transcript protocol exactly two identities. Shares are self-contained
snapshots (verified against the existing product implementation),
deleting the L8 exception; the reload cutover atomically deletes the old
view (user choice), deleting the `retained` status, retained reads, disk
reporting, and all GC policy. `binding_json` dissolves: the latest
`session` ledger row at or after `content_start_ordinal` is the durable
session authority and the registry becomes a repairable cache. Event
correlation rules are finalized (`runId` mandatory on `run-ended` and
permission lifecycle, absent on rows and session), fixing the late-end
contradiction; `run-ended: failed` may carry optional sanitized error
detail (user choice); duplicate-submission retries never re-dispatch;
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
   acceptance and durability are the same point. That, plus a
   session-ref codec, an optional one-time native history import, an
   optional tail probe, and an optional native fork, is the entire
   provider surface.
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
   interruption `run-ended` rows, and stopping at provider output, any
   permission request, or any other `run-ended` row. Opting out is
   ephemeral composer state. There are no markers, no retraction rows,
   and no delivery evidence of any kind.
7. **One manual exception.** The explicit user action "Reload from
   native history" is the sole full-transcript replacement path. It
   rotates a narrow `transcriptViewId`; nothing else does. It is never
   automatic, exists only for chats whose current binding has a native
   source and a non-null `nativeHistoryImport`, preserves the frozen
   prefix before the current binding while importing exactly that one
   source through its tail, and atomically deletes the replaced view in
   the cutover transaction.
8. **Runs are ephemeral correlation.** Active execution holds an
   in-memory `runId`. `runId` is mandatory on `run-ended` and permission
   lifecycle events — the events that touch run or actionability state —
   and absent from content rows and session facts. A user interrupt
   immediately marks the run stopped and appends
   `run-ended: interrupted`; provider abort is best-effort; a duplicate
   or stale end signal is ignored and never stored; an interrupt with no
   active run is an idle no-op. Late provider content and session facts
   always commit while the sink is open.
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
    expected — it is the manual-reload product case. The native drift
    check probes only the current binding, compares against
    integration-emitted history only, appends a visible notice
    recommending manual reload, and never blocks anything.

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
  opt-out state, is process-ephemeral overlay and dies on restart.
- **L4 Durable before dispatch, idempotent by message identity.** An
  immediate input is appended and committed before provider dispatch; a
  steer before delivery is attempted; a dequeued queued entry before its
  dispatch. A future-turn queued input is not a transcript row.
  Submission is idempotent by `(chatId, transcriptViewId,
  clientMessageId)`: the same ID with identical content and attachments
  returns the existing queue disposition or ledger row and never
  re-dispatches; the same ID with different content is a typed conflict;
  a submission qualified by a stale view after manual reload is
  rejected, never deduplicated into the replacement.
- **L5 At-most-once, observed order.** Every accepted event is committed
  at acceptance or the chat fences; there is no retry protocol and no
  producer event identity. Late provider content and session facts —
  received after an interruption or another run's start — always commit
  in observed order while the sink is open; they participate in every
  read fold but cannot change processing state or make an old permission
  actionable. A duplicate or stale `run-ended` is ignored and never
  becomes a row. Across a crash, events the provider emitted but core
  had not yet handled are lost, accepted.
- **L6 Run lifecycle.** Core applies each chat's events in the order
  their synchronous appends begin on the event loop; no ledger
  transaction spans an `await`. A session event is required only before
  provider output that depends on a newly established native session;
  resumed turns create no session row. `run-ended` is a durable
  lifecycle row (`outcome: finished | failed | interrupted`,
  `origin: provider | core`, optional sanitized `error`); run
  correlation is an ephemeral in-memory `runId`, mandatory on
  `run-ended` and permission lifecycle events and absent from content
  rows and session facts: a user interrupt immediately marks the run
  stopped and appends `run-ended: interrupted`; a later end signal for a
  stopped or unknown run is ignored; an interrupt with no active run is
  an idle no-op. The prior run's rows and its `run-ended` are committed
  before the scheduler starts the next queued turn. A crashed process
  leaves no `run-ended`; restart synthesizes nothing.
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
  surfaces remain available throughout. Memory for live transcript state
  is governed by the existing bounded chat cache and row-window eviction
  — implementation details, not transcript protocol; eviction never
  truncates the ledger.
- **L8 View stability.** `transcriptViewId` changes only through manual
  full reload. Every page, event, search result, and cursor is qualified
  by it; requests qualified by a replaced view receive a typed
  stale-view error whether or not its rows still exist. There are no
  exceptions: shares are snapshot artifacts, not ledger readers.
- **L9 Advisory drift detection.** The native drift check is a
  point-in-time bounded tail read at chat open and before native resume,
  probing only the chat's current binding. The probe obligation: the
  reported relevant-entry timestamp must be no later than core's append
  time for any entry Garcon observed; a provider that cannot guarantee
  this returns `unavailable`. The check may only append an idempotent
  visible notice and never blocks the chat, gates resume, requires
  acknowledgement, disables submission, or creates a persistent drifted
  state.
- **L10 Explicit full native reads.** Complete native imports occur only
  at genesis adoption and explicit manual reload, and reload imports
  exactly one native source: the current binding, through its tail. The
  prefix before the binding is preserved by frozen projection, never
  re-imported, and the replaced view is deleted in the cutover
  transaction. A chat whose current binding has no native source or
  whose integration has a null `nativeHistoryImport` has no Reload
  action.
- **L11 Fail closed, per chat.** A commit failure or unknown commit
  outcome fences the chat's ledger for writes; `SQLITE_CORRUPT` or any
  other ledger failure on open or query fences that chat with a typed
  error, and only that chat — per-chat databases make the fencing unit
  and the corruption blast radius the same boundary. There is no silent
  rebuild from native history or from any integration-private storage,
  and no retry protocol.
- **L12 Provider neutrality.** Core never branches on provider ID or
  parses provider formats; the one native import source is read by its
  owning integration. Translation, native parsing, probes, and fork
  mechanics stay behind `@garcon/server-agent-interface` under
  `server-agents/<id>/`. Capabilities are nullable facets, never
  optional methods or boolean flags.

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
order of the current view; the browser sequence is the ordinal. The
transcript protocol has exactly two identities — `transcriptViewId` and
`clientMessageId` — and zero tokens. Chat, native-session,
journal-operation, and durable ownership identities exist elsewhere in
the system and are not part of this protocol.

### 3.2 Batches

The atomic append unit is the batch: exactly one producer event or one
core-originated row group, committed as one SQLite transaction inside
the synchronous append call, with ordinals assigned by core. One
provider occurrence that expands into several rendered rows (an item
with tool call and result subrows, a message with several parts) is one
batch: it commits atomically or not at all. Batches carry no identity;
there is nothing to retry (L5).

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
| `notice` | core | yes |
| `permission-resolved` | core | specialized |
| `provider-row` | integration | yes |
| `session` | integration | no |
| `run-ended` | integration, or core (`origin: 'core'`) | turn state only |
| `permission-requested` | integration | specialized |
| `permission-cancelled` | integration | specialized |
| `permission-expired` (optional) | integration | specialized |

Kind semantics:

- `user-input`: appended when the input becomes outbound (7.1). `detail`
  records the `clientMessageId`, the attachment manifest, and whether
  the input was a steer (display styling).
- `notice`: durable advisory. The drift notice's message is "The
  transcript may have changed outside Garcon. Consider reloading from
  native history." and its rendering carries a Reload action. `detail`
  records the observed native watermark for idempotency.
- `provider-row`: one finalized normalized output row (assistant,
  thinking, every tool-use/result family, compaction summary, provider
  error, and every explicit provider-specific message type from
  `common/chat-types.ts`). Streaming deltas are overlay, never rows.
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

Display filtering is a client concern keyed on `kind`; the read folds
are specified in section 9.

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
  prefix it depends on does not. No other checkpoint is protocol.
- Paging is direct keyset paging on the `(view_id, ordinal)` primary
  key; there is no offset or sidecar index. The newest page is
  `SELECT ... WHERE view_id = ? ORDER BY ordinal DESC LIMIT ?`; older
  pages are
  `SELECT ... WHERE view_id = ? AND ordinal < ? ORDER BY ordinal DESC
  LIMIT ?`. The backward resend scan (7.2) walks the same key order.
- Submission idempotency is the `transcript_submission` partial unique
  index plus canonical payload comparison on conflict: an insert that
  conflicts re-reads the existing row; identical content returns it —
  and never re-dispatches — while different content is the typed
  conflict. There is no index rebuild at open.

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
- The durable ledger is paged from disk; in-memory transcript state uses
  the existing bounded chat cache and row-window eviction, and evicting
  memory never truncates the ledger — scrolling reloads older pages.

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
restart. `runId` is ephemeral correlation metadata on `run-ended` and
permission events only — never ledger identity, never present on content
or session events.

```ts
interface AgentIntegrationV5 {
  descriptor; settings; catalog; lifecycle; migration;   // unchanged
  execution: AgentExecutionV5;    // start/steer/abort + admission;
                                  // failures are plain errors;
                                  // start() returns an opaque handle
  nativeHistoryImport: AgentNativeHistoryImport | null;
                                  // bounded native -> rows; adoption and
                                  // manual reload; null = no Reload
  nativeSessions: codec;          // encode/decode session refs
  nativeActivity: AgentNativeActivityProbe | null;  // drift check (10.2)
  forking: AgentNativeForkV5 | null;  // native-fidelity fork (12.3)
  steering; goals;                // unchanged nullable facets
}

type ProducerEvent =
  | { type: 'rows'; rows: ProducedRow[] }
  | { type: 'session'; session: EstablishedSession }
  | { type: 'permission'; runId: string;
      lifecycle: PermissionLifecycle }
  | { type: 'run-ended'; runId: string;
      outcome: 'finished' | 'failed' | 'interrupted';
      error?: { code: string; message?: string } };

interface ProducedRow {
  readonly message: ChatMessage;
  readonly providerMeta?: JsonObject;
}
```

This is the entire provider surface for transcripts: translate what the
provider did into rows, in the order observed, and publish. No event
identity, no ordering obligations beyond observation order, no
durability obligations, no delivery claims, no capacity protocol.
Provider-level redelivery may be deduplicated at the adapter edge when a
real provider identity exists (Claude uuids, Codex item ids, OpenCode
part ids); otherwise a duplicate is an honest additional immutable
occurrence.

### 5.2 Acceptance semantics

`publish()` is the event's acceptance point, and acceptance is
durability:

- Validation is synchronous: closure state and event shape. An event
  offered to a closed sink rejects synchronously.
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
  plus the NORMAL power-loss window (4.3); the drift check surfaces
  newer native evidence where the provider persisted it, and manual
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

Run correlation is ordinary in-memory execution state — an ephemeral
`runId` held by the active execution, mandatory on `run-ended` and
permission lifecycle events and absent elsewhere:

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
- Session facts carry no `runId` and are never rejected as stale-run
  lifecycle: a session established just before an interrupt still
  commits when its callback arrives, preserving the native ref that
  resume, the drift probe, and reload depend on. The closed sink is the
  only fence on session facts.

Late content is appended normally: provider rows and session facts
received after an interruption or after another run began commit in
observed order, participate in rendering, search, preview, context, and
resend boundaries, and may interleave with output from a later run. That
is accepted. Late events cannot change processing state (the `runId`
rule) and cannot make an old permission actionable (section 8).

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
for agreement; the V4 registry write from the return path
(`server/agents/runtime-router.ts:182`) is removed. Startup fences
orphan provider processes (unchanged policy).

## 7. Inputs and Resend

### 7.1 The queue/transcript boundary

The guarantee is durable before provider dispatch, not durable at send:

- An **immediate input** (starting a turn now) is validated under the
  ownership and pending-ownership fences, appended, and committed before
  provider dispatch.
- A **steer** is appended and committed before delivery to the running
  provider is attempted. A steer initially sends only its own content;
  it is an ordinary prior `user-input` if a later turn performs the
  fold.
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

An immediate or dequeued dispatch is composed by one synchronous method
that commits the input row and computes the backward scan before
returning; no provider callback can interleave between insert and scan,
and dispatch consumes the returned immutable composition.

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

  if (
    row.kind === 'provider-row' ||
    row.kind === 'permission-requested' ||
    row.kind === 'run-ended'
  ) {
    break;
  }

  // Ignore notices, session metadata, and permission bookkeeping.
}
```

The current input appears exactly once, as the initializer. The scan
collects unanswered inputs back through any number of interruptions, and
stops at the first sign the agent visibly engaged: provider output, any
`permission-requested` row (resolution rows are ignored by the scan, so
the boundary is the request itself, not its lifecycle state), or a run
that ended without interruption — a visible finish or failure is the
user's cue to decide for themselves. Collected inputs and their
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
accepted. A crash with no stored provider output naturally leaves the
preceding user rows eligible for the next scan; a crash after provider
output may not. That loss is accepted (section 16).

### 7.3 Presentation

Turn state renders from `run-ended` rows and live execution state; after
a crash the transcript simply ends and the chat is idle. Rows the next
scan would collect carry a "will be sent with your next message"
affordance whose removal is composer state ("Don't resend"), never a
ledger write. Resend affordances never show while a run is active.

V4's pending-input settlement machinery (`settledInputRequests`,
`nativelyBoundInputRequests`, delivery-status tracking, stop-cohort
native-binding proof) is deleted.

## 8. Permission History

Permission lifecycle is durable ledger history, not a transient-only
channel. Integrations emit provider-originated `permission-requested`,
`permission-cancelled`, and `permission-expired` events — with a
mandatory ephemeral `runId` for actionability correlation — on the
ordered stream; core appends `permission-resolved` itself after
`respondToPermission()` succeeds, which removes callback-ordering
requirements from every integration. All permission lifecycle rows,
including late ones, remain durable observed history; a late fact can
never become actionable for a different or current run. The detail
contract is discriminated and typed:

```ts
type PermissionLifecycle =
  | { readonly kind: 'requested';
      readonly requestId: string;
      readonly incarnation: string;
      readonly tool: string;
      readonly input: JsonObject;
      readonly options: readonly PermissionOption[] }
  | { readonly kind: 'resolved';
      readonly requestId: string;
      readonly incarnation: string;
      readonly decision: PermissionDecision }
  | { readonly kind: 'cancelled';
      readonly requestId: string;
      readonly incarnation: string;
      readonly reason: string | null }
  | { readonly kind: 'expired';
      readonly requestId: string;
      readonly incarnation: string };
```

- The client renders permission rows with specialized presentation and
  action handling. After restart, historical permission rows remain
  visible but are not actionable: actionability is ephemeral and checks
  the current `serverInstanceId`, the current run (`runId`
  correlation), the request ID and incarnation, and unresolved lifecycle
  state (no resolution, cancellation, expiry, or `run-ended` after it).
  Restart clears the live state those checks require, so historical
  requests are naturally non-actionable without any durable attempt
  attribution.
- The response endpoint validates every fence before forwarding the
  decision to the provider; core appends `permission-resolved` only
  after the forward succeeds.
- Streaming partial permission UI remains ephemeral overlay; finalized
  lifecycle facts are durable.

## 9. Read Folds

Every read surface consumes the ledger through one explicit row-kind
matrix. "Conversational rows" below means `user-input` rows plus
`provider-row` rows, in ordinal order.

| Kind | Rendering | Search | Preview | Model context / carryover | Share snapshot | Export |
| --- | --- | --- | --- | --- | --- | --- |
| `user-input` | yes | yes | candidate | yes, excluding current-prompt rows | yes | yes |
| `provider-row` | yes | yes | candidate | yes | yes | yes |
| `notice` | yes | no | no | no | yes | yes |
| permission rows | specialized | no | no | no | specialized | yes |
| `session` | no | no | no | no | no | support export only |
| `run-ended` | turn state only | no | no | no | no | yes |

- **Rendering** shows conversational rows, notices, and specialized
  permission rows; turn state derives from `run-ended` rows and live
  execution state. Late content renders in observed order.
- **Search** indexes conversational content only, keyed
  `(chatId, transcriptViewId, ordinal)` with an appended-through
  watermark; normal appends index only the suffix; nothing is ever
  de-indexed within a live view. Commit notifications and view
  replacement enter the search worker in the same per-chat order, so
  deleting a replaced view's entries cannot be followed by a delayed
  old-view insert; the derived index may delete replaced views' entries,
  and query admission is current-view-qualified regardless.
- **Preview** selects the latest conversational row; notices and
  lifecycle state are separate UI signals, never preview text.
- **Model context and carryover** are the conversational fold, minus the
  rows composed into the current outgoing prompt (which appear exactly
  once, in the prompt). History is never excluded otherwise: a message
  the user declined to resend remains history and reaches stateless
  providers as context.
- **Shares are snapshot artifacts**: publishing a share copies its
  rendering fold into the share store (the existing product behavior —
  `server/routes/shares.ts`, `server/chats/share-store.ts`,
  `common/share-types.ts`); the share never reads the ledger again and
  is unaffected by reload or deletion of views. Share revocation policy
  is unchanged.
- **Export privacy**: ordinary user export includes durable rows but
  strips storage-private metadata — `providerMeta` and session rows'
  native refs/paths; a raw support export for explicit diagnostics may
  include everything. This is boundary hygiene, not protocol.

Because future queued inputs are not transcript rows, the ordinary
conversational fold is already correct for direct-provider context; no
turn-aware filtering exists.

## 10. Native Sessions and the Native Drift Check

### 10.1 Role of native history

Native history is provider execution state plus an explicit
manual-import source. Garcon binds it via the `session` row, imports it
only as the reload's single native source (or at genesis adoption), and
otherwise never reads it beyond the drift check's bounded tail.
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

The native drift check is a point-in-time comparison, not a watcher. It
probes only the chat's current binding and runs at exactly two moments,
per chat, while no run is active: when a chat is opened or loaded (the
first open after server startup is a special case), and immediately
before a native resume.

One strict rule, single mode:

> Notice when the native session's last conversation-relevant entry is
> strictly newer than the provider watermark for that session.

The provider watermark is the latest integration-emitted row for that
session: `provider-row`, `session`, provider-origin `run-ended`, and
integration-emitted permission rows. Core-authored rows — user inputs,
notices, `permission-resolved`, and core-origin `run-ended` — are
excluded: they do not prove native provider history was observed, and
they must not be able to hide missed native output behind the user's own
activity. Computing the watermark is a descending primary-key scan
bounded by `content_start_ordinal`, using a payload predicate (for
example `json_extract`) for `run-ended` origin; no normalized column or
index is added before measurement. Rows imported by reload carry native
timestamps and count toward the watermark, which keeps the check quiet
immediately after a reload. Under the probe obligation, a cleanly
finished run is quiet by construction; after a crash or interruption,
anything the provider persisted beyond the last integration-emitted row
is strictly newer and fires — which is the feature, since manual reload
is how the user adopts it.

On trigger, core appends the visible `notice` row with the Reload
action; a new notice appends only when the observed native watermark
advances past the last notice's recorded watermark, so repeated opens do
not re-warn. The check is advisory and permanently non-blocking: it
never blocks the chat, never gates resume, never requires
acknowledgement, never disables submission, and creates no persistent
drifted state. False negatives are accepted; an `unavailable` probe is
silent.

## 11. Manual Full Reload

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
2. Core closes the current view-bound sink (5.3).
3. Core creates a `staging` view row and inserts its rows
   transactionally from two sources: the frozen prefix — every row
   before the current binding's `content_start_ordinal`, carried through
   the frozen projection — and the single native import: the current
   binding, read by its owning integration's `nativeHistoryImport`
   through its current tail, excluding the binding's native
   seed/carryover context by seed receipt so the inherited prefix is not
   duplicated.
4. The frozen projection preserves conversational rows only
   (`user-input`, `provider-row`) with retained `clientMessageId`
   (covered by the staging view's submission unique index), plus exactly
   one carried row: the current-session `session` row (3.4), placed at
   the staging view's `content_start_ordinal`, so the reloaded view
   still knows its bound native session. All other sessions,
   `run-ended` rows, notices, and permission rows are not carried.
   Staged rows receive fresh dense ordinals; uniqueness and structure
   are enforced by the schema; no cross-view identity is promised.
5. Atomic cutover is one transaction in the same database: delete the
   old `current` view row — the foreign-key cascade removes its rows —
   then promote `staging` to `current`. The order satisfies the
   immediate one-current constraint, and a crash exposes a valid old or
   a valid new current view, never zero or two. A fresh database file
   per reload is deliberately not used: it would resurrect the
   pointer-file and directory-swap ceremony SQLite eliminated. Freed
   pages are reused by future appends; an optional best-effort `VACUUM`
   after cutover is housekeeping, not protocol.
6. Core issues a sink bound to the new view; the typed full-transcript
   replacement event is a core-to-client broadcast, not a sink
   publication.
7. Search deletes the replaced view's entries and indexes the new view,
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
lacks every Garcon-only row — notices, permission history, and inputs
the provider never received — and inputs that were composed into one
outgoing prompt reappear merged as one user message, because that is
what the provider received. The frozen prefix preserves exactly the
prior conversational rows and drops lifecycle rows. The replaced view is
deleted, and there is no undo. That lossiness is expected and is part of
why reload is manual and confirmed; shares published earlier are
unaffected because they are self-contained snapshots.

The product rule for history: external or crash-missed native activity
is adoptable only while its session is the current binding. Once
ownership moves on (handoff), the displayed prefix is frozen and final;
the drift notice at open and pre-resume is the built-in prompt to reload
before handing off.

Continuation, fork, and genesis adoption reuse the same frozen
projection: a continuation/fork target's ledger begins with the frozen
projection of the source's conversational fold at or below the captured
watermark — copied transactionally into the target chat's database —
and a pre-V5 adoption begins with the frozen projection of the complete
currently served composite (carryover and prior-agent history included),
followed in each case by a fresh binding. Adoption is lazy, at first
open: an existing current view means adopted; an empty new database is
initialized. Target-chat creation builds the target ledger completely
first and registers the chat last; startup removes unregistered target
directories after the registry loads. A native-fidelity fork that
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
5. Core advances `content_start_ordinal` past the watermark, issues the
   target's sink, and completes roll-forward; the chat's current native
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
the source's conversational fold at or below the watermark (section 11)
and a fresh binding, built completely before the target is registered.
The source chat and its native session remain fully usable; later source
rows never enter the target.

### 12.3 Fork

Identical watermark semantics at a user-chosen row instead of the tip.
Carryover fork is complete at cutover for every provider.
Native-fidelity fork is preserved only where it is already reliable,
currently Claude and Codex, through the nullable `forking` facet
consuming `providerMeta`.

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
  recover.
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
  provider-specific request format; lifecycle and output return through
  the same sink.
- `nativeHistoryImport` is null and there is no native source, so direct
  chats have no Reload action (L10); their permission and lifecycle
  history is never discarded by a pointless view rotation.

`DirectSessionStore` retires only after this path exists; no
direct-provider transcript read path or special serving authority
remains. `direct-anthropic-compatible` participates in every shared
suite alongside the other two direct integrations.

## 14. Per-Provider Notes

Each note states edge dedup, `providerMeta` use, and the probe's
relevant-entry definition under the 10.2 obligation.

- **Claude**: persist-before-notify append-only JSONL native format.
  Micro-compaction re-appends dedupe at translation by uuid; uuid is
  stamped into `providerMeta` for native-fidelity fork and import dedup.
  Probe: last conversation entry timestamp (creation-stamped, satisfying
  the obligation), excluding file-history snapshots, queue operations,
  and summary bookkeeping. Importer excludes carryover seed context by
  seed receipt.
- **Codex**: the live app-server stream is the display truth and does
  not match the rollout row-for-row; the rollout is resume state and the
  reload source for the current binding. Item ids dedupe redelivery at
  the edge; native-fidelity fork retained. Probe: last
  conversation-relevant rollout entry, excluding turn markers. Note the
  stateful Responses API can itself desync from the rollout across a
  crash — the same accepted risk class this design carries.
- **OpenCode**: part-id dedup at translation; provider errors emit as
  normal `provider-row`s; real-binary scripted tier retained. Probe:
  storage tail message timestamps.
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
  `nativeHistoryImport` null; probe `unavailable`; drift check inert; no
  Reload action.

## 15. Failure Semantics

| Window | Outcome |
| --- | --- |
| Crash before an input's acceptance commit | Input never existed; the client retries with the same `clientMessageId` and it appends once. |
| Crash after an input's commit, before dispatch | Accepted loss: a retry returns the existing row and never re-dispatches; the row shows the will-send-with-next-message affordance and the next fresh input's scan is the recovery path. |
| Crash with entries in the future-turn queue | Queue lost by design; no rows; resubmission is the user's explicit choice, idempotent by `clientMessageId`. |
| Commit failure during dequeue | The entry stays queued while the chat fences; dequeue is one synchronous block, so a retry observes exactly one identity. |
| Duplicate submission retry, same `clientMessageId`, identical content | Existing queue disposition or ledger row returned via the submission unique index; no second row; no re-dispatch. |
| Same `clientMessageId`, different content or attachments | Typed conflict; nothing appended. |
| Submission qualified by a stale view after reload | Rejected with the typed stale-view error; never deduplicated into the replacement view. |
| Dispatch failure (start or steer rejected/thrown) | Best-effort kill; core appends `run-ended: failed` with optional sanitized error detail for a turn-starting failure; preceding inputs remain eligible for the next scan only if no provider output or non-interrupted `run-ended` intervenes. |
| User interrupt | Run marked stopped in memory; `run-ended: interrupted` appended immediately; provider abort best-effort; the interruption row is transparent to the resend scan. |
| Interrupt when the run already ended | Idle no-op; nothing appended. |
| Duplicate or stale `run-ended` (stopped or unknown `runId`) | Ignored; never becomes a row; cannot stop the current run. |
| Late provider content or session fact from an ended run | Commits normally in observed order while the sink is open; may interleave with a later run's output; cannot change processing state or actionability. A late session fact preserves the native ref resume and reload depend on. |
| Crash mid-run | No `run-ended` row; restart synthesizes nothing; the transcript simply ends; preceding inputs remain scan-eligible only if no provider output intervened; accepted. |
| Runtime writes natively after its run ended | The drift check fires (strictly newer than the integration-emitted watermark); manual reload adopts it. |
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
| Crash at reload cutover | The one-transaction delete-then-promote exposes a valid old or valid new current view — never zero or two. |
| Requests against the deleted replaced view | Typed stale-view error, identical whether or not the rows still exist; shares are unaffected because they are snapshots. |
| Target-chat creation crash before registration | Unregistered target directory removed at startup; a native-fidelity fork may orphan a provider artifact — best-effort rollback, named accepted loss. |
| Crash-missed native output after genesis | Drift check compares against the integration-emitted watermark, so core-authored rows cannot mask it; notice with Reload; manual reload remediates while the binding is current. |
| Native session used externally while Garcon is idle | Expected, not a violation; the drift notice surfaces it; manual reload adopts it. |
| Chat deletion | Tombstone first; the ledger connection closes before the chat directory is removed. |

## 16. Consciously Accepted Losses

Every deliberate gap, in one place, so it is not "fixed" later:

1. A process crash loses events the provider emitted that core had not
   yet handled, and the tail of the interrupted run; the drift check
   detects it where native evidence exists, and manual reload recovers
   it; otherwise it is gone. This is the same loss window a provider's
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
4. Best-effort abort means old output can arrive after an interruption
   and interleave with a later run's output. Late content participates
   normally in rendering, search, preview, context, and resend
   boundaries — it can move them. None of these cases receives
   reconciliation.
5. Crashes create no inferred interruption row. A crash with no stored
   provider output leaves the preceding inputs eligible for the next
   resend scan; a crash after provider output may not. Accepted.
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
    `unavailable` probes are silent.
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

## 17. Testing Strategy

- **Store suite (core, once)**: transaction atomicity (a multi-row
  producer event commits all rows or none); submission unique-index
  behavior (retry returns the existing row and does not re-dispatch;
  content mismatch conflicts; staged preserved rows covered under the
  staging view); keyset paging (newest page and older pages by
  `(view_id, ordinal)`, ordinal density, cursor stability); the
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
  `run-ended` and permission events and absent on rows and session
  events; the prior run's rows and `run-ended` commit before the next
  queued turn starts; crash leaves no `run-ended` and restart
  synthesizes nothing; session as sole metadata writer with the
  registry cache repaired from the authoritative row at open; `start()`
  returns only an opaque handle; `run-ended: failed` carries the
  optional sanitized error detail through restart.
- **Resend scan**: pure ledger-function tests of the literal backward
  scan: the current input initializes the prompt exactly once;
  interruption `run-ended` rows are transparent; provider rows, any
  `permission-requested` row, and non-interrupted `run-ended` rows stop
  the scan; notices, sessions, and permission bookkeeping are ignored;
  steers send only themselves but are collected by later scans; dequeued
  entries run the scan; the insert-plus-scan method admits no
  interleaving; chip removal excludes for one composition only; restart
  recomputes the identical set; current-prompt rows excluded from
  context exactly once; imported histories ending in unanswered user
  rows are collected as intended.
- **Permissions**: typed lifecycle contract round-trip; core-authored
  `permission-resolved` appended only after a successful forward;
  integrations emit requested/cancelled/expired with mandatory `runId`
  and no ordering obligation; late lifecycle rows remain durable history
  and never become actionable; the actionability checks (server
  instance, current run, request ID, incarnation, unresolved state)
  reject stale and historical requests after restart.
- **Read folds**: the section 9 matrix as executable assertions per
  surface; search suffix-only within a live view, replaced-view entry
  deletion ordered with commits per chat, current-view query admission;
  preview selection; share snapshots copied at publish and unaffected by
  reload and view deletion; ordinary export stripping `providerMeta` and
  session native refs with the raw support export separate; direct
  providers receive resent inputs exactly once; late content
  participates normally in every fold.
- **Drift check**: fixture native files; the probe obligation per
  provider (reported timestamps never exceed core append times for
  observed entries); strictly-newer relevant entries fire and
  housekeeping entries do not; the integration-emitted watermark
  computed by the bounded descending scan with the payload predicate
  (core-authored inputs, notices, `permission-resolved`, and core-origin
  `run-ended` rows never raise it; imported rows count); quiet after
  cleanly finished runs and after reload; post-interrupt native
  persistence fires; current-binding-only probing; notice dedup by
  watermark; pre-resume timing; unavailable probes silent; non-blocking
  behavior on every surface.
- **Reload**: gated on a native-bound binding with a non-null
  `nativeHistoryImport` (direct chats expose no Reload); staged build
  under a `staging` view with schema-enforced uniqueness; the frozen
  projection (retained `clientMessageId`, lifecycle rows dropped except
  the one carried current-session row, no origin provenance); the
  single native import with seed-receipt exclusion; the
  delete-then-promote cutover with the replaced view gone and stale-view
  errors intact; search deletion-then-index ordering; queued entries
  blocking the flow; continuation/fork/adoption copying the projection
  into the target chat database transactionally, building fully before
  registration, with unregistered-directory startup cleanup and later
  source appends excluded; lazy adoption keyed on current-view
  existence.
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
  Claude/Codex only.
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
- Provider identity work: live-path `attachNativeMessageSource`
  stamping, `codex/message-source-identity.ts`, `pi-turn-settlement.ts`,
  the OpenCode error-identity binding, the Claude compaction identity
  binding (uuid moves to `providerMeta`).
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
  rows, producer batch identity, event dropping or closure bits, kill
  confirmation, byte budgets, ownership tokens, producer FIFOs or flush
  protocols, retained views, read-fencing during pending handoff, or
  closed-component native re-import — are rewritten against section 17,
  not weakened in place.

## 19. Implementation Plan

Nobody is deployed on V4; it exists only on this branch. There is no V4
production migration and no dual-format serving period. Released pre-V5
chats adopt lazily at first open by preserving the complete currently
served Garcon composite through the frozen projection (carryover and
prior-agent history included), with the active provider's history as the
current binding's native source; fallbacks remain the provider native
loader alone and then the empty ledger.

Phases; every commit remains buildable, and no provider's V4 path is
retired while core still depends on it:

1. **Core ledger, inactive.** `server/ledger/` store (per-chat
   `bun:sqlite` databases with the 4.2 schema, `user_version`
   migration, synchronous transaction append path, submission unique
   index, keyset paging, staging views and delete-then-promote cutover,
   LRU connection cache) plus the V5 contracts (capability sink,
   producer events with the finalized `runId` rules, `run-ended` with
   optional error detail, typed permissions, nullable
   `nativeHistoryImport`) in the interface package, unused. Store suite
   green.
2. **Producers, inactive.** All provider producers publishing through
   sinks, provider-originated permission lifecycle emission,
   direct-provider context derivation, native history importers with
   seed-receipt exclusion, exercised by fixture suites while V4 remains
   the live path.
3. **Coordinated cutover.** One coordinated core/provider/client change:
   core serves from the ledger, providers switch to sinks, the client
   switches to view-qualified addressing, `clientMessageId` submission
   idempotency, the resend scan with composer chips, durable permission
   rendering, and the durable-before-dispatch acceptance flow with the
   queue rules; lazy composite adoption activates. Scripted tiers and
   integration suites re-anchored in the same change series.
4. **Delete V4.** Remove the section 18 inventory and its tests; update
   the storage-boundary and architecture sections of both `AGENTS.md`
   and `CLAUDE.md`.
5. **Drift check and manual reload.** Probe facet with the stated
   obligation, notices with the integration-emitted watermark, staged
   reload with the delete-then-promote cutover, queue-empty
   preconditions and UI guidance, search deletion-and-index cutover,
   final validation sweep.

## 20. Resolved Decisions

1. The governing posture is simplicity over crash-perfect attribution or
   recovery: no producer identity, no retry protocol, no delivery
   evidence, no durable run attribution, no byte budgets; commit
   failures fence; crash loss is detected by the drift check and
   repaired by manual reload.
2. `publish()` commits synchronously: acceptance and durability are the
   same point; no ledger transaction spans an `await`; observed order is
   synchronous-call order on the event loop; broadcast follows commit
   through the per-chat server-event queue; there is no producer FIFO,
   no flush, no close-and-drain, and no publish/close race protocol;
   commit latency is rationale, never contract.
3. The sink is a capability object and the only producer fence: core
   closes it at handoff, reload, deletion, and shutdown; no
   `agentOwnershipToken` exists; the transcript protocol has exactly two
   identities — `transcriptViewId` and `clientMessageId` — and the
   durable ownership revision for handoff recovery lives in the
   registry/journal, never exposed through the sink.
4. Event correlation: `runId` is mandatory on `run-ended` and permission
   lifecycle events and absent from content rows and session facts; late
   provider content and session facts always commit while the sink is
   open; a duplicate or stale `run-ended` is ignored and never stored;
   session facts are ownership-scoped durable state fenced only by the
   sink.
5. Resend is the literal backward scan: initialize the prompt with the
   current input, collect preceding user inputs, skip interruption
   `run-ended` rows, stop at provider output, any `permission-requested`
   row, or any other `run-ended`; opt-out is ephemeral composer state; a
   steer sends only itself but is collected by later scans; the
   insert-plus-scan step is one synchronous method.
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
9. Submission idempotency uses the existing `clientMessageId` contract,
   scoped `(chatId, transcriptViewId, clientMessageId)` and enforced by
   the partial unique index; stale-view submissions are rejected with a
   typed error; `(transcriptViewId, ordinal)` is the canonical row
   address — there is no `rowUuid` and no origin provenance.
10. `execution.start()` returns an opaque handle; the session row is the
    sole source of session metadata.
11. Native history import (`nativeHistoryImport`) is a nullable facet
    serving both adoption and manual reload; chats without a native
    source have no Reload action; adoption is lazy at first open.
12. The native drift check probes only the current binding under the
    stated probe obligation and uses the integration-emitted watermark —
    core-authored inputs, notices, `permission-resolved`, and
    core-origin `run-ended` rows never raise it — computed by a bounded
    descending scan with a payload predicate; it is permanently
    non-blocking. Ownership is concurrent-exclusive: non-concurrent
    external use is the reload product case, not a violation.
13. Permission lifecycle is durable typed history: integrations emit
    requested/cancelled/expired with mandatory `runId`, core appends
    `permission-resolved` after a successful forward, all rows including
    late ones remain history, and actionability is ephemeral, checked
    against the current server instance, run, request ID, incarnation,
    and unresolved state.
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
17. Export privacy: ordinary user export strips `providerMeta` and
    session rows' native refs; a raw support export for explicit
    diagnostics is separate.
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
19. Carryover fork is complete at cutover for every provider;
    native-fidelity fork ships only where already reliable (Claude,
    Codex); target-chat creation builds the ledger fully and registers
    last, with unregistered-directory startup cleanup and fork-orphan
    provider artifacts as a named accepted loss.

Also resolved across revisions: store-what-you-showed with one core
ledger and view-wide ordinals; pre-V5 adoption preserving the served
composite through the frozen projection; and no V4 migration or
dual-serving period.
