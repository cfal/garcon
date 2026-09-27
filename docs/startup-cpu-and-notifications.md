# Startup CPU and Notifications

## Diagnosis

Commit `c36fd05d3` reused the executor-reconnect handler during initial startup.
Local was already ready, so startup drained every registered chat's empty queue.
Each empty drain emitted `chat-idle`; Telegram's attention tracker then loaded
the entire ledger before checking whether notifications were enabled. Unnamed
chats were read twice. This affects every provider, not only Direct.

An isolated server with 32 cached chats and search disabled performed 64 full
ledger reads and no native adoptions. Removing the initial drains eliminated all
those reads. The affected startup phase fell from 1,164 ms to 6 ms. Separate
read-only sampling confirmed SQLite reads and JSON decoding dominate the work.

Search backfill explains the later paired adoption/indexing warnings. It imports
only chats without a current ledger view. Initial readiness also caused failed
adoptions to retry immediately without a real availability change. Missing
native history must remain an explicit failure, not an empty successful view.

## Changes

1. Separate initial ownership cleanup from actual executor readiness transitions.
   Startup must not drain empty queues or synthesize search-recovery events.
   Genuine reconnects must still wake pending user and control inputs. Observe
   availability before search backfill so transitions during startup are not lost.
2. Remove Telegram's history-reader dependency. Use committed input/assistant
   events, terminal results, permission events, and cached chat metadata. Retain
   only bounded excerpts in process-local notification state. Check notification
   settings before formatting or sending. Idle without a real outcome is not a
   completion. Preserve permission deduplication, acknowledged stops, and queued
   turn coalescing; clear context on consumption, stop, deletion, and view changes.
   Missing context produces a shorter notification, never a history read or replay.
3. Make metadata initialization cache-only. Repair missing/stale previews after
   readiness using bounded ledger reads, event-loop yields, and an elapsed-time
   budget. Timer races alone cannot bound synchronous work. Repair must not adopt
   native history, overwrite newer live metadata, resurrect deleted chats, or
   outlive shutdown.

Preview repair samples only the first and last 32 ledger ordinals, decoding at
most 64 KiB per candidate. Oversized tail rows are skipped. An oversized head
candidate defers repair only when no readable first user input precedes it;
imported user inputs can also be provider rows. Absent edge candidates likewise
leave the cache unrepaired. The byte bound uses SQLite functions
available on older macOS system SQLite. This is best-effort list metadata, not
transcript truncation. Reads and publication are synchronous within each yielded
unit, so live updates, deletion, and view replacement cannot interleave with
publication. An unrepaired entry can still take its title seed from later live
activity; this approximate cache never determines transcript content.

No new transport, durable notification state, replay, or provider-specific logic
is needed. Existing transcript and executor contracts remain authoritative.

## Verification

- Exercise actual startup wiring, coordinator, notifications, and ledger together:
  cached chats and empty queues cause no notification-driven ledger reads, with
  Telegram enabled and disabled.
- Preserve pending user/control queue recovery and genuine search recovery across
  executor readiness transitions, including transitions during initialization.
- Cover new, resumed, queued, failed, permission, and stopped notifications;
  repeated events, missing context, view changes, and multiple chats remain isolated.
  Real coordinator tests cover queued completion coalescing and dispatch failures
  before a ledger run exists. A committed terminal wins over a later launch error
  for the same turn; terminal-free failures reach idle after ownership is released.
  Idle settlement does not require an available executor. Paused queue tails also
  permit attention notifications but never dispatch until explicitly resumed.
- Bound preview work and test synchronous timer starvation, concurrent live
  updates/deletion, cancellation, and preservation of successful partial repairs.
- Run focused tests, repository checks/tests, and isolated timed startup without
  touching the user's running server or native provider state.
