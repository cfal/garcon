# Transcript Search Relational V8 and Bounded Physical Work

Status: implementation contract. This document replaces the persistent-FTS and
single-cursor proposal formerly identified by SHA-256
`81b5a2bbb1fd662df6c1abcc604ff674128717746e18c27c91d0d3418584f80a`.
That SHA and every earlier numeric frame pair are superseded.

The historical derivation freeze had SHA-256
`0a90b3b7f85fcb60370eb24092f966b885c0b59a8e4ebf7ef4886f003fda9d6f`.
It is provenance only: this checked-in document is the self-contained search
implementation contract, and `docs/transcript-ledger-v5-design.md` remains the
governing product design.

## Problem and decision

The measured incident is not hypothetical load. Indexing 25,000 synthetic
2.5-KiB rows through the real service took about 4.9 seconds initially and hit
the exact Worker timeout on identical same-chat replacement. Direct schema
timing was 5.8 seconds initially and 62.8 seconds on replacement. Secure-delete
replacement dominated the second pass.

An exact indexed-view/frontier no-op removes redundant rewrites but cannot bound
a fresh or mismatched large replacement. Persistent FTS5 also has an
irreducible hot-term merge quantum: `merge=N` checks its page budget only when
the term changes. Physical token namespaces bound that quantum only by adding
complex query expansion, prefix materialization, secure-delete reconstruction,
segment-state maintenance, and FTS shadow-table dependencies. Namespace
suffixes additionally route every exact term through FTS5 prefix setup, which
materializes a merged doclist before yielding.

Schema v8 therefore removes persistent FTS5. It stores the raw derived chunks
and a relational inverted index. A private in-memory FTS5 helper supplies the
exact approved SQLite `unicode61` token stream for one bounded input unit, then
is emptied. Persistent mutation can resume inside one document at a durable
BLOB term cursor. Queries use bounded relational posting slices and reproduce
the existing FTS5 matching and BM25 semantics.

This design preserves:

- SEARCH.02 cross-chat progress with a fixed indexer/reader Worker pair;
- SEARCH.03 rebuildable derived-state restart and deletion restoration;
- SEARCH.05 current-view/frontier-qualified health, including empty views;
- privacy-preserving secure deletion through physical WAL retirement;
- exact multilingual `unicode61 remove_diacritics 2` normalization;
- phrase, all-words, prefix, ranking, ordering, and snippet semantics.

## Load-bearing invariants

### One physical slot per chat

Each chat has one physical slot and one durable state tuple. No generation or
revision column exists. Safety comes from:

- `AUTOINCREMENT` chunk identities;
- one controller-owned same-chat tail;
- one outstanding physical mutation grant per chat;
- full-state and full-progress tuple compare-and-swap;
- one lifecycle epoch per Worker pair;
- cleanup tickets containing the exact expected state tuple.

Replacement reuses the slot only after bounded secure cleanup and the WAL
privacy barrier. Ordinary append retains the existing physical prefix.

### Active-complete is the searchable population

A chunk contributes to global statistics or results exactly when:

```sql
progress.complete = 1
AND state.status = 'indexed'
AND state.phase = 'idle'
AND state.transcript_view_id = chunks.transcript_view_id
AND chunks.ordinal <= state.processed_through
AND state.processed_through = state.target_through
```

Fully staged pending or failed residue is restart state, not searchable state.
Global `N`, average document length, and native-phrase document frequency use
active-complete over the whole index independently of the request allowlist.
Candidate, snippet, and body reads then intersect that population with the
exact allowed chat, view, and frontier.

`search_corpus_stats` equals the sum of slot counters only for globally
`indexed/idle` state rows. Entering pending subtracts a slot exactly once.
Term finalization and cleanup change only local slot counters. Activation is
the sole global-add boundary.

### Durable state is the transition proof

Mutation primitives never prove completion by rescanning a chat. They use the
exact state tuple, the exact progress tuple, and bounded address/cursor probes.
Activation and cleanup terminal transitions contain no corpus-sized aggregate.
This accepts the invariant that production writes establish the slot tuple;
arbitrary post-write storage corruption is handled by the derived-database
corruption fence rather than by an unbounded verification pass.

### Physical security includes WAL retirement

Commit is logical deletion, not physical retirement. A reader can pin deleted
raw text or terms in the main file until checkpoint. Replacement, explicit
deletion, and prune settlement therefore retain the cleanup promise and
same-chat tail through cooperative reader/indexer close and a verified
`wal_checkpoint(TRUNCATE)` with `busy=0`, `log=0`, `checkpointed=0`, and a
zero-byte WAL file.

