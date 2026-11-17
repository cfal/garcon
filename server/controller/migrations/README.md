# Workspace migrations

`workspace-version.json` gates the ordered ladder in `index.ts`. Fresh
workspaces receive the current version without running historical entries.
Existing workspaces run every entry newer than their recorded version, then
receive the current version only after the complete ladder succeeds.

Before an incompatible registry write, `checkpointThrough` durably records a
completed migration prefix without changing the boot's original `initialVersion`.
Failed callbacks cannot advance that prefix. Fresh initialization observes the
same checkpoint ordering without running historical migrations.
Checkpoint stamps carry `checkpoint: true`; only `finish()` removes it. A boot
resumed from a checkpoint retains carryover rollback backups until a subsequent
boot starts from a completed stamp.

A migration entry may be removed two releases after it ships. Removing an
entry ends direct upgrade support for workspaces older than that entry; those
workspaces must first upgrade through an intermediate release that still
contains it. Keep entries idempotent because a failed startup can rerun the
ladder before the final version stamp is written.

Version 8 removes the obsolete `nextForkOrdinal` field from `chats.json` entries.
The registry schema remains version 5; existing chat names and other fields are
preserved. Fork and handoff names now depend on current visible titles rather
than persisted counters.

Version 10 splits schema-5 `parentChat` into schema-6 `parentChatId` (delegation)
and `lineage` (fork/handoff source and watermark). It checkpoints workspace
version 9 before publishing schema 6, so interrupted upgrades never replay old
registry writers against the new shape. Conversion validates all entries before
an atomic replacement; rerunning validates an already-converted registry without
rewriting it. Malformed heritage stops startup rather than being discarded.
Dangling source/parent IDs and unrelated fields are preserved. No transcript or
native-history migration runs, and missing historical snapshot lineage is not
inferred. Restore a complete pre-upgrade backup to return to an older release.
