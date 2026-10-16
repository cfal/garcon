# All pinned paths UX

New Chat starts with the selected executor's pins in a compact pill layout. A This machine / All machines scope control appears when another executor has pins. All machines groups bookmarks by executor, including offline and removed executors, with full paths and a bounded scrolling region.

Bookmark identity is the pair of executorId and path. Selecting an available bookmark changes the executor and path in one synchronous form operation, preserving prompt and attachments and invalidating old validation through the existing executor transition. Recheck readiness and bookmark membership at selection. Offline or removed executors remain visible with disabled bookmarks and explicit status; never substitute Local. Scope is component-local and does not change settings or execution targets by itself.

Grouping belongs to project-paths; New Chat owns the cross-executor selection policy. Existing settings remain the authority. The form reads its selected executor's pins directly from the current settings snapshot and overlays its local pins only while persistence is pending, or before settings load. This keeps both scope views, membership checks and the pin toggle current without mirroring snapshots in an effect. Executor removal retains pinned paths while clearing startup defaults and recents; retained unknown-executor bookmarks stay unavailable. Settings shapes and wire contracts remain unchanged, and previously deleted bookmarks cannot be recovered.

A separate scope control keeps All out of the execution selector, where it would imply an invalid execution target. Machine groups make duplicate paths on different machines distinguishable. Verify identical paths across machines, readiness changes, removed hosts, optimistic pin changes, prompt retention, validation routing, and desktop/mobile layout. Capture the real dialog before and after using synthetic identities and paths.

Both scopes render compact, wrapping path pills in the original pinned-path style: one exact path per pill, a subtle border and fill, and an accent background for selection. Pills size to their content rather than filling grid columns. Long paths truncate within the dialog; their complete stored value remains in the accessible name and title.

The scope switch shows counts and a filled active option. Desktop pills and scope buttons are 28px high; coarse-pointer devices retain at least 44px touch targets. Focus rings and executor-status descriptions remain explicit. Machine headings identify each group in All machines; This machine also shows its heading when unavailable, including when no scope switch is visible. Removed and offline pins remain disabled.

Collections above eight bookmarks offer case-insensitive path and machine-name search in either scope. A machine-name match retains that machine's full group. Filtering preserves exact paths and executor identity, includes unavailable bookmarks, and never changes the execution target. Clearing restores all groups and retains input focus. Escape keeps the application's existing modal dismissal behavior.

The searchable results area keeps a fixed height within the existing scrolling limit. Filtering a nine-bookmark desktop collection previously moved the centered dialog's search field from y=326 to y=413; the field must remain stationary as matches change, including the empty-result state. Compact collections retain content-sized results.

Once the search field receives focus, it remains mounted for that pinned-path component's lifetime. Live settings updates that reduce the count below nine and clearing a query after switching into a compact scope preserve the same input, focus and fixed results height. Search visibility before interaction still follows the current scope's bookmark count.

Verify compact desktop wrapping, mobile touch targets, long paths, duplicate paths across machines, keyboard selection, filtering and search focus before publishing fresh screenshots.