## Frozen bounds

Production constants have one schema/protocol authority:

| Constant | Value | Meaning |
| --- | ---: | --- |
| `SEARCH_TERM_STEP_MAX_ROWS` (`K`) | 32 | Persistent term rows per build/delete transaction |
| `SEARCH_TERM_STEP_MAX_BYTES` | 524,288 | Aggregate selected term plus positions bytes |
| `SEARCH_RAW_STAGE_MAX_ROWS` | 16 | Raw rows per stage/delete transaction |
| `SEARCH_RAW_STAGE_MAX_BYTES` | 1,048,576 | Aggregate raw body bytes |
| `SEARCH_MAX_DIRTY_FRAMES` (`F`) | 49,829 | Reservation for one physical mutation |
| `SEARCH_WAL_HIGH_WATER_FRAMES` (`H`) | 199,316 | Four-reservation WAL high water |
| `SEARCH_INDEXER_CACHE_SIZE_PAGES` | 49,893 | Positive 4-KiB writer cache pages |
| `SEARCH_MAX_WAL_BYTES` | 821,181,952 | WAL header plus `H` complete frames |
| `SEARCH_INDEXER_MAX_STEP_RSS_DELTA_BYTES` | 268,435,456 | Isolated Worker RSS ceiling |
| `SEARCH_WORKER_MAX_ENVELOPE_BYTES` | 1,048,576 | Full JSON-envelope UTF-8 metric |
| start watchdog | 30,000 ms | Grant post to matching `step-started` |
| physical watchdog | 30,000 ms | `step-started` to physical completion |

CI installs Bun through the `canary` channel. The only accepted resolved
runtime is Bun 1.4.0 with SQLite 3.53.2 and exact FTS5 source ID
`fts5: 2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24`.
There is no second runtime matrix or compatibility fallback.

Tokenizer receiver limits per candidate raw prefix are independent:

- 16 documents;
- 64,000 UTF-16 code units per body;
- 65,536 native token occurrences;
- 65,536 distinct `(document, term)` rows;
- 1,048,576 aggregate normalized distinct-term bytes;
- 524,288 aggregate encoded-position bytes.

Query compilation permits at most 8,192 native tokens and 32 KiB aggregate
normalized occurrence-term bytes. One structured word is not assumed to be one
native token; `foo_bar` is the discriminator.

Each persistent reader slice is independently bounded to 256 SQL rows or point
probes, 512 KiB of term-plus-position bytes, 4,096 decoded-position comparisons
or aggregate updates, 16 body rows, and 1 MiB of body bytes. The reader's 256-row
slice cap is unrelated to persistent mutation `K=32`.

The transport metric is exactly:

```ts
Buffer.byteLength(JSON.stringify(fullEnvelope), 'utf8')
```

It includes all type, identity, payload, escaping, and array/object overhead.
Sender and receiver apply the same deterministic metric. Delivery is
acknowledgement-driven; an input or output continuation is never posted before
the previous exact acknowledgement.

## Schema v8

`schema-database.ts:createSchema()` is the executable DDL authority;
`schema.ts` is its stable public facade. The physical shape is fixed:

- `search_chat_state` is `WITHOUT ROWID, STRICT`, keyed by `chat_id`, with
  `transcript_view_id`, `status`, `phase`, `target_through`,
  `processed_through`, nullable `active_chunk_id`, local slot document/token
  counters, nullable bounded error code, and update time.
- `search_chunks` is `STRICT`, uses `INTEGER PRIMARY KEY AUTOINCREMENT`, stores
  chat/view/ordinal address, role, normalized nullable timestamp, raw body and
  byte length, and immutable native token/term/position totals. Its unique
  address index is `(chat_id, transcript_view_id, ordinal)`.
- `search_chunk_progress` is `STRICT`, keyed by `chunk_id`, with `complete`,
  persisted term/occurrence/byte totals, and the nullable greatest-term BLOB
  cursor. `search_chunk_progress_complete` is a partial index for complete rows.
- `search_chunk_terms` is `WITHOUT ROWID, STRICT`, keyed by
  `(chunk_id, term)`, with a denormalized `chat_id`, frequency, and canonical
  positions BLOB. `search_chunk_terms_by_term(term, chat_id, chunk_id)` supports
  global term drivers.
- `search_corpus_stats` is a singleton `WITHOUT ROWID, STRICT` table containing
  active document count and total token count.
- `search_index_metadata` is a singleton `WITHOUT ROWID, STRICT` table containing
  the 32-byte tokenizer semantic fingerprint.

