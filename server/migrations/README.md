# Workspace migrations

`workspace-version.json` gates the ordered ladder in `index.ts`. Fresh
workspaces receive the current version without running historical entries.
Existing workspaces run every entry newer than their recorded version, then
receive the current version only after the complete ladder succeeds.

A migration entry may be removed two releases after it ships. Removing an
entry ends direct upgrade support for workspaces older than that entry; those
workspaces must first upgrade through an intermediate release that still
contains it. Keep entries idempotent because a failed startup can rerun the
ladder before the final version stamp is written.

Version 8 removes the obsolete `nextForkOrdinal` field from `chats.json` entries.
The registry schema remains version 5; existing chat names and other fields are
preserved. Fork and handoff names now depend on current visible titles rather
than persisted counters.
