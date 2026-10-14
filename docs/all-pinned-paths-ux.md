# All pinned paths UX

New Chat currently shows only the selected executor's pins. Retain that compact default and add a This machine / All machines scope control when another executor has pins. All machines groups bookmarks by executor, including offline and removed executors, with full paths and a bounded scrolling region.

Bookmark identity is the pair of executorId and path. Selecting an available bookmark changes the executor and path in one synchronous form operation, preserving prompt and attachments and invalidating old validation through the existing executor transition. Recheck readiness and bookmark membership at selection. Offline or removed executors remain visible with disabled bookmarks and explicit status; never substitute Local. Scope is component-local and does not change settings or execution targets by itself.

Grouping belongs to project-paths; New Chat owns the cross-executor selection policy. Existing settings remain the authority, with the active form's optimistic pins overlaid until persistence settles. No server or wire changes are needed.

A separate scope control keeps All out of the execution selector, where it would imply an invalid execution target. Grouped rows make duplicate paths on different machines distinguishable. Verify identical paths across machines, readiness changes, removed hosts, optimistic pin changes, prompt retention, validation routing, and desktop/mobile layout. Capture the real dialog before and after using synthetic identities and paths.