The denormalized posting `chat_id` is index-order data only. It is inserted by
`INSERT ... SELECT` from the authoritative chunk. Query qualification always
joins through `search_chunks.chat_id`; a copied-chat mismatch is corruption and
never result authority. The record-layout freeze intentionally adds no
composite unique key or foreign key because that would invalidate `F/H`.

`token_count` is the native body occurrence count plus one. The added unit
preserves the old zero-weight `chat_scope` token's document-length and average-
length effect without a physical pad posting. A body such as `_` may therefore
have `token_count=1`, zero postings, and still be a valid complete document.

### Creation and open order

A fresh file follows this exact order:

1. Remove the derived main file and both sidecars.
2. Open a new database.
3. Set `page_size=4096` and `auto_vacuum=NONE` before journal mode, transaction,
   metadata, or any schema object.
4. Read both back and require `4096` and numeric zero.
5. Set and verify WAL, `synchronous=NORMAL`, `foreign_keys=ON`,
   `secure_delete=ON`, `wal_autocheckpoint=0`, `cache_spill=OFF`, and positive
   `cache_size=49,893`.
6. Create all objects and metadata under `BEGIN IMMEDIATE`, set
   `PRAGMA user_version=8`, and commit.
7. Read back version, page size, auto-vacuum, and fingerprint before admission.

Ordinary writer open validates layout, version, and fingerprint before and
after applying connection-local pragmas. Wrong/missing version, malformed
schema, or missing/mismatched fingerprint closes every handle, removes the
main/WAL/SHM files, and recreates. Same fingerprint resumes pending state.
The tokenizer runtime is approved before database admission; an unapproved
exact FTS5 source refuses enable and does not enter a recreate loop.

The persistent reader opens the main file with Bun `readonly: true`, validates
layout/version/fingerprint, sets and verifies `temp_store=MEMORY`, and does not
set `query_only`. This permits the connection-local indexed TEMP allowlist
while keeping main-schema writes physically rejected.

## Private tokenizer contract

Each indexer and reader Worker owns one private `Database(':memory:')` with:

```sql
PRAGMA journal_mode=MEMORY;
PRAGMA temp_store=MEMORY;
PRAGMA cache_spill=OFF;
CREATE VIRTUAL TABLE tokenizer_fts USING fts5(
  body,
  content='',
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE tokenizer_vocab USING fts5vocab(tokenizer_fts, instance);
```

The helper disables automerge, raises crisis merge, and uses an 8-MiB hashsize,
which stays inside the reserved non-page-cache headroom. It asserts every
`database_list` path is empty, requires the sole exact FTS5 source ID, checks
the multilingual sentinel `Crème 東京 foo_bar 한글`, and derives the durable
32-byte fingerprint from source ID, tokenizer spec, sentinel tuples, query
compiler version, and posting encoding version.

Vocab rows are streamed through an iterator without SQL `ORDER BY`; an
`ORDER BY` on `fts5vocab(instance)` creates a TEMP B-tree. Caps are checked at
cap plus one while streaming, before excess output is retained. Canonical BLOB
keys are sorted in JavaScript only after the bounded stream is aggregated.

Document batching intentionally performs at most one insert/vocab/delete-all
cycle per offered document, at most 16 cycles. Natural vocab order is
term-major; the per-document cycle preserves exact input-order receiver-prefix
selection without a SQL sort. Remaining aggregate limits are passed into every
cycle, so total consumed instances are bounded by the aggregate cap plus the
one rejected successor. Every success or rejection executes `delete-all`,
proves vocab and `_idx` empty, reasserts no-disk state, and closes/recreates the
helper after exceptional cleanup.

Query tokenization returns byte-exact BLOB terms and native positions without
crossing a Worker boundary. Build tokenization returns byte-sorted terms,
frequency, canonical position BLOBs, document totals, and the pad-inclusive
token count.

## Posting representation and integrity boundary

For strictly increasing zero-based native positions `p[0..n)`, encoding starts
with `previous=-1` and writes the shortest-form unsigned LEB128 of
`p[i]-previous`. Every delta is positive. Decoding rejects zero deltas,
redundant high-zero groups, truncation, overflow, trailing bytes,
non-increasing positions, decoded-count mismatch, and positions outside
`[0, token_count-1)`.

Final bounded insertion is the sole completeness proof. For every selected
fresh posting, the indexer canonical-encodes and round-trips before DML. The
transaction inserts no more than 32 postings and 512 KiB, then atomically
advances:

- persisted term count;
- persisted occurrence count;
- persisted term bytes;
- persisted position bytes;
- greatest-term cursor.

On the final insertion, the same transaction requires every persisted total to
equal the immutable chunk total, occurrence count to equal `token_count-1`,
the durable greatest row to equal the cursor and expected posting, and no
persisted successor. It marks the chunk complete, increments local slot
counters, advances `processed_through`, and selects the next staged chunk.
Zero-term finalization performs the equivalent empty greatest/no-term probes.
There is no verification cursor, digest, second scan, or verification phase.

Two integrity locks remain deliberately distinct:

- Production-write tail/completeness faults use bounded greatest-row,
  cursor-equality, counter-equality, successor, and empty probes before
  activation.
- Reader-time corruption fully canonical-decodes every consumed posting and
  fails content-free into whole-derived-database recreation.

Accepted residual: a different but canonical same-frequency, same-byte-length,
in-range positions BLOB can alter only within-document phrase adjacency for
that term/chunk. Detecting arbitrary earlier canonical tamper before activation
would require a digest or second persisted verification machine, both rejected.
It cannot cross authoritative chats or affect `N`, average length, document
length, or term-presence phrase document frequency.

Durable cursor/greatest/successor disagreement, durable-total disagreement,
unexpected durable terms, and malformed stored cleanup postings are
`SEARCH_INDEX_CORRUPT`, not content rejection. Fresh in-memory posting
canonicalization remains `SEARCH_POSTING_INVALID`.

## State machine

Statuses and phases are orthogonal:

```text
status: pending | indexed | failed
phase:  idle | append-build | replacement-cleanup |
        replacement-checkpoint | replacement-build | removal-cleanup
```

`indexed` requires `idle`, exact processed/target equality, null active chunk,
and null error. `pending` requires a non-idle phase and null error. `failed` is
permitted only for append/replacement build with a bounded error.
`replacement-checkpoint` requires null active chunk and zero slot counters.

| Input/state | Atomic effect | Result |
| --- | --- | --- |
| Absent replacement | Insert pending replacement-build with zero progress and slot counters | build continuation |
| Indexed/idle, same view, both durable frontiers cover request | No transaction and zero DML | terminal current |
| Indexed/idle, same view, higher request | Subtract global slot once; retain prefix; enter append-build | build continuation |
| Indexed/idle, mismatched view | Subtract global slot once; install target; retain old physical rows; enter replacement-cleanup | cleanup continuation |
| Exact pending/failed replan | Resume tuple; an exact failed build clears its bounded error once | current phase continuation |
| Raw stage | Insert receiver-selected prefix of at most 16 incomplete chunks; publish first active ID | build continuation |
| Term step | Insert at most 32 postings/512 KiB; advance one cursor | build continuation |
| Final/zero-term step | Prove totals/tail, complete row, update slot/frontier, atomically select next active chunk | build continuation |
| Non-searchable frontier | With no next staged chunk, advance only the proved raw frontier | build continuation |
| Activation | Add whole slot counters to singleton and flip indexed/idle in exactly two updates | terminal indexed |
| First cleanup term step | Mark complete row incomplete, decrement local slot once, delete high 32-term/512-KiB prefix | cleanup continuation |
| Later cleanup term step | Delete high bounded prefix and move cursor | cleanup continuation |
| Raw cleanup | Require zero totals/null cursor/`NOT EXISTS` terms; delete at most 16 rows/1 MiB; atomically select next cleanup chunk | cleanup continuation |
| Replacement cleanup end | Require null active ID and zero slot counters; enter replacement-checkpoint | terminal secure barrier |
| Post-barrier replacement | CAS checkpoint tuple to replacement-build | build continuation |
| Removal cleanup end | Delete zero-contribution state | terminal secure barrier |
| Prune page | Mark at most 16 absent chats, aggregate active counts, update singleton exactly once, return exact cleanup tickets | page continuation/terminal |

The covered-current rule applies in both the lock-free fast path and the
transactional recheck. A lower same-view request cannot authorize cleanup in an
append-only ledger. Mismatched-view and non-covering requests still repair.

## Bounded mutation SQL

Every mutating primitive performs all semantic selection and cap validation
before `BEGIN IMMEDIATE` where possible. Inside the transaction it re-reads and
compares the full state tuple and, when present, the full progress tuple. A
mismatch returns a discriminated superseded result with zero DML.

Address navigation uses existing indexes only:

- first physical slot row seeks `(chat_id, transcript_view_id, ordinal)` ordered
  by view and ordinal with `LIMIT 1`;
- the next build row seeks the exact chat/view prefix and `ordinal > ?` with
  `LIMIT 1`;
- raw cleanup seeks the exact chat/view prefix from the active ordinal and
  reads at most 16 rows;
- term absence is a primary-key `EXISTS ... LIMIT 1` probe;
- durable greatest and successor checks use `(chunk_id, term)` reverse/forward
  seeks with `LIMIT 1`.

No mutation primitive uses a chat-wide `count`, aggregate, offset, temp sort,
or `ORDER BY id`. Activation is exactly the singleton update plus state update.
Cleanup terminal checks use the null active cursor, zero counters, and one
indexed first-row probe. Prune performs at most 16 state updates plus exactly
one aggregated old/new corpus-statistics update.

## Worker protocol

All envelopes are exact-key validated and carry explicit identities:

```ts
type RequestIdentity = { requestId: number; lifecycleEpoch: string };
type PhysicalGrantIdentity = RequestIdentity & { grantId: number };
type WalObservation = {
  walEpoch: number;
  walObservationSequence: number;
  logFrames: number;
  checkpointedFrames: number;
};
```

Indexer requests are `open`, `physical-step-grant`, `checkpoint` with fixed
`TRUNCATE`, and `indexer-quiesce`. A physical step is one plan, raw stage, term
build, frontier, activation, removal start, cleanup, replacement-checkpoint
completion, conditional failure record, or bounded prune page.

Indexer events are `opened`, `step-started`, `physical-step-complete`,
`checkpoint-complete`, `indexer-quiesced`, and `error`. `step-started` is posted
before tokenizer/helper/JavaScript work, writer NOOP, or persistent DML.
Physical results explicitly distinguish `completion: 'continue' | 'terminal'`.
Replacement-checkpoint and chat-deleted terminal results require the secure
barrier before high-level settlement.

Only indexer `error` may carry optional `wal`. Reader error is unchanged. An
invalid optional WAL invalidates the entire event.

Two shared closed predicates have different authority:

- `isIndexerWalAuthoritativeErrorCode()` identifies deterministic pre-BEGIN or
  synchronously rolled-back outcomes that may carry a post-error NOOP and
  release their exact reservation. It includes `SEARCH_INDEX_CORRUPT` and
  `SEARCH_WAL_MAINTENANCE_REQUIRED` but excludes SQLite, COMMIT/ROLLBACK,
  post-message, internal, unavailable, and grant-conflict failures.
- `isIndexerRecordableBuildErrorCode()` identifies only
  `SEARCH_TOKENIZER_INVALID`, `SEARCH_TOKENIZER_LIMIT`, and fresh
  `SEARCH_POSTING_INVALID`. Only these may schedule conditional `mark-failed`.

WAL presence never implies known outcome or chat-recordability. A structurally
valid internal/unavailable/SQLite error with attached WAL is an invalid event.
`SEARCH_INDEX_CORRUPT` releases a known reservation, fences dispatch, and
requires cooperative whole-derived-database recreation; it never marks one chat
failed.

Reader requests are `open`, `search-start`, acknowledgement-driven
`search-allowlist-chunk`, `reader-step-grant`, and `reader-quiesce`. Reader
events acknowledge input, complete exactly one slice, quiesce, or report a
content-free error. Result chunks are acknowledgement-driven and final status
appears only on the terminal chunk.

## Scheduling and cooperative retirement

The service owns two logical mutation permits, a live FIFO, and a lower-priority
cleanup lane. Live work normally wins, but one waiting cleanup unit is admitted
after at most eight consecutive live admissions. A logical job is returned to
the dispatcher tail after every physical continuation. Later jobs remain
unposted, untimed, and unreserved.

Exactly one indexer physical grant exists at a time. The start watchdog begins
after `postMessage()` returns and stops only on matching `step-started`, Worker
error/actual close, or retirement. The physical deadline begins at
`step-started`, not while another logical permit waits. Missing start or
physical completion never authorizes `terminate()` plus replacement.

Maintenance fences grants and overtakes every ungranted ordinary continuation.
Reader quiesce fences new searches, cancels queued work, causes the active slice
to yield and `ROLLBACK`, finalizes statements/helper state, closes the
persistent connection, acknowledges, and exits with `process.exit(0)`. Indexer
quiesce waits for the granted bounded transaction to complete or roll back,
closes tokenizer/database state, acknowledges, and exits the same way. Bun
WorkerGlobalScope has no working `self.close()` contract for this purpose.

The parent requires both quiesce acknowledgement and the actual Worker `close`
event. `Worker.terminate()` is not SQLite transaction, snapshot, or privacy
evidence. If native SQLite never returns, search stays fenced until process
restart.

## WAL reservation and maintenance

Automatic checkpoints are disabled. Ordinary observation is
`PRAGMA wal_checkpoint(NOOP)` only; `PASSIVE` is forbidden because it may copy
the accumulated backlog into an ordinary content request.

The sole writer performs an authoritative NOOP immediately before
`BEGIN IMMEDIATE` and requires:

```text
actualLogFrames + F <= H
actualLogFrames - actualCheckpointedFrames + F <= H
```

The parent independently admits a grant only when:

```text
observedLogFrames + R + F <= H
observedBacklogFrames + R + F <= H
```

`R` is the sum of reservations for posted grants. One physical indexer means
`R` is normally zero or `F`; the second logical permit reserves nothing until
posted. This prevents double-counting and preserves A-held/B-progress.

Every known physical outcome, including zero-DML, superseded, and deterministic
error, attempts a post-step NOOP and increments
`walObservationSequence`. On event receipt the parent atomically:

1. accepts WAL metrics only if `(walEpoch, sequence)` is newer;
2. removes that exact grant's reservation regardless of observation age;
3. fences later grants if metrics are missing.

An older observation never regresses parent state. An unknown completion keeps
its reservation and enters cooperative unknown-outcome retirement. Reservations
are reset only after actual old-Worker close and verified startup TRUNCATE.

When authoritative capacity leaves insufficient room for another reservation,
the service schedules maintenance before ordinary admission deadlocks. It
quiesces both Workers, runs maintenance-only TRUNCATE on a fresh indexer, checks
the exact zero result and zero-byte WAL, increments `walEpoch`, and reopens
reader/write admission. A crash can leave at most one bounded granted unit past
the last observation; startup checkpoints before any reader or writer admission.

## Query semantics

Query compilation completes through the private helper before the persistent
reader opens `BEGIN`. A public phrase joins all structured words and tokenizes
them as one exact native phrase. Each all-words structured token becomes one
mandatory native phrase; the public prefix flag applies only to that phrase's
final native token. Every public clause is mandatory at chat level.

Inside one persistent snapshot, the reader performs health, global phrase-df,
ranking, snippet identity, and body reads. It first streams the request allowlist
into an indexed connection-local TEMP relation. Global population calculations
remain independent of that TEMP relation.

Exact phrases use one fixed-term `(term, chat_id, chunk_id)` driver and bounded
`(chunk_id, term)` point probes for remaining terms/positions. Evaluation is
chat/document-major: one allowed chat and chunk at a time, one chat accumulator,
and a globally bounded sorted top-100 accumulator. A document clause score is the sum of its mandatory
native-phrase BM25 scores; a chat score sums each public clause's best document.

Prefix evaluation uses bounded chunk-major ranges on `(chunk_id, term)`. It has
the same corpus-sized worst case as the accepted current prefix class but is an
active-corpus-proportional sparse/no-match regression from FTS5's
match-proportional term range. Cancellation and bounded memory remain strict.
`(term, chunk_id)` is prefix-contiguous but term-major, so document grouping
would require an unbounded chunk map/sort or one iterator per matching term;
chunk-major probing trades that state for one bounded probe per active-complete
chunk.

BM25 exactly uses SQLite's fixed `k1=1.2`, `b=0.75`,
`max(log((N-df+0.5)/(df+0.5)), 1e-6)`, body frequency, and pad-inclusive
document length. Rank/match reference fixtures cover ASCII, `foo_bar`,
diacritics, Hangul, CJK, exact, prefix, phrase, AND, and multi-clause cases.

Health retains covering semantics. Same-view indexed/idle state is indexed when
its processed frontier covers the allowlist frontier; candidate rows remain
capped at the allowlist frontier. Same-view failed is failed. Absent, pending,
mismatched-view, or lagging state is pending. `unsupportedChatCount` remains
zero.

## Prune and reintroduction ordering

Prune closes service write admission and drains prior writes before taking the
catalog snapshot. It marks intent in exclusive pages of at most 16 states. Only
physical cleanup yields across chats.

Before admission reopens, the controller invalidates the indexed-view cache and
registers every exact cleanup ticket on the corresponding same-chat tail. The
scheduled tasks may remain behind the closed gate. Present-chat reconciliation
awaits full sync and still submits the old ticket. A successful rebuild makes
the ticket's first full-tuple cleanup CAS return `mutation-superseded`; a failed
rebuild throws before cleanup can touch the live catalog chat. This closes the
catalog-event-before-cleanup-enqueue and cleanup/reintroduction ABA gaps without
a generation column.

## Failure and restart policy

Known fresh build failure can conditionally record one bounded error only when
the exact expected state tuple still matches. Failed append/replacement build is
invisible to active-complete reads and resumes from the durable cursor when the
exact plan is retried. Failure recording never masks the original error.

State/control/WAL/configuration/cleanup/identifier/view/gap/raw-stage errors are
not chat-recordable. Derived posting or query corruption emits no result,
releases a known reservation only when authoritative WAL is present, fences the
service, cooperatively retires both Workers, removes and recreates the complete
derived database, checkpoints before admission, and rebuilds from authoritative
ledger views.

Acknowledgement loss is resolved by durable replanning. A replay either sees
the committed cursor/completion or returns a zero-DML supersession/current
result. Restart never infers a phase from physical rows; the explicit status,
phase, target, processed frontier, active chunk, slot counters, and progress
cursor are sufficient.

## Source-derived frame and memory proof

SQLite source constants are `P=4096`, maximum reserved header byte
`RsvMax=255`, usable overflow payload `U=3837`, B-tree depth `D=20`, and
neighbor bound `NB=3`:

```text
Qinsert = 1 + D*(1 + NB + (NB+2)) = 181
Qdelete = 1 + 2*D*(1 + NB + (NB+2)) = 361
Qupdate = Qinsert + Qdelete = 542
overflow(n, bytes) = n + ceil(bytes/U)
frames(X) = 1 + 2X
```

`Qdelete` includes both balance walks allowed by `sqlite3BtreeDelete`.
`frames` includes the database header and a conservative freelist-trunk page
for each structural/overflow page under `auto_vacuum=NONE`.

SQLite 3.53.2 builds a replacement cell before clearing the old cell.
Every logical update therefore accounts for simultaneous old and new payload
records. The exact payload-record multiplicities are:

| Step | Records passed to overflow accounting |
| --- | ---: |
| Non-final term build | `2K+2` |
| Final term build, including old/new state and complete-index insert | `2K+5` |
| First complete cleanup, including old/new state and complete-index delete | `2K+5` |
| Later cleanup | `2K+2` |
| Zero-term finalization | 5 |
| Raw stage | `3R+4` |
| Raw deletion | `3R+2` |
| Activation/indexed-to-pending | 4 |
| Prune-16 | 34 |
| Frontier/failure | 2 |
| State removal | 1 |

The dominant formulas contain both old and new cursor payloads (`2C`). At
`K=32`, `R=16`, `T=524,256`, `V=32`, `C=32,768`, `I=256`, and `U=3,837`, the
accepted record residuals are:

```text
rhoTermBuild=2,694       rhoTermDelete=2,698
rhoRawStage=23,398       rhoRawDelete=23,354
rhoActivation=1,321      rhoPending=1,316
rhoPrune=20,504          rhoFrontier=1,374
rhoStateDelete=645
```

The non-null widest legal new `active_chunk_id` is included in final term
insertion, zero-term finalization, and raw-delete-next. Exact class bounds are:

| Physical class | Frames |
| --- | ---: |
| Non-final 32-term continuation | 24,975 |
| Final 32-term continuation, including next active chunk | 26,429 |
| First-complete 32-term cleanup with remainder | 49,829 |
| Later 32-term cleanup | 48,015 |
| Zero-term finalization, including next active chunk | 2,543 |
| 16-row/1-MiB raw stage | 20,209 |
| 16-row/1-MiB raw deletion, including next active chunk | 36,401 |
| Activation | 2,179 |
| Indexed-to-pending | 2,179 |
| Prune-16 | 18,509 |
| Frontier/failure CAS | 1,091 |
| Zero-contribution state removal | 727 |
| Current/superseded/pre-BEGIN rejection | 0 |

Thus `F=49,829`, `H=4F=199,316`, `cache_size=F+64=49,893`, and maximum WAL
bytes are `32 + H*(24+4096) = 821,181,952`. Positive cache pages retain dirty
pages with `cache_spill=OFF`; no spill fallback is allowed.

The checked-in sole-runtime proof calls the production DDL and mutation
primitives. Its 80/80 matrix cases cover 16 physical operations across empty,
mature ascending/interleaved/descending, and deliberately fragmented layouts,
including unequal 32,767/32,768-byte cursor replacement, cleanup remainder,
and final/zero/raw-delete next-active cases. Maximum observed mutation cost was
304 WAL frames. Its 18/18 isolated RSS profiles cover six dominant operations
across three layouts; maximum RSS delta was 9,367,552 bytes and maximum HWM
delta was 8,892,416 bytes. The exact `H=199,316` construction produced an
821,181,952-byte WAL, completed TRUNCATE in 4,574.374 ms, and left a zero-byte
WAL. `scripts/transcript-search-v8-runtime-proof.ts` has SHA-256
`d2f95ea4a44f95445aafa8416587234668cc4985fb5b2e9b97a20d23f86976aa`;
the production schema SQL has SHA-256
`f145dd5094386f487d77762af6dd1417c3643a01214239009a0f88d40ee74797`.

Any DDL, production SQL, cap, pragma, supported source ID, or SQLite version
change invalidates the numeric authority and reruns the record-layout, VDBE,
frame, RSS, and full-`H` matrix.

## Deterministic verification

Required checked-in locks:

- ordered creation/readback, wrong-version/fingerprint recreation,
  same-fingerprint resume, unapproved-source refusal, no-disk tokenizer state;
- exact and cap-plus-one rejection for term rows/bytes, raw rows/bytes,
  identifiers, timestamps, query native output, and full envelopes before
  persistent `BEGIN`, with zero WAL and unchanged tuple;
- active-complete population, activation-only singleton updates, globally
  active-disallowed rank influence, and pending-residue invisibility;
- canonical posting encoding, per-chunk occurrence sum, cursor restart,
  zero-term finalization, greatest/successor tail corruption, cleanup stored
  corruption, and whole-derived-database reader corruption recreation;
- final-term-next, zero-term-next, and raw-delete-next visibility through a
  second connection;
- mature-slot planner shapes with no temp sort, `Rewind`, offset, or full scan;
- one physical/two logical permit scheduling, A-held/B-progress, same-chat
  order, finite cleanup weight, maintenance priority, and both watchdogs;
- WAL observation ordering, stale metrics, exact reservation removal, missing
  metrics fence, known versus unknown errors, recordable versus corruption
  errors, and capacity-triggered maintenance;
- reader compile-before-BEGIN, one snapshot, every slice cap, hot-position
  continuation, prefix no-match cost, cancellation, and close-before-checkpoint;
- held-reader secure deletion for replacement/removal/prune and crash-before-
  barrier startup, proving synthetic raw/term markers absent before settlement;
- production-coupled sole-runtime VDBE/frame/RSS/full-`H` proof.

All fixtures use deterministic generic content and synthetic identities. No
real transcript content enters tests or proof artifacts.

## Module ownership

- `schema-database.ts`: exact DDL/open identity, shared state/progress tuple
  readers, bounded indexed navigation, WAL NOOP/capacity, and TRUNCATE.
- `schema-mutations.ts`: tuple-CAS plans, raw/term/frontier/activation work,
  slot/corpus accounting, cleanup, failure recording, and prune pages.
- `schema.ts`: stable public re-export boundary for both schema modules.
- `tokenizer.ts`: private no-disk `unicode61` helper, source/sentinel approval,
  fingerprint, query tokens, canonical postings, and decoder.
- `worker-protocol.ts`: bounds, identities, exact envelopes, continuation and
  secure-barrier semantics, WAL validation, and both failure predicates.
- `indexer-jobs.ts` / `indexer-main.ts`: one parent-granted physical step,
  start/completion/error observation, checkpoint verification, and cooperative
  close.
- `query-contract.ts`: compile-before-snapshot query preparation, TEMP
  allowlist ownership, slice caps/results, and corruption signaling.
- `query.ts` / `reader-main.ts`: active-complete relational evaluation,
  bounded reader slices, result streaming, and quiesce.
- `transcript-search-service-contract.ts`: service inputs plus deterministic
  Worker error, grant, and physical-result interpretation.
- `transcript-search-service.ts` / `worker-supervisor.ts`: logical permits,
  weighted dispatch, grant watchdogs, WAL reservations, maintenance, secure
  settlement, corruption recreation, and Worker lifecycle.
- controller: authoritative ledger frontier, only same-chat tail, indexed-view
  cache, prune snapshot/ticket registration, and reintroduction ordering.

No provider facet changes. No SACS module is added; existing SACS remains
upstream ledger evidence. CTS SEARCH.06 through SEARCH.10 and the flat inventory
own the provider-neutral v8 evidence before the coordinator commit.

## Rollout and rollback

Schema v8 recreates v7 derived data and rebuilds from current authoritative
ledger views. There is no in-place migration, dual read, or feature-specific
fallback. Search admission remains closed until startup TRUNCATE, tokenizer
identity, schema identity, and both Worker opens succeed.

Rollback means shipping the prior server/client pair and rebuilding its derived
search database. No ledger or provider history is changed by v8, so no
authoritative transcript rollback exists.
