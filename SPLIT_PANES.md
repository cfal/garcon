# Workspace Windows and Window-Local Tabs

Status: implemented on `universal-split-panes`

Baseline: commit `e95c3fb63` on top of `origin/main` at `74c3bfdf9`

Audience: engineers implementing and reviewing the desktop workspace layout

## Summary

Garcon will use one desktop windowing model for Chat, Git, Commit, Pull Requests, Files, file sessions, and Terminals. A workspace **window** is a leaf of the desktop layout. Every window owns its own ordered tab list, active tab, title bar, menu, fullscreen action, and close action. There is no application-wide or “main view” tab list.

The binary layout tree remains as an internal geometry representation because it is the simplest way to express mixed horizontal and vertical arrangements. Its branch nodes are **partitions**, not user-visible split panes. Product actions never say “split pane.” They say “open in new window” when the source presentation remains and “move to new window” when a tab relocates.

Chat becomes a window-local view instead of the single global `singleton:chat` surface. Selecting a chat in the chat list replaces the chat shown by the current window without changing chat views in other windows. Center-dropping a chat-list item adds or replaces the Chat view in that exact window, while edge-dropping it creates a new adjacent Chat window. One interactive `ConversationWorkspace` remains mounted and moves between focused chat windows; other visible chat windows use the existing transcript-preview model.

Every desktop window has one in-flow title bar with the same adaptive tab strip, including one-tab windows. This gives every view the same direct tab affordance and drag source. A Chat tab whose session is processing replaces its normal Chat icon with the existing pulsing semantic-blue indicator, including when the tab or window is inactive. The right side always shows a `+` add menu, an active-tab actions menu, and fullscreen; Close Window appears only when at least two windows exist. Adjacent windows have one-pixel separators. Dedicated semantic tokens make title/tab bars clearly distinct: dark themes use an almost-black active bar and a lighter inactive bar, while light themes use a dark grey active bar and a lighter inactive bar. Multi-tab windows give the selected tab in an inactive window a separate muted background from the selected tab in the current window; a one-tab window leaves its sole selected trigger transparent so the bar is not visually boxed twice. There is no active-window border. Fullscreen is an ephemeral projection: it hides the other windows without mutating their topology, and exiting restores the exact prior layout.

## Terminology

| Term | Meaning |
| --- | --- |
| Workspace window | One visible desktop layout leaf with local tabs and one title bar. This is not an operating-system window. |
| Current window | The most recently focused workspace window. Focusing the chat list does not change it. |
| Tab | A view placement owned by exactly one workspace window. There is no global tab collection. |
| Active tab | The one rendered, interactive view within a window. |
| Partition | An internal binary-tree branch that positions two child subtrees and owns a resize ratio. It has no direct product affordance. |
| Open in new window | Creates an additional presentation in a new workspace-window leaf while retaining the source. Sidebar Chat edge-drag and context actions use this language. |
| Move to new window | Relocates an existing tab into a new workspace-window leaf. Tab actions use this language. |
| Chat view | A stable, window-owned tab whose `chatId` can be replaced without remounting the live Chat workspace. |
| Live Chat workspace | The single mounted `ConversationWorkspace` used by the focused visible Chat view. |
| Chat preview | The read-only transcript shown in another visible Chat window. It never renders a composer. |

Code must use `WorkspaceWindow*` and `WorkspacePartition*` names. `Window` by itself is reserved for the browser global. Existing `Pane*`, `SplitPane*`, and user-visible `split` names are removed from the workspace domain. “Split” may remain only where it describes an unrelated Git diff or another established domain term.

## Problem

The current feature branch has most of the mechanics needed for arbitrary desktop layouts, but its concepts do not yet match the product model.

- The persisted workspace uses window-like leaves, but calls them panes and exposes “split tab,” “merge pane,” and “new pane” actions.
- The canonical first-run leaf contains Chat, Git, and Pull Requests in one tab list. This reads as a global main-view task list rather than a window-local tab group.
- Chat is still one global `singleton:chat` surface. Multiple chats use a second, ephemeral binary split tree nested inside that surface.
- The nested Chat split tree owns separate focus, resizing, drag/drop, preview, title-bar, and close/fullscreen behavior.
- Workspace tabs and the menu are a floating overlay. Only Chat split panes have the compact title bar with a title, fullscreen, and close buttons.
- Fullscreen currently hides other panes without removing them.
- A sidebar chat drag is handled only by Chat’s conversation-feed split controller, so a Git, Files, Terminal, or other window is not an equivalent target.
- Chat list selection updates one global selected chat. It does not express “replace the Chat view in the current window.”

Keeping both layout systems would preserve conflicting ownership rules and make every new interaction answer the same question twice. The target design makes the persisted workspace tree the only desktop window topology.

## Goals

- Make every desktop workspace view render inside a workspace window.
- Make tabs exclusively window-local in state, rendering, commands, keyboard navigation, and persistence.
- Remove “main view,” “pane,” and “split pane” as workspace product concepts.
- Make global open commands create a new window and window-local open commands create a tab in that window.
- Make chat-list selection replace the Chat view in the current window while leaving other windows unchanged.
- Make a chat-list center drop add or replace Chat in the exact target window and an edge drop create a new adjacent Chat window.
- Give every desktop window the same always-present tab strip, add menu, actions menu, and fullscreen control, plus Close Window whenever several windows exist.
- Preserve adaptive tab labels and a menu path to tabs that overflow even in icon-only mode.
- Make Chat tabs follow the same existing-window and directional move semantics as other tabs while preserving window-derived Chat surface identity.
- Surface per-chat processing activity in every visible Chat tab without coupling it to the current selection.
- Make window boundaries visually unambiguous in light, dark, and inherited colorblind themes.
- Make fullscreen reversible without changing or repersisting the underlying topology.
- Preserve one live Chat workspace, stable composer/draft state, background previews, and the current four-window performance bound.
- Preserve left/right chat-list docking and desktop/mobile responsive handoff.
- Keep reducers immutable, transitions serialized, persistence validated, and renderer identity stable.

## Non-goals

- Operating-system windows, browser pop-outs, or multi-monitor placement.
- Multiple independently mounted live `ConversationWorkspace` instances.
- Multi-window rendering on mobile. Mobile remains a single-surface projection.
- More than four simultaneous desktop workspace windows in this change.
- Dragging an entire window title bar to reorder the topology. Tabs and chats can create or move into windows; partition resizers control size.
- Persisting fullscreen mode, dialogs, file sessions, mobile-only projections, focus, or in-progress drag state.
- Changing server, WebSocket, transcript-ledger, or provider contracts.
- Removing the docked chat list. It remains a left/right AppShell region controlled by Local Settings.
- Adding a feature flag.
- Restoring or translating any earlier main/sidebar, pane, split-view, shortcut, or placement schema.

## Acceptance criteria

- Exactly one title bar renders for every visible desktop workspace window, including the sole window.
- No tab strip or tab collection exists above or outside a workspace window.
- Every window renders the same tab strip, including a one-tab window. It uses all available title-bar width, then progressively truncates labels, switches to icon-only tabs, and finally preserves access to overflowed tabs in the actions menu.
- Focusing a one-tab Chat window keeps the title/tab bar at 40 px; the live Chat layer always begins at the universal `top-10` body inset and never overlaps the bar.
- Every adjacent horizontal or vertical window boundary has one one-pixel `border-border` separator.
- Title/tab bars use dedicated semantic backgrounds: approximately 93% lightness inactive and 84% active in light themes, and 7% inactive and 1% active in dark themes. Colorblind variants inherit their corresponding base-theme values.
- Selected tabs in multi-tab windows use approximately 96% lightness in the current light-theme window and 88% in inactive windows, or 18% in the current dark-theme window and 12% in inactive windows. A one-tab window applies no selected-tab background to its sole trigger. No active-window border renders in any theme or window-count state.
- The title bar always exposes a `+` add menu, an active-tab actions menu, and fullscreen. Close Window is absent for the sole remaining window; with several windows it is visible and disabled whenever closure would remove the final Chat view or violate a transient destruction guard.
- The command palette opens Terminal, Git, Git History, Git Compare, Pull Requests, Files, and Commit in a new window. The sidebar has no separate New Window button beside Search.
- The same commands in a window’s `+` menu open as tabs in that exact window, including new and unplaced terminals. Every eligible portable-view command is grouped under the localized “Open views” label in canonical `Git Workbench → Git History → Git Compare → Pull Requests → Files → Commit` order, before the “Open terminals” section, even when a singleton currently lives in another window.
- The active-tab actions menu starts with Move Tab Left/Right, eligible Move to Window entries, Move to New Window Left/Right/Above/Below, and neutral-colored Close Tab, followed by a separator and current-tab actions. Right-clicking the tab exposes the same ordered movement section.
- Selecting chat B while window 1 currently owns chat A changes only window 1’s Chat view to B and activates it.
- Selecting a chat while the current window has no Chat tab inserts a stable Chat tab at index zero and activates it.
- Focusing the chat list does not change which workspace window receives a selected chat.
- Center-dropping any chat-list row onto a Chat-less window adds and activates its stable Chat tab; center-dropping onto a window that already has Chat replaces and activates that presentation. The result label is localized “Add as tab” or “Replace existing chat,” respectively.
- Edge-dropping any chat-list row onto any window creates a new adjacent Chat window, regardless of the target window’s active view.
- Edge-dropping a workspace tab creates a new window. Center-dropping it adds it as a tab to the target window.
- A Chat tab with a non-null `chatId` exposes Move to every other window. A Chat-less destination receives and activates it; a destination with a Chat view replaces that presentation and activates/focuses it. The source Chat view is removed, and an empty source window collapses.
- A non-empty Chat tab is draggable through the same tab-strip, center-window, and edge-window targets as ordinary tabs. A center or tab-strip drop into a Chat-less window receives the Chat; a destination that already has Chat replaces that presentation and shows the localized “Replace existing chat” result instead of “Add as tab.” Moving the last tab out collapses the emptied source window atomically.
- A tab move publishes the destination as current before layout/route observers run. Collapsing the focused source window never exposes an intermediate surviving window as current or lets route synchronization replace the moved Chat.
- Every tab-menu and drag-result label, including “Add as tab” and “Replace existing chat,” comes from the Paraglide message catalog; components contain no user-visible fallback literals.
- Chat directional actions move the Chat view instead of copying it. They are disabled when Chat is the source window’s sole tab because creating and collapsing an adjacent window has no visible geometric result; the reducer also treats that case as an identity no-op.
- Empty Chat views do not expose cross-window or directional movement. The final Chat view cannot close. Sidebar Chat edge-drag and context “Open in New Window” actions continue to create an additional presentation.
- Every processing Chat tab replaces its normal Chat icon with the pulsing semantic-blue processing indicator, including inactive tabs and background windows; idle, stopping, or missing-session tabs use the normal icon.
- Entering fullscreen for window 2 leaves every window, tab, MRU entry, partition, ratio, and surface owner unchanged while presenting only window 2. Exiting fullscreen restores the same layout and keyed window instances.
- The cycle-window-focus shortcut is inert during fullscreen and never activates a hidden window or exits fullscreen.
- Close Window never bypasses dirty-file, Commit-draft, pending-mutation, terminal-placement, or renderer-disposal rules. Fullscreen performs no destructive lifecycle work.
- Switching focused Chat windows does not remount `ConversationWorkspace`, lose a draft, jump scroll unexpectedly, or attach two live composers.
- A non-focused Chat window gives its entire body to the transcript preview and renders no fake textarea or compact composer.
- A page reload restores window topology, window-local tab order/MRU, resize ratios, terminal placements, and persisted Chat IDs.
- All user-visible strings and accessibility labels say “window,” not “pane” or “split view.”

## Pre-migration baseline

This section records the pane-era implementation at the stated baseline commit. The implementation
described here has been removed; the proposed behavior and data model below define the current system.

### Persisted workspace tree

[`surface-types.ts`](web/src/lib/workspace/surface-types.ts#L17) defines prefixed `PaneId` and `SplitId` identities, a `PaneTabState`, binary `DesktopLayoutNode`, and `WorkspaceLayoutSnapshot`. A leaf already owns `order`, `activeId`, and `mru`; the global `surfaces` record is a descriptor registry, not a tab list. The snapshot separately tracks fullscreen, dialog, mobile, and unplaced-terminal projections.

[`pane-tree.ts`](web/src/lib/workspace/pane-tree.ts#L23) centralizes immutable tree traversal and topology changes. `insertPaneSplit` wraps a leaf at an edge, `removePaneAndCollapse` collapses an empty branch, and `computePaneRects` produces fractional absolute geometry. Flat, stable-ID rendering was intentionally chosen so a topology collapse does not remount surviving components.

[`workspace-layout.svelte.ts`](web/src/lib/workspace/workspace-layout.svelte.ts#L99) owns pure placement reducers. It can register a surface in an existing leaf or new edge leaf, move/reorder tabs, collapse empty leaves, merge leaves, resize branches, and set fullscreen. [`assertWorkspaceLayoutInvariants`](web/src/lib/workspace/workspace-layout.svelte.ts#L589) currently requires:

- one to four non-empty panes;
- unique pane and split IDs;
- canonical ratios;
- one active tab and complete MRU permutation per pane;
- exactly one global `singleton:chat` placement;
- exactly one ownership bucket for every surface;
- valid dialog, mobile, fullscreen, and terminal state.

[`WorkspaceTransitionArbiter`](web/src/lib/workspace/workspace-transition-arbiter.ts#L14) serializes reducer plans and revisioned publication. [`WorkspacePresentationController.commit`](web/src/lib/workspace/workspace-presentation-controller.svelte.ts#L472) couples publication to renderer preparation, mobile mode, singleton visibility, focus repair, persistence scheduling, and rollback. Those foundations remain.

### Canonical layout and persistence

[`canonical-layout.ts`](web/src/lib/workspace/canonical-layout.ts#L11) creates one `pane-main` leaf whose tabs are global Chat, Git, and Pull Requests. [`layout-schema.ts`](web/src/lib/workspace/layout-schema.ts#L85) parses `workspace_layout_v2`, deduplicates durable surfaces, repairs MRU and active tabs, collapses empty branches, clamps ratios, enforces the four-pane cap, and ensures the global Chat surface exists.

[`common/workspace-layout.ts`](common/workspace-layout.ts#L22) defines persisted V2 pane/split nodes. Persistence includes singleton and terminal references, tab order, active tab, MRU, branch direction/ratio, and unplaced terminal IDs. It intentionally omits fullscreen, dialogs, file sessions, mobile projection, focus, and drag state. [`WorkspaceLayoutPersistence`](web/src/lib/workspace/workspace-layout-persistence.ts#L19) coalesces local-storage writes for 250 ms and flushes on `pagehide` or backgrounding.

### Workspace coordination

[`WorkspaceCoordinator`](web/src/lib/workspace/workspace-coordinator.svelte.ts#L73) is the public intent boundary. Its current relevant methods are:

- `openSingletonAsTab` for a pane-local open;
- `openSingletonInNewPane` for a global open;
- `moveTabToPane` and `splitTabToEdge` for tab DnD/menu actions;
- `mergePaneInto` and `setSplitRatio` for topology;
- `closeSurface` for close guards, required removal, and controller disposal;
- `toggleFullscreen` for non-destructive visibility fullscreen;
- terminal and file placement methods with publication/reservation handling.

The coordinator’s `#reservedSurfaceIds` closes known close/reopen races. File sessions, terminals, singleton controllers, transient layers, and frame bridges already have explicit lifecycle owners. The window design extends these mechanisms instead of bypassing them.

[`WorkspacePresentationController`](web/src/lib/workspace/workspace-presentation-controller.svelte.ts#L181) tracks `lastFocusedSurfaceId`, `lastFocusedPaneId`, and `FocusOwner` ephemerally. Chat-list focus is distinct and therefore already preserves the last workspace destination. Tab navigation is leaf-local, and `cyclePaneFocus` walks leaves in tree order. [`visible-presentations.ts`](web/src/lib/workspace/visible-presentations.ts#L24) selects one active surface per visible desktop leaf and retains hidden singleton renderers where needed.

### Desktop rendering and title controls

[`WorkspaceRoot.svelte`](web/src/lib/components/workspace/WorkspaceRoot.svelte#L81) derives the tree geometry, renders every pane in a keyed flat loop, and overlays branch resizers. The loop at lines 290–304 is the correct Svelte identity pattern to preserve. Fullscreen currently keeps other pane components mounted but hidden.

[`WorkspacePane.svelte`](web/src/lib/components/workspace/WorkspacePane.svelte#L122) is an absolute leaf wrapper. It renders a floating `WorkspaceTaskBar`, the global Chat surface when that leaf owns it, portable frames, and five tab-drag drop zones.

[`WorkspaceTaskBar.svelte`](web/src/lib/components/workspace/WorkspaceTaskBar.svelte#L108) owns local tab measurement, selection, reordering, moving, edge splitting, local opens, hidden-tab overflow, fullscreen, and Chat-specific menu snippets. `selectVisibleTaskbarSurfaceIds` in [`workspace-taskbar-layout.ts`](web/src/lib/components/workspace/workspace-taskbar-layout.ts#L39) guarantees the active tab remains visible and fills remaining capacity with ordered tabs. The bar is currently geometrically centered between independent start/end controls and is absolutely floated above content.

[`WorkspacePaneResizer.svelte`](web/src/lib/components/workspace/WorkspacePaneResizer.svelte#L44) previews pointer movement locally, commits once on release, exposes a WAI-ARIA separator, supports arrow-key resizing, and resets to 50/50 on double click. Its behavior remains but terminology changes to windows/partitions.

### Global open menu and chat-list dock

[`AppShell.svelte`](web/src/lib/components/layout/AppShell.svelte#L97) derives fullscreen and Git-focused chat-list hiding. Its `WorkspaceNewPaneActions` at lines 109–134 routes the chat-list toolbar menu to new pane methods. [`SidebarControlsRow.svelte`](web/src/lib/components/sidebar/SidebarControlsRow.svelte#L152) renders that global menu.

The desktop chat list is a separate, single mounted AppShell region at [`AppShell.svelte`](web/src/lib/components/layout/AppShell.svelte#L486). Local Settings controls left/right docking and width. Fullscreen currently reduces its width to zero. This design retains that structure and renames only workspace-window concepts; “sidebar” remains the valid product term for the chat list.

### Chat selection and routing

[`AppShell.svelte`](web/src/lib/components/layout/AppShell.svelte#L171) currently treats `ChatSessionsStore.selectedChatId` as canonical and mirrors URL routes into it. `handleChatSelect` at lines 286–294 sets the selected chat, navigates, requests composer focus, and focuses the one global Chat surface.

This global selection remains the active-interaction projection used by Chat internals, shortcuts, dialogs, and the route. It stops being the ownership model for all visible Chat windows. Window-local Chat descriptors become durable presentation state; `selectedChatId` reflects only the focused live Chat view.

### Nested Chat split system

[`split-layout.svelte.ts`](web/src/lib/chat/split/split-layout.svelte.ts#L77) owns a second, ephemeral binary tree whose leaves store `chatId`. It supports one to four panes, path-based ratios, focused pane, sidebar drag state, replacement, close, and pane swapping.

[`ChatSurface.svelte`](web/src/lib/components/chat/ChatSurface.svelte#L133) integrates that store. It synchronizes the focused split chat with global selection, replaces the focused pane after sidebar selection, handles conversation-feed and active-split drops, and positions one live `ConversationWorkspace` over the focused preview pane. [`SplitContainer.svelte`](web/src/lib/components/split/SplitContainer.svelte#L61) recursively renders the tree. [`ChatPane.svelte`](web/src/lib/components/split/ChatPane.svelte#L166) supplies the compact title bar, background transcript preview, compact composer, focus, maximize, close, and pane-header drag.

The reusable parts are the one-live-workspace approach, transcript preview cache/store, compact background composer, and visual title-bar language. The separate topology, title bar, resize system, focus state, and drag controller are removed.

### Drag and drop

Workspace surface tabs use [`WorkspacePaneDndStore`](web/src/lib/workspace/pane-dnd.svelte.ts#L43). Tab-strip drops reorder or move tabs; center body drops add a tab; edge drops call `splitTabToEdge`; projected pane count handles net-zero moves at the cap.

Sidebar rows use Atlassian Pragmatic DnD and also call `splitLayout.startDrag` from [`SidebarVirtualSortableChatList.svelte`](web/src/lib/components/sidebar/SidebarVirtualSortableChatList.svelte#L241). [`sidebar-pragmatic-dnd.ts`](web/src/lib/components/sidebar/sidebar-pragmatic-dnd.ts#L11) carries a `splitPaneDragKind` compatibility marker. [`SplitDropController`](web/src/lib/components/chat/split-drop-controller.svelte.ts#L165) then reads Chat-specific global drag state and measures only Chat split panes.

The target design replaces both workspace and Chat topology drop controllers with one root-owned workspace-window DnD controller. Sidebar reorder remains in the sidebar domain.

## Verified implementation constraints

- The branch uses Svelte `5.56.10`, as installed by `web/node_modules/svelte/package.json`.
- Surviving window components must stay in a keyed `#each` by stable window ID. Svelte’s [keyed each-block contract](https://svelte.dev/docs/svelte/each#Keyed-each-blocks) is the basis for preserving component identity during topology changes.
- Root-owned DnD and window services must use the repository’s typed `createContext` wrappers. Svelte documents `createContext` as the preferred type-safe API in [Context](https://svelte.dev/docs/svelte/context).
- Components remain runes-mode Svelte 5 components with callback props and event attributes. No `createEventDispatcher`, legacy `on:`, raw context keys, or mirror-state effects are introduced.
- No new dependency is required.

## Proposed behavior

### Window-local tabs

Every `WorkspaceWindowNode` contains its own `WorkspaceWindowTabState`. The global `surfaces` record remains a lifecycle registry, but it does not determine tab order and is never rendered as a global tab list.

The canonical desktop layout is one window with one Chat view. Git and Pull Requests are no longer preloaded into that window. They open on demand from a window-local `+` menu, the command palette, or an owning surface action. The sidebar toolbar has Search but no separate global New Window control.

Tab rules:

- Selecting a tab activates it only in its owning window and makes that window current.
- `Ctrl+Shift+J/L` navigates only the current window’s tabs.
- A tab-strip drop reorders within a window or moves a movable surface to another window.
- A center body drop moves the surface into the target window as an active tab.
- An edge body drop moves the surface into a newly created adjacent window.
- A Chat tab can reorder locally and can move to any other existing window when its descriptor has a non-null `chatId`.
- A non-empty Chat tab is draggable like every other movable tab. Indexed tab-strip and center-window drops transfer it into the destination; if that window already owns Chat, its window-derived Chat descriptor is replaced rather than duplicated.
- Moving Chat into a window without Chat installs the source `chatId` as that window’s derived Chat view at index zero and activates it.
- Moving Chat into a window that already has Chat replaces the destination descriptor’s `chatId` in place, preserves the destination tab position, and activates/focuses it.
- A Chat move removes the source descriptor and placement. The destination retains its window-derived Chat surface ID; transient surface references are rekeyed from the source ID to the destination ID.
- A directional Chat action moves the Chat view into a newly created adjacent window. It never copies the source presentation.
- A directional Chat action is unavailable when Chat is the source window’s sole tab or its `chatId` is null. The sole-tab reduction is also an identity no-op because insert-then-collapse would recreate the same geometry with needless identity churn.
- Any Chat tab can close while another Chat view remains; the final Chat view is never closable.
- A window contains at most one Chat tab.
- Portable singletons, files, and terminals retain their current one-placement invariant.
- A window can contain a Chat tab and any number of other tabs within existing surface/session limits.

### Current window

`lastFocusedWindowId` is ephemeral presentation state. It changes when focus or pointer interaction enters a window body, tab, title-bar control, or preview. It does not change when focus moves into the chat list, a modal, or a transient overlay.

Any intent that says “current window” resolves its destination inside the serialized arbiter turn:

1. Use `lastFocusedWindowId` if it still exists.
2. Otherwise use the window containing `lastFocusedSurfaceId`.
3. Otherwise use the first depth-first window.

This makes sidebar selection deterministic even if a concurrent tab move or window close invalidates the originally focused window.

### Chat selection

Each window-local Chat tab has a stable surface identity derived from the window ID and a replaceable `chatId`:

```ts
export type WorkspaceWindowId = `window-${string}`;
export type ChatViewSurfaceId = `chat-view:${WorkspaceWindowId}`;

export interface ChatViewSurfaceDescriptor {
	id: ChatViewSurfaceId;
	type: 'chat';
	chatId: string | null;
}

export function chatViewSurfaceId(windowId: WorkspaceWindowId): ChatViewSurfaceId {
	return `chat-view:${windowId}`;
}
```

Selecting a chat from the desktop chat list runs one serialized `showChatInCurrentWindow(chatId)` intent:

- If the current window already owns its Chat view, update that descriptor’s `chatId` in place, preserve its tab index, and activate it.
- If it has no Chat view, register `chat-view:<windowId>` at tab index zero and activate it.
- Do not remove, replace, or focus a Chat view in another window.
- Update `ChatSessionsStore.selectedChatId`, the route, and composer focus only after the layout publication succeeds.
- Preserve the current window destination while the chat list itself owns focus.

The same route applies to adjacent-chat shortcuts, route navigation, newly created chats, forks that select their result, and self-handoff navigation.

A `chatId` may appear in more than one window-local Chat descriptor. This is deliberate: the selected-chat replacement contract must not mutate another window. Surface identity remains unique because it represents a window’s Chat view, not the chat record.

Direct browser navigation to `/chat/:id` replaces the current window’s Chat view without issuing a second navigation. A bare `/` or `/chat` route uses the existing last-selected-chat restore policy and then applies it to the current window. Focusing a background Chat window makes that descriptor’s `chatId` the global active selection and updates the route.

### Global and window-local open commands

| Origin | Command result |
| --- | --- |
| Sidebar Chat context action or edge drop | Open an additional Chat presentation in a new window; retain the source presentation. |
| Sidebar Chat center drop | Add or replace the Chat presentation in that exact window and activate it. |
| Command palette global “Open …” | Open in a new window. |
| Window title-bar `+` menu | Open as a tab in that exact window. |
| Existing singleton already owns a window/tab | Focus it for a global open; move and activate it for an explicit window-local open, matching current singleton uniqueness. |
| File preference “Same window” | Open as a tab in the origin/current window. |
| File preference “New window” | Open in a new window adjacent to the origin/current window. |
| File preference “Dialog” | Preserve the existing file dialog projection. |

The command palette calls coordinator methods such as `openSingletonInNewWindow`, `createTerminalInNewWindow`, and `openFileInNewWindow` directly. The default placement edge is right. Direction-specific tab and context-menu actions are “Move to New Window Left/Right/Above/Below.” Sidebar Chat context and edge-copy actions retain “Open in New Window”; center drops use localized “Add as tab” or “Replace existing chat.”

At four windows, new-window commands are disabled with “4 windows max.” They never silently degrade to opening a tab.

### Chat drag onto any window

Chat-list click and drop position intentionally have distinct semantics:

- Click a chat-list row: replace the current window’s Chat view.
- Center-drop a chat-list row: add or replace the Chat view in that exact target window and activate it.
- Edge-drop a chat-list row: create a new adjacent Chat window.

The complete target window, including title bar and content, participates in the chat drop. The active tab can be Chat, Git, Files, a file, Commit, Pull Requests, or Terminal. A Chat drop never depends on a conversation-feed element.

For a Chat payload, the target uses the same five regions as a surface tab. The center region resolves against the exact destination: a Chat-less window shows localized “Add as tab,” while a window that already owns Chat shows localized “Replace existing chat.” Dropping commits `set-window-chat` for that window and publishes its derived Chat surface as the current presentation before layout/route observers run. The four edge regions show the half occupied by a new adjacent Chat window and retain copy semantics.

At the window cap, the four edge regions are blocked with an explicit label while the center remains available because it does not add a window. A failed or cancelled drop leaves selection and topology unchanged.

For a surface-tab payload, the existing five outcomes remain with new language: four edges move the tab into a new window, and center moves it into the target window. Tab-strip drops remain indexed tab moves. Chat tabs use this same payload. A Chat-less center destination receives the Chat at the requested position; a destination that already owns Chat replaces its existing presentation and activates the transferred Chat. The center result label is localized “Replace existing chat” for the occupied case and localized “Add as tab” otherwise. If the moved tab was the source window’s last tab, that source window collapses in the same reduction.

Keyboard equivalents are mandatory:

- A sidebar chat context menu offers Open in New Window, plus directional placement in a submenu.
- A tab context menu offers Move Tab Left/Right, Move to every eligible Window, Move to New Window Left/Right/Above/Below, and Close Tab. Chat uses true move semantics, disables cross-window movement while empty, disables directional movement while empty or the sole source tab, and disables Close Tab for the final Chat view.
- The active-tab actions menu repeats the same movement section in this exact order: Move Tab Left, Move Tab Right, Move to `<window>` entries, Move to New Window Left, Right, Above, and Below, then neutral-colored Close Tab. A separator then precedes hidden-tab access and current-surface/file/session actions.

### Window title bar

Every desktop window renders an in-flow `WorkspaceWindowTitleBar`; no workspace taskbar floats over content.

All tab counts use one state:

- 40 px minimum title-bar height.
- The title area is always a left-aligned WAI-ARIA tab list, including one tab.
- The active tab’s label is the current window title.
- Full labels use their natural measured widths while they fit.
- Under pressure, every tab remains visible while labels share the rail and truncate.
- If the rail cannot provide a useful label width per tab, every tab switches to an icon-only trigger with its label retained as an accessible name and tooltip.
- Only when all icon triggers no longer fit does active/pinned-first overflow hide whole tabs.
- Hidden tabs appear under an “Open tabs” section in that window’s active-tab actions menu.
- Add, active-tab actions, and fullscreen remain fixed and are never displaced by tabs. Close Window is also fixed whenever at least two windows exist.
- Each Chat tab resolves processing from the root `ChatSessionsStore` by its descriptor `chatId`, independent of the selected chat, active tab, or current window.
- While `sessions.isChatProcessing(chatId)` is true, the tab replaces `WorkspaceSurfaceIcon` with the existing `bg-status-processing` pulsing dot in the same fixed icon box. The indicator has the accessible “Chat is processing” label and obeys the existing reduced-motion rule.
- The offscreen measurement rail keeps the ordinary Chat icon and produces no duplicate animation or accessible status.

The title bar participates in normal flex layout, so the body starts below it. This removes `--workspace-floating-taskbar-inset`, `reserveTopFloatingToolbar`, `lowerToolbarForChatSplit`, and the special toolbar-overlap offset. It also eliminates the duplicate ChatPane header.

Every partition boundary renders one centered one-pixel `border-border` separator inside the existing resize hit target. Title/tab bars use dedicated `workspace-window-titlebar` and `workspace-window-titlebar-active` semantic tokens instead of borrowing generic muted/accent backgrounds. The light base theme uses approximately 93% lightness for inactive bars and 84% for the active bar; the dark base theme uses approximately 7% and 1%, respectively. Selected tabs in multi-tab windows use dedicated `workspace-window-tab-selected` and `workspace-window-tab-selected-inactive` tokens: approximately 96%/88% in light themes and 18%/12% in dark themes. A sole tab keeps a transparent trigger with foreground text, leaving the title-bar token as its only background. Colorblind variants inherit their corresponding light/dark base values. The active-window focus-ring overlay and token are removed; title and selected-tab contrast communicate focus without drawing a border over content. These affordances do not change geometry or pointer hit areas.

The `+` menu owns additive window-local commands: create a terminal, reopen an unplaced terminal, and open an available portable view as a tab in that exact window. It derives available portable views from the canonical `PORTABLE_SINGLETON_KINDS` order, groups every eligible command under the localized “Open views” label, and renders that complete group before “Open terminals.” A singleton in another window remains eligible because selecting it performs the existing explicit move into this window; its position in the group does not change. The three-dots menu owns the active tab. It begins with local reorder, eligible cross-window movement, the four directional move-to-new-window commands, and neutral-colored Close Tab; a separator then precedes hidden-tab access and current-surface actions. The tab’s right-click menu retains the same ordered movement section.

Control order on the inline end is:

1. Window-local `+` add menu.
2. Active-tab actions menu.
3. Enter/exit fullscreen.
4. Close Window, only when at least two windows exist.

Close Window closes the whole window, not merely its active tab. Tab close remains in tab context/window menus. The sole window omits Close Window entirely. A non-sole window that owns the final Chat view still renders a disabled Close Window so window-level destruction cannot bypass the final-Chat rule.

### Window close

Closing a non-sole window destroys all of its tabs and collapses its parent partition into the sibling subtree. It never merges those tabs into another window.

Lifecycle behavior by surface:

- Chat view: remove only the window-local presentation; never delete the chat.
- Terminal: unplace the terminal surface but keep the terminal session alive and available from Open Terminals.
- File: run `confirmDestructive(..., 'close')`; destroy the file session only after publication.
- Commit: block pending work, confirm retained drafts, discard only after publication.
- Portable singleton: dispose its owning controller after required removal publishes.
- Terminal launcher: invoke the existing launcher-dismissal callback.

The coordinator reserves every affected surface and the window ID before awaiting any confirmation. It computes the final plan from the latest snapshot in the arbiter turn. Cancellation releases all reservations and publishes nothing. After success, focus falls to the sibling subtree’s most recently active surface, then its first active tab.

### Reversible fullscreen

Fullscreen is an ephemeral presentation projection:

- Entering fullscreen sets `fullscreenWindowId` to the target without changing `desktopRoot`, `surfaces`, window-local tab order/MRU, partition ratios, terminal placement, or renderer ownership.
- WorkspaceRoot keeps every keyed window instance. The target receives the full host rectangle; other windows become hidden, inert, and `aria-hidden`.
- Only the target window’s active surface is presented. Active portable renderers in hidden windows stay retained but non-visible so exit does not recreate their owning state.
- AppShell hides the chat list and the target title bar shows Exit Fullscreen.
- Exiting fullscreen clears only `fullscreenWindowId`, revealing the unchanged topology and the same keyed windows.
- Opening a new window or activating a surface in another window exits fullscreen in the same publication.
- Fullscreen remains omitted from V2 persistence. A reload during fullscreen restores the ordinary persisted topology with fullscreen off.

Fullscreen does not close, dispose, unplace, or discard anything, so dirty-file, Commit-draft, pending-mutation, and terminal close guards do not run. It still cancels active workspace drag/pointer interaction before making other windows inert.

### Chat rendering and lifecycle

Only one full `ConversationWorkspace` is mounted. It lives once under `WorkspaceRoot`, outside the keyed window loop, and is absolutely positioned over the focused active Chat window’s body. It is never keyed by `chatId` or `windowId`.

The desktop live layer always uses the same 40 px (`top-10`) inset as `WorkspaceWindowTitleBar`, regardless of tab count. The former one-tab 32 px header offset is removed with the non-tabbed title bar; retaining a tab-count conditional would let the higher-z-index live layer cover the bottom 8 px of a focused one-tab bar. Mobile continues to use an edge-to-edge inset because it does not render desktop window chrome.

When focus changes:

- The live layer moves to the newly focused Chat window and uses global `selectedChatId` for that descriptor.
- The previous Chat window immediately renders a preview from the shared transcript cache.
- A visible non-focused Chat window renders only the extracted transcript preview body, using all body height.
- A Chat tab hidden behind another tab renders neither live content nor a preview.
- Clicking or keyboard-activating a preview first activates that window’s Chat view, then requests focus for the one live composer.

`ChatSurface.svelte` loses the nested split layout, split drop controller, pane geometry, and pane synchronization effects. It retains mobile Chat chrome, empty/loading presentation, the single `ConversationWorkspace`, transcript cache integration, and registration callbacks.

`ChatPane.svelte` is decomposed:

- The header moves to `WorkspaceWindowTitleBar.svelte` for all surface kinds.
- The preview body becomes `ChatWindowPreview.svelte`.
- `SplitPanePreviewStore` becomes `ChatWindowPreviewStore`; its paging/cache behavior is retained.

The pane-era compact preview composer is deleted rather than renamed. Draft ownership remains exclusively in the shared `ChatDraftStore` and the sole live composer; inactive previews never expose a second draft-editing surface.

`SplitLayoutStore`, `SplitContainer.svelte`, the Chat `SplitResizer.svelte`, `chat-split-actions.ts`, `getSplitLayout` context, and `SplitDropController` are deleted after their retained behavior moves to the universal window system.

### Mobile behavior

Mobile remains one visible surface and does not render desktop title bars, partitions, or window DnD.

- Entering mobile projects the active surface of the last-focused window.
- If that surface is a window-local Chat descriptor, its `chatId` becomes the active global Chat selection.
- Selecting a mobile chat updates the same last-focused desktop window Chat descriptor so returning to desktop is coherent.
- Existing mobile bottom tabs and transient Git/file behavior remain.
- Desktop window topology stays mounted or retained according to the current responsive handoff rules; no desktop window is created solely for a mobile-only transient surface.
- Fullscreen remains desktop-only.

## Proposed data model

The V2 runtime model becomes:

```ts
export const MAX_WORKSPACE_WINDOWS = 4;

export type WorkspaceWindowId = `window-${string}`;
export type WorkspacePartitionId = `partition-${string}`;
export type WorkspacePartitionDirection = 'horizontal' | 'vertical';
export type WorkspaceWindowEdge = 'left' | 'right' | 'top' | 'bottom';
export type ChatViewSurfaceId = `chat-view:${WorkspaceWindowId}`;

export interface WorkspaceWindowTabState {
	readonly order: readonly string[];
	readonly activeId: string;
	readonly mru: readonly string[];
}

export interface WorkspaceWindowNode {
	readonly type: 'window';
	readonly id: WorkspaceWindowId;
	readonly tabs: WorkspaceWindowTabState;
}

export interface WorkspacePartitionNode {
	readonly type: 'partition';
	readonly id: WorkspacePartitionId;
	readonly direction: WorkspacePartitionDirection;
	readonly ratio: number;
	readonly children: readonly [DesktopWorkspaceNode, DesktopWorkspaceNode];
}

export type DesktopWorkspaceNode = WorkspaceWindowNode | WorkspacePartitionNode;

export type SurfaceDescriptor =
	| { id: ChatViewSurfaceId; type: 'chat'; chatId: string | null }
	| PortableSingletonDescriptor
	| { id: string; type: 'terminal'; terminalId: string }
	| { id: string; type: 'file'; fileSessionId: string }
	| { id: typeof TERMINAL_LAUNCHER_ID; type: 'terminal-launcher' };

export interface WorkspaceLayoutSnapshot {
	readonly desktopRoot: DesktopWorkspaceNode;
	readonly surfaces: Readonly<Record<string, SurfaceDescriptor>>;
	readonly fullscreenWindowId: WorkspaceWindowId | null;
	readonly dialogFileSurfaceId: string | null;
	readonly mobileActiveSurfaceId: string;
	readonly mobileOnlySurfaceIds: readonly string[];
	readonly mobileReturnStack: readonly MobileReturnTarget[];
	readonly unplacedTerminalIds: readonly string[];
}
```

`PresentationHostId` becomes `WorkspaceWindowId | 'mobile' | 'dialog'`. `DesktopPlacement` variants become `window`, `new-window`, and `dialog`. `FocusOwner` uses `window-chrome`. `WorkspaceLayoutReader` exposes `defaultWindowId`; it no longer exposes `chatPaneId` because Chat can exist in several windows or no Chat tab can exist in a particular window.

The mutation vocabulary becomes intent-aligned:

```ts
export type WorkspaceLayoutMutation =
	| { type: 'register-surface'; surface: SurfaceDescriptor; windowId?: WorkspaceWindowId; index?: number }
	| {
			type: 'register-surface-in-new-window';
			surface: SurfaceDescriptor;
			targetWindowId: WorkspaceWindowId;
			edge: WorkspaceWindowEdge;
			newWindowId: WorkspaceWindowId;
			partitionId: WorkspacePartitionId;
	  }
	| { type: 'set-window-chat'; windowId: WorkspaceWindowId; chatId: string | null }
	| { type: 'activate-window-tab'; windowId: WorkspaceWindowId; surfaceId: string }
	| { type: 'move-tab'; surfaceId: string; destinationWindowId: WorkspaceWindowId; index?: number }
	| {
			type: 'move-chat-to-window';
			sourceWindowId: WorkspaceWindowId;
			destinationWindowId: WorkspaceWindowId;
	  }
	| {
			type: 'move-tab-to-new-window';
			surfaceId: string;
			targetWindowId: WorkspaceWindowId;
			edge: WorkspaceWindowEdge;
			newWindowId: WorkspaceWindowId;
			partitionId: WorkspacePartitionId;
	  }
	| { type: 'close-window'; windowId: WorkspaceWindowId }
	| { type: 'set-partition-ratio'; partitionId: WorkspacePartitionId; ratio: number }
	| { type: 'set-fullscreen-window'; windowId: WorkspaceWindowId | null }
	| ExistingDialogMobileTerminalMutations;
```

`set-window-chat` creates the derived Chat descriptor/tab when absent and updates it in place when present. `move-chat-to-window` atomically removes the source window’s derived Chat descriptor, collapses an emptied source window, rekeys transient mobile references, then installs or replaces and activates the destination window’s derived Chat view. `move-tab-to-new-window` keeps ordinary tab identity but has an explicit Chat branch that transfers its `chatId` to `chat-view:<newWindowId>`, deletes the source descriptor, repairs references, and clears fullscreen. Its same-anchor sole-Chat-tab case returns the original snapshot. Generic `move-tab` continues to reject cross-window Chat descriptors while permitting local Chat reorder. These explicit mutations are the only reducers allowed to transfer Chat ownership; removal remains legal only under the final-Chat invariant.

### Runtime invariants

`assertWorkspaceLayoutInvariants` enforces:

- one to four non-empty workspace windows;
- unique window and partition IDs with required prefixes;
- canonical partition ratios;
- each window has one active tab and a complete, unique MRU permutation;
- every descriptor has exactly one ownership bucket;
- each window contains zero or one Chat descriptor;
- a Chat descriptor’s ID equals `chatViewSurfaceId(owningWindow.id)`;
- Chat descriptors are never dialog or mobile-only surfaces;
- duplicate `chatId` values across different Chat descriptors are valid;
- a Chat transfer rekeys `mobileActiveSurfaceId` and every matching `mobileReturnStack[].invokerSurfaceId` to the destination-derived surface ID;
- portable singletons, terminals, files, and launcher surfaces remain globally unique placements;
- at least one Chat view remains;
- the fullscreen window exists whenever `fullscreenWindowId` is non-null; other windows remain valid hidden topology;
- the existing dialog, mobile, return-stack, and unplaced-terminal invariants remain.

Opening a new window first clears fullscreen in the same reduction.

## Persistence and clean cutover

The implementation owns one current `workspace_layout_v2` schema. It does not parse, translate, or retain V1 main/sidebar layouts, pane-era V2 layouts, legacy dock-order arrays, retired placement values, or deprecated shortcut IDs. Missing, malformed, or unsupported layout data starts from the canonical Chat window.

The persisted schema becomes:

```ts
export interface PersistedWorkspaceLayoutV2 {
	version: 2;
	root: PersistedWorkspaceLayoutNode;
	unplacedTerminalIds: string[];
}

export type PersistedWorkspaceSurfaceRef =
	| { type: 'chat'; chatId: string | null }
	| { type: 'singleton'; kind: PortableSingletonKind }
	| { type: 'terminal'; terminalId: string };

export type PersistedWorkspaceLayoutNode =
	| {
			type: 'window';
			id: string;
			order: PersistedWorkspaceSurfaceRef[];
			active: PersistedWorkspaceSurfaceRef | null;
			mru: PersistedWorkspaceSurfaceRef[];
	  }
	| {
			type: 'partition';
			id: string;
			direction: WorkspacePartitionDirection;
			ratio: number;
			children: [PersistedWorkspaceLayoutNode, PersistedWorkspaceLayoutNode];
	  };
```

Chat view surface IDs are derived from the owning persisted window ID and are not separately serialized. Restoration keeps the first valid Chat ref per window and drops later duplicates. It accepts `chatId: null` for an empty Chat view.

Current V2 restoration runs global descriptor deduplication, per-window Chat deduplication, MRU repair, empty-branch collapse, ratio clamp, window-cap enforcement, and runtime invariants. The absent canonical layout is one empty-or-selected Chat view; it does not inject Git or Pull Requests.

After chat sessions load, a reconciliation binding checks persisted Chat IDs. A missing/deleted chat changes that descriptor to `chatId: null` without collapsing the window or changing other tabs. The active routed chat then fills only the current window. No transcript, title, project path, or other chat metadata is stored in layout persistence.

Fullscreen remains omitted from serialization. Because entry never changes the ordinary topology, persistence continues writing the same root, tabs, MRU, and ratios; the fullscreen projection resets after reload. File sessions, dialogs, mobile projection, focus, and DnD state remain transient.

## Coordinator and lifecycle design

### Window intent API

`WorkspaceCoordinator` exposes product intents rather than topology mechanics:

```ts
showChatInCurrentWindow(chatId: string): Promise<ChatViewSurfaceId>;
showChatInWindow(chatId: string, windowId: WorkspaceWindowId): Promise<ChatViewSurfaceId>;
openChatInNewWindow(
	chatId: string,
	targetWindowId?: WorkspaceWindowId,
	edge?: WorkspaceWindowEdge,
): Promise<WorkspaceWindowId>;
openSingletonAsTab(kind: PortableSingletonKind, windowId: WorkspaceWindowId): Promise<void>;
openSingletonInNewWindow(kind: PortableSingletonKind, anchorWindowId?: WorkspaceWindowId): Promise<void>;
moveTabToWindow(surfaceId: string, windowId: WorkspaceWindowId, index?: number): Promise<void>;
moveTabToNewWindow(
	surfaceId: string,
	targetWindowId: WorkspaceWindowId,
	edge: WorkspaceWindowEdge,
): Promise<void>;
closeWindow(windowId: WorkspaceWindowId): Promise<boolean>;
enterWindowFullscreen(windowId: WorkspaceWindowId): Promise<boolean>;
exitWindowFullscreen(windowId: WorkspaceWindowId): Promise<void>;
setPartitionRatio(partitionId: WorkspacePartitionId, ratio: number): Promise<void>;
cycleWindowFocus(owner?: FocusOwner): void;
```

There is no `split*` or `mergePaneInto` API. `showChatInWindow` validates the exact destination in the latest snapshot, applies `set-window-chat`, and publishes `chat-view:<windowId>` as the presentation target; `showChatInCurrentWindow` shares that path after resolving its destination in the arbiter turn. `moveTabToWindow` branches on the latest descriptor: ordinary surfaces use generic movement, while Chat uses `move-chat-to-window` and presents the destination-derived Chat surface ID. `moveTabToNewWindow` likewise presents `chat-view:<newWindowId>` after a Chat transfer. `openChatInNewWindow` remains separate for sidebar edge/context copy actions. `enterWindowFullscreen` and `exitWindowFullscreen` change only the ephemeral projection flag.

Tab moves publish through `WorkspacePresentationController.commitWithPresentationTarget`. The mutation-plan closure resolves the destination surface from the latest snapshot and exposes it only when it emits an actual move. After layout publication, the controller adopts that visible surface as `focusOwner`, `lastFocusedSurfaceId`, and `lastFocusedWindowId` before focus normalization and `onLayoutChanged` observers run. Stale or identity-no-op plans expose no target and therefore do not focus an unrelated destination. The existing post-settlement `presentSurface` call remains responsible for DOM/frame or composer focus.

Both Chat placement intents resolve or validate their destination inside the arbiter plan and return the stable Chat surface ID only after publication:

```ts
async showChatInCurrentWindow(chatId: string): Promise<ChatViewSurfaceId> {
	return this.#showChat(chatId, (latest) => this.#resolveCurrentWindow(latest));
}

async showChatInWindow(
	chatId: string,
	windowId: WorkspaceWindowId,
): Promise<ChatViewSurfaceId> {
	return this.#showChat(chatId, (latest) =>
		windowNodeById(latest.desktopRoot, windowId) ? windowId : null,
	);
}

async #showChat(
	chatId: string,
	resolveWindow: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceWindowId | null,
): Promise<ChatViewSurfaceId> {
	let surfaceId: ChatViewSurfaceId | null = null;
	let applied = false;
	const current = await this.#presentation.commitWithPresentationTarget(
		(latest) => {
			const windowId = resolveWindow(latest);
			if (!windowId || this.#reservedWindowIds.has(windowId)) return [];
			surfaceId = chatViewSurfaceId(windowId);
			if (this.#reservedSurfaceIds.has(surfaceId)) return [];
			applied = true;
			return [{ type: 'set-window-chat', windowId, chatId }];
		},
		() => (applied ? surfaceId : null),
	);
	if (!surfaceId || !applied) throw new Error(m.workspace_open_failed());
	if (current) this.#presentation.presentSurface(surfaceId);
	return surfaceId;
}
```

### Window destruction service

Closing a whole window must not loop over `closeSurface`, because per-surface publication would expose a partial close. `WorkspaceWindowDestructionService` remains a narrow coordinator-owned service for Close Window only; fullscreen does not use it.

```ts
interface WindowDestructionRequest {
	mode: 'close';
	targetWindowId: WorkspaceWindowId;
}

interface WindowDestructionPlan {
	reservedSurfaceIds: readonly string[];
	removedDescriptors: readonly SurfaceDescriptor[];
	terminalIdsToUnplace: readonly string[];
	mutations: readonly WorkspaceLayoutMutation[];
}
```

The service:

1. Resolves affected windows and descriptors from the latest snapshot.
2. Rejects closing the sole window.
3. Rejects closing a window that owns the final Chat view.
4. Acquires window and surface reservations synchronously.
5. Rejects pending Git, Commit, file, terminal, or existing destructive ownership.
6. Runs dirty-file and Commit-draft confirmation before publication.
7. Publishes one `close-window` mutation through `commitDestroyedRemovals` with required publication.
8. Destroys file sessions, disposes singleton controllers, clears frame errors, and records launcher dismissal only after publication.
9. Leaves terminal sessions alive and unplaced.
10. Releases reservations in `finally` and repairs focus/route to the retained current surface.

Concurrent global/window-local opens check both surface and window reservations. A close operation that reserved a surface wins over a later reopen, preserving the existing close/reopen rule.

## Rendering design

### Component ownership

Replace the current workspace components with:

```text
WorkspaceRoot.svelte
├── WorkspaceWindow.svelte (one keyed instance per window)
│   ├── WorkspaceWindowTitleBar.svelte
│   │   ├── WorkspaceWindowTabStrip.svelte (all tab counts)
│   │   └── WorkspaceWindowMenu.svelte
│   └── active portable surface or ChatWindowPreview.svelte
├── LiveChatWindowLayer.svelte (exactly one mounted ChatSurface)
└── WorkspaceWindowResizer.svelte (one per partition)
```

`WorkspaceWindowTitleBar`, tab strip, and menu are separate components so the current 630-line `WorkspaceTaskBar.svelte` does not become a larger multi-responsibility component.

`WorkspaceRoot` preserves flat, keyed rendering:

```svelte
{#each geometry.windows as { windowNode, rect } (windowNode.id)}
	<WorkspaceWindow
		windowNode={windowNode}
		style={windowRectStyle(rect)}
		isCurrent={workspace.lastFocusedWindowId === windowNode.id}
		activeChatIsLive={liveChat?.windowId === windowNode.id}
	/>
{/each}

<LiveChatWindowLayer presentation={liveChat} />

{#each geometry.partitions as { partition, bounds } (partition.id)}
	<WorkspaceWindowResizer {partition} {bounds} />
{/each}
```

The live Chat layer is not inside the loop and has no `{#key}` block. `WorkspaceWindow` renders a preview placeholder beneath it when Chat is active. Topology changes alter absolute geometry, not surviving component identity.

### Title-bar skeleton

```svelte
<header
	data-workspace-window-titlebar={windowId}
	class="flex h-10 shrink-0 items-center border-b border-border/40 bg-workspace-window-titlebar px-1.5"
	class:bg-workspace-window-titlebar-active={isCurrent && windowCount > 1 && !isFullscreen}
	onfocusin={onFocusWindow}
	onpointerdown={onFocusWindow}
>
	<div class="min-w-0 flex-1">
		<WorkspaceWindowTabStrip {windowId} {tabs} {labelFor} {isCurrent} {isChatProcessing} />
	</div>

	<div class="flex shrink-0 items-center gap-0.5">
		{@render auxiliaryActions?.()}
		<WorkspaceWindowAddMenu {windowId} {tabs} />
		<WorkspaceWindowMenu {windowId} {tabs} />
		<button aria-label={fullscreenLabel} onclick={onToggleFullscreen}>...</button>
		{#if windowCount > 1}
			<button aria-label={m.workspace_close_window()} disabled={!canClose} onclick={onClose}>...</button>
		{/if}
	</div>
</header>
```

Buttons use semantic tokens, `focus-visible` rings, and at least 28×28 px desktop hit targets. The tab strip keeps `role="tablist"`, roving `tabindex`, `aria-selected`, `aria-controls`, Home/End/arrow navigation, context menus, and indexed DnD.

`WorkspaceWindowTitleBar` resolves Chat titles and activity from the descriptor’s `chatId`, not global `sessions.selectedChat`. It passes an ordinary typed `isChatProcessing(surfaceId)` callback to the keyed tab strip; invoking that callback in template evaluation tracks the rune-backed session registry without mirror state or `$effect`. Opening either menu in a background Chat window first makes that window current so additions and Current Chat actions operate on the correct record. `WorkspaceWindowAddMenu` owns additive commands; `WorkspaceWindowMenu` owns active-tab movement, overflow access, and surface actions.

### Left-aligned dynamic tabs

Retain `selectVisibleTaskbarSurfaceIds`, rename it to `selectVisibleWindowTabIds`, and replace symmetric centering capacity with direct left-rail capacity:

```ts
export function resolveWindowTabCapacity(input: {
	containerWidth: number;
	actionsWidth: number;
	auxiliaryWidth: number;
	gap: number;
	railChromeWidth: number;
}): number {
	return Math.max(
		0,
		input.containerWidth - input.actionsWidth - input.auxiliaryWidth - input.gap - input.railChromeWidth,
	);
}
```

One `ResizeObserver` per visible window observes the title bar, fixed action region, auxiliary region, measurement rail, and tab measurements. With at most four windows, this retains the current bounded cost.

## Unified drag-and-drop design

Create a root-owned `WorkspaceWindowDndController` in `web/src/lib/workspace/window-dnd.svelte.ts`, construct it in `createWorkspaceServices`, and expose it through a typed context. The sidebar and all workspace windows consume the same controller.

```ts
export type WorkspaceDragPayload =
	| {
			kind: 'surface-tab';
			surfaceId: string;
			sourceWindowId: WorkspaceWindowId;
			sourceIndex: number;
	  }
	| {
			kind: 'chat';
			chatId: string;
			source: 'chat-list';
	  };

export type WorkspaceDropTarget =
	| { kind: 'tab'; windowId: WorkspaceWindowId; index: number }
	| { kind: 'window-center'; windowId: WorkspaceWindowId }
	| {
			kind: 'new-window';
			targetWindowId: WorkspaceWindowId;
			edge: WorkspaceWindowEdge;
			blockedReason?: 'max-windows' | 'same-window';
	  };
```

Drop resolution matrix:

| Payload | Tab strip | Window body/center | Window edge |
| --- | --- | --- | --- |
| Surface tab, including Chat | Indexed reorder/move; occupied Chat destinations replace their Chat | Move and activate as a tab; occupied Chat destinations replace their Chat | Move into a new adjacent window |
| Sidebar chat | Root window overlay owns the event | Add or replace Chat in that exact window and activate it | Open a new adjacent Chat window at that edge |

The in-memory typed payload is authoritative. Native `DataTransfer` contains only an opaque application MIME marker, never chat IDs, project paths, titles, or surface IDs. Sidebar reorder data remains in Pragmatic DnD; its workspace bridge calls `beginChatDrag(chatId)` and does not reuse the Chat split store.

The controller commits topology only on drop. Drag enter/over updates presentation state; drag end, drop, Escape/inert transition, source unmount, and responsive transition clear it. Existing `ChatInteractionGate` becomes `WorkspaceInteractionGate` so any application drag is cancelled before a surface/frame transition makes its source inert.

## Focus, routing, and selection integration

`AppShell` remains the route/UI adapter. It coordinates layout publication, session selection, navigation, and composer focus without making the reducer depend on SvelteKit.

```ts
let chatNavigationGeneration = 0;

async function showChatInCurrentWindow(
	chatId: string,
	options: { navigate: boolean },
): Promise<void> {
	const generation = ++chatNavigationGeneration;
	await workspace.showChatInCurrentWindow(chatId);
	if (generation !== chatNavigationGeneration) return;
	sessions.setSelectedChatId(chatId);
	if (options.navigate && page.params.id !== chatId) await gotoChat(chatId);
	appShell.requestComposerFocus();
}
```

Route-to-layout and layout-to-route flows carry an origin or `navigate` option to avoid loops. Newer generations win when route changes, rapid sidebar clicks, or window focus overlap. The arbiter still serializes layout commits; the generation prevents an older completed intent from reclaiming route or composer focus.

Window activation of a Chat descriptor calls a sibling adapter that focuses the exact surface, then selects/navigates its `chatId`. Activating a non-Chat tab leaves `selectedChatId` at the most recently active chat, preserving current Chat-related context for “Add to chat” actions.

Chat deletion reconciliation:

- Clear every background descriptor referencing the deleted ID to `chatId: null`.
- If the current live descriptor referenced it and a neighbor exists, replace only that descriptor with the neighbor and navigate.
- Otherwise leave the current Chat view empty and navigate to `/`.
- Prune preview entries/cache using the existing deletion path.

## Accessibility

- Each window is `role="region"` with `aria-label="Window: <active title>"` and a stable `data-workspace-window-id`.
- The title bar uses semantic buttons; the title itself is not a fake draggable button.
- Each title bar uses one WAI-ARIA tab list with roving focus, linked tab/tabpanel IDs, arrow/Home/End navigation, and Enter/Space activation, even when it has one tab.
- Hidden tabs remain reachable from the active-tab actions menu.
- Fullscreen and Close Window have explicit accessible names and visible tooltips.
- Partition resizers retain `role="separator"`, orientation, min/max/current values, arrow-key resizing, double-click reset, and `focus-visible` styling. Labels become “Resize windows.”
- Every pointer DnD operation has a menu/keyboard equivalent. No operation silently changes meaning at the four-window cap.
- Drop overlays are transient status regions and do not become tab stops. Outcome text says “Open new window left/right/above/below,” never “split.”
- Chat previews remain keyboard focusable, identify their chat title, expose no inactive textarea, and activate the live composer on Enter/Space.
- Desktop title controls use adequate hit targets. Mobile/dialog form controls retain the repository’s 16 px minimum; this design adds no small touch form control.
- No new `svelte-ignore` is expected. Any unavoidable native-DnD suppression must include the repository-required rationale and follow-up reference.

## Performance and component identity

- Retain the four-window cap.
- Keep one mounted live `ConversationWorkspace`; do not instantiate one per window.
- Keep surviving `WorkspaceWindow` instances keyed by stable IDs in a flat geometry loop.
- Never key the live Chat layer by chat or window ID.
- Load preview transcripts only for visible background windows whose active tab is Chat. Reuse the shared `ChatTranscriptCache` and prune entries when no visible window references them.
- Give preview transcripts the full window body; draft editing remains exclusively in the one live composer and shared `ChatDraftStore`.
- Keep portable singleton renderer retention and frame-transfer logic; inactive ordinary file/terminal tabs need not render.
- Keep resize ratios in local preview state during pointer movement and publish one `set-partition-ratio` on pointer up.
- Limit each title bar to one `ResizeObserver`; disconnect on unmount.
- Avoid broad `$effect` synchronization. Derive geometry, active descriptors, titles, visible tabs, and drop presentation with `$derived`; use effects only for DOM observation, renderer transfer, routing, and preview loading.

## Failure modes and required behavior

| Failure | Required behavior |
| --- | --- |
| Destination window closes before a sidebar selection commits | Re-resolve to the latest current window inside the arbiter turn. |
| DnD target closes before drop | Reject/no-op, clear the overlay, and show a notification only if a committed user action fails. |
| Four-window cap reached | Disable new-window menu actions and block edge-drop previews; keep non-window-creating center drops available and never silently reinterpret an edge as center. |
| Exact sidebar Chat center-drop destination closes before commit | Revalidate the requested window in the arbiter turn, no-op without changing another window, clear the overlay, and report the failed committed action. |
| Dirty file or Commit drafts in a window being closed | Confirm before any publication; cancel atomically. Fullscreen is unaffected because it preserves every owner. |
| Pending mutation owns a surface | Disable/reject Close Window; fullscreen remains presentation-only. |
| Close races with reopen | Window/surface reservation wins; the later open no-ops or reports the existing blocked state. |
| Required close publishes but renderer cleanup fails | Keep the layout removal, log the degraded cleanup, notify, and never resurrect the closed window. |
| Local-storage write fails | Preserve in-memory state and use the existing persistent Retry notification. |
| Persisted Chat ID no longer exists | Set only that window Chat descriptor to `null`; keep topology and other tabs. |
| Chat is deleted in several windows | Clear every matching descriptor; select a neighbor only in the current live window. |
| Rapid chat/window switching overlaps | Latest navigation generation owns route, selection, focus, and composer request. |
| Native drag ends outside the app or source virtualizes away | Clear controller and sidebar preview state without a topology mutation. |
| Responsive transition begins during drag | Cancel the drag before inert/visibility changes. |
| Fullscreen target disappears before publication | Reject/no-op and keep the ordinary topology visible. |
| Cycle-window-focus runs during fullscreen | Keep the fullscreen window active; do not reveal or activate hidden windows. |
| Exit fullscreen | Reveal the chat list and unchanged prior window layout. |
| Chat move destination closes before commit | Resolve against the latest snapshot and no-op without deleting the source. |
| Chat moves onto a window that already has Chat | Replace only that destination presentation, activate it, and leave both chat records/drafts intact. |
| A Chat tab is dragged over the center of a window that already has Chat | Show localized “Replace existing chat,” then transfer and activate the source Chat without creating a second Chat descriptor. |
| A last tab moves into another window | Collapse the emptied source window atomically; preserve the destination and every surviving keyed window. |
| A focused source collapses during a tab move | Publish destination focus ownership before layout/route observers run so no transient fallback window can change the route or overwrite the moved Chat. |
| A one-tab Chat window becomes current | Keep the title bar and live-layer body boundary at the same fixed 40 px; never restore the retired 32 px non-tabbed-header offset. |
| Directional move targets a sole-tab Chat window | Disable the action in the UI and return the original reducer snapshot if invoked through a stale caller. |
| Chat session is absent or no longer processing | Render the ordinary Chat icon; never infer activity from active selection or preview state. |

## Security and privacy

- Persistence adds only opaque chat IDs, which are already present in chat routes and last-selection state. It does not persist transcript text, titles, project paths, prompts, or provider data.
- DnD uses an in-memory payload and opaque custom MIME marker. It does not place chat IDs or surface IDs in `text/plain`, avoiding accidental transfer to another application.
- No server request, authorization rule, workspace filesystem access, or cross-origin boundary changes.
- Window-local Chat duplication is presentation-only and does not duplicate server chat sessions or execution ownership.

## Alternatives considered

### Keep the Chat split tree inside one global Chat tab

Rejected. It preserves two topology, focus, resize, title-bar, DnD, and persistence systems. A chat still cannot target a Git or Terminal window, and chat-list selection remains globally coupled.

### Keep one movable `singleton:chat` surface

Rejected. One surface can occupy only one ownership bucket, so it cannot represent different chats in several windows or replace only the current window’s Chat view.

### Use one globally unique `chat:<chatId>` surface per chat

Rejected. Selecting a chat already visible elsewhere would require focusing that other window, moving it, swapping chats, or duplicating ownership. All conflict with the explicit “replace the chat in the current window” rule. Window-owned Chat view identities make replacement local and stable.

### Mount a complete Chat workspace in every Chat window

Rejected. Current composer, selection, transcript, permissions, queue, focus, and execution UI assume one live selected chat. Multiple heavy live workspaces would increase memory and reactive/network work and risk duplicate registrations. The current focused-workspace/background-preview model already solves this cleanly.

### Use a flat array or fixed grid of windows

Rejected. Mixed horizontal/vertical arrangements and nested resizers require parent relationships and ratios; a flat representation would recreate a tree indirectly. A stable-ID binary partition tree already works.

### Destroy other windows on fullscreen and reconstruct them on exit

Rejected. Destruction would dispose renderers, file sessions, singleton controllers, and terminal placements, making exact restoration depend on a second topology snapshot plus resource rehydration. A visibility-only projection preserves the authoritative topology and keyed instances directly.

### Allow closing the final window and render an empty desktop

Rejected for this scope. The current workspace assumes a non-empty root, mobile projection requires a fallback surface, and global selection expects a presentation destination. Disabling Close Window for the sole window preserves a simple invariant without weakening multi-window close behavior.

### Preserve old workspace and settings schemas

Rejected. This is a clean product-model cutover. Compatibility parsers and aliases would keep obsolete main/sidebar, pane, split-view, and new-pane concepts alive in current contracts and tests.

## Implementation plan

### Rename the domain model and establish window invariants

Change:

- `web/src/lib/workspace/surface-types.ts`
- `web/src/lib/workspace/pane-tree.ts` → `window-tree.ts`
- `web/src/lib/workspace/workspace-layout.svelte.ts`
- `web/src/lib/workspace/canonical-layout.ts`
- nearest unit tests

Introduce `WorkspaceWindowId`, `WorkspacePartitionId`, `WorkspaceWindowNode`, `WorkspacePartitionNode`, and Chat view descriptors. Rename traversal helpers (`collectWindowNodes`, `windowNodeById`, `windowIdOfSurface`, `insertWindowAtEdge`, `removeWindowAndCollapse`, `computeWindowRects`). Keep their immutable algorithms.

Replace the canonical Chat/Git/Pull Requests order with one `chat-view:window-main` tab. Add pure `set-window-chat`, `move-chat-to-window`, `move-tab-to-new-window`, `close-window`, and `set-fullscreen-window` reductions. Remove merge-pane and destructive fullscreen semantics.

Tests:

- Update `workspace-layout.test.ts` for the one-window canonical layout.
- Prove Chat replacement preserves surface ID, tab index, and component-facing ownership.
- Prove two window Chat descriptors may reference the same `chatId`.
- Reject two Chat descriptors in one window or a Chat descriptor whose ID does not match its window.
- Prove close removes rather than merges tabs, collapses the parent, and rejects the sole window or removal of the final Chat view.
- Prove fullscreen leaves the complete topology, descriptors, tab order/MRU, ratios, and terminal placements unchanged and exit reveals them exactly.
- Preserve cap, net-zero edge move, ratio clamp, MRU, ownership, revision, dialog, and terminal cases under new names.

Validation: `cd web && bunx vitest run src/lib/workspace/__tests__/workspace-layout.test.ts`.

### Rewrite current V2 persistence

Change:

- `common/workspace-layout.ts`
- `web/src/lib/workspace/layout-schema.ts`
- `web/src/lib/workspace/workspace-layout-persistence.ts` only if type names require it
- `web/src/lib/workspace/__tests__/layout-schema.test.ts`
- `web/src/lib/workspace/__tests__/workspace-layout-persistence.test.ts`

Serialize window/partition nodes and window-local Chat refs. Reconstruct Chat surface IDs from window IDs. Retain current sanitization, deduplication, MRU repair, cap collapse, and fallback behavior. Remove all older schema contracts and parsers.

Tests:

- Round-trip mixed-direction window topology with local tabs, MRU, ratios, two distinct Chat IDs, and duplicate chat references across windows.
- Restore `chatId: null`.
- Drop a second Chat ref in one window.
- Repair invalid active/MRU references and duplicate portable singleton/terminal refs.
- Prove absent data yields only one Chat window.
- Prove fullscreen, files, focus, dialog, and mobile data are not serialized.
- Prove malformed or unsupported current input falls back atomically.

Validation: `cd web && bunx vitest run src/lib/workspace/__tests__/layout-schema.test.ts src/lib/workspace/__tests__/workspace-layout-persistence.test.ts`.

### Add window-aware coordination and close-only destruction

Change:

- `web/src/lib/workspace/workspace-coordinator.svelte.ts`
- `web/src/lib/workspace/workspace-presentation-controller.svelte.ts`
- new `web/src/lib/workspace/workspace-window-destruction-service.ts`
- `web/src/lib/workspace/visible-presentations.ts`
- `web/src/lib/workspace/workspace-transition-arbiter.ts` only if a typed return hook is needed
- terminal, file-dialog, file-placement, singleton, and frame adapters

Rename pane APIs to window intents. Add window reservations, local Chat replacement, new-window opens, guarded window close, and presentation-only fullscreen. Reuse `commitDestroyedRemovals`, surface reservations, exact frame expectations, required publication, and post-publication disposal only for actual close operations.

Tests in `workspace-coordinator.test.ts`:

- Sidebar/current-window Chat replacement against the latest snapshot.
- Chat insertion into a Git-only current window.
- Current-window fallback after a concurrent close.
- Global new-window versus window-local tab placement.
- Singleton uniqueness under both paths.
- Close Window lifecycle for Chat, Terminal, file, Commit, launcher, and singleton tabs.
- Atomic cancellation for dirty files and Commit drafts.
- Pending mutation and concurrent close/reopen reservations.
- Fullscreen hides other windows without destructive confirmation or disposal, restores the exact topology on exit, and clears when opening a new window.
- Required-removal persistence/frame failure behavior.
- Focus fallback and current-window cycling.
- A move that collapses its focused source exposes the destination as current inside `onLayoutChanged`, before the post-commit DOM focus request.

Validation: `cd web && bunx vitest run src/lib/workspace/__tests__/workspace-coordinator.test.ts src/lib/workspace/__tests__/visible-presentations.test.ts`.

### Make Chat selection window-local while retaining global active selection

Change:

- `web/src/lib/components/layout/AppShell.svelte`
- `web/src/lib/components/layout/app-shell-route.ts`
- `web/src/lib/workspace/workspace-domain-bindings.svelte.ts`
- `web/src/lib/chat/sessions/chat-sessions.svelte.ts` only if a narrow reconciliation method is needed
- AppShell and route tests

Route all sidebar, adjacent, route, new-chat, fork, handoff, and deletion selections through `showChatInCurrentWindow`. Add a latest-wins navigation generation. Keep `selectedChatId` synchronized to the focused live Chat descriptor after successful layout publication. Reconcile missing/deleted persisted Chat IDs.

Tests:

- Selecting B replaces A only in the current window and navigates once.
- Chat-list focus preserves the previous current window.
- Rapid A/B/C selections leave C in layout, session selection, route, and composer focus.
- Direct route navigation replaces current window Chat without a navigation loop.
- Focusing another Chat window updates global selection and route.
- Selecting a non-Chat tab does not clear last active Chat selection.
- Deleting a chat clears all matching background descriptors and chooses a neighbor only in the live current window.

Validation: `cd web && bunx vitest run src/lib/components/layout/__tests__/AppShell.test.ts src/lib/components/layout/__tests__/app-shell-route.logic.test.ts`.

### Build the unified title bar and window renderer

Change:

- `WorkspacePane.svelte` → `WorkspaceWindow.svelte`
- `WorkspaceTaskBar.svelte` → focused title-bar/tab-strip/menu components
- `WorkspacePaneResizer.svelte` → `WorkspaceWindowResizer.svelte`
- `WorkspaceRoot.svelte`
- `workspace-root-state.svelte.ts`
- `workspace-taskbar-layout.ts` → `workspace-window-tab-layout.ts`
- `PortableSurfaceFrame.svelte` and surface style/inset helpers

Render one in-flow title bar and tab strip per keyed window, including one-tab windows. Use natural label widths while they fit, then truncate, then use icon-only tabs, and only then overflow tabs into the actions menu. Replace each processing Chat icon from the per-chat session registry, including inactive/background tabs. Keep the sole selected trigger transparent in a one-tab window; apply current/inactive selected-tab tokens only when several tabs need selection contrast. Keep direct `+` add-menu, active-tab actions-menu, and fullscreen fixed right; show Close Window there only when several windows exist. Draw one-pixel partition separators. Use dedicated sharp title-bar and selected-tab tokens with a visibly muted inactive-window treatment; remove the focused-window border overlay and token entirely. Move active portable content into the body with no floating top inset. Keep geometry and resizers absolute and stable.

Tests:

- Replace `WorkspaceTaskBar.test.ts` with focused title-bar, tab-strip, and menu suites.
- One title bar per window; no root/global tab list.
- One or many tabs use the same 40 px left tablist.
- Focusing an inactive one-tab Chat keeps the title bar at 40 px and aligns the live Chat body immediately below it without overlap.
- Full, truncated, icon-only, and overflow tab tiers preserve active-tab and menu access.
- Every window has direct add/actions/fullscreen controls. Close Window is absent for a sole window and disabled for a multi-window final-Chat owner.
- The `+` menu opens tabs and terminals in its exact window; its eligible portable-view commands stay in canonical order as one localized group before Open terminals, including singletons placed in other windows. The actions menu contains no additive commands.
- The actions menu starts with indexed reorder, eligible cross-window movement, four directional move-to-new-window actions, and neutral Close Tab, followed by a separator and current-tab actions.
- Tab context actions use window language and preserve movement/new-window parity with the actions menu; Chat tabs expose all eligible existing-window destinations and directional true-move actions.
- Chat tabs are native drag sources. Center and indexed drops receive or replace Chat as required, occupied-center previews use the localized replacement label, edge drops move into new windows, and moving the final source tab collapses its window.
- Processing Chat tabs replace the ordinary icon in full-label, truncated, icon-only, and background-window states; the inert measurement rail keeps stable dimensions without duplicating animation or status semantics.
- Light, dark, and inherited colorblind themes expose the specified computed active/inactive title-bar and multi-tab selected-tab contrast values; a sole selected tab has no selected background, and no focused-window overlay or token exists.
- Root keeps surviving windows mounted across close/repartition.
- Fullscreen keeps every keyed window mounted and inertly hidden, then reveals the same instances on exit.
- Resizer pointer/keyboard behavior and one-pixel horizontal/vertical separators remain.
- Pointer/focus changes update title-bar and multi-tab selected-tab treatment without moving layout or rendering a focused-window border; one-tab triggers remain background-transparent.

Validation: `cd web && bunx vitest run src/lib/components/workspace/__tests__`.

### Move Chat previews under universal windows

Change:

- `web/src/lib/components/chat/ChatSurface.svelte`
- extract `web/src/lib/components/chat/ChatWindowPreview.svelte`
- rename/rehome the preview store and text-scale modules under `web/src/lib/chat/`
- `WorkspaceRoot.svelte` and `WorkspaceWindow.svelte`
- remove Chat split-specific components after parity

Strip nested topology and DnD from `ChatSurface`. Render it once in `LiveChatWindowLayer`. Adapt only the current `ChatPane` transcript preview body for non-focused visible Chat windows and delete the pane-era compact preview composer. Resolve every preview and title from its explicit descriptor `chatId`.

Tests:

- One and only one `ConversationWorkspace` remains mounted across Chat window focus changes, tab changes, close, and repartition.
- Background windows show the correct full-height transcript, title, status, and unread indicator with no textarea or composer.
- Preview pointer down focuses the Chat window and does not double-focus on click.
- Drafts remain owned by the shared store/live composer, and drafts plus scroll position survive rapid Chat window switching.
- Hidden Chat tabs do not load/render previews.
- Preview cache pruning and deletion behavior remain covered by the renamed preview-store suite.
- Mobile Chat toolbar and menu tests remain green.

Validation: run the Chat window component tests and the renamed preview-store tests.

### Unify sidebar chat and tab DnD

Change:

- `pane-dnd.svelte.ts` → `window-dnd.svelte.ts`
- `split-drop-geometry.ts` → `window-drop-geometry.ts`
- `SidebarVirtualSortableChatList.svelte`
- `sidebar-pragmatic-dnd.ts`
- `WorkspaceWindow.svelte`, tab strip, and root services/context
- DnD tests

Construct one controller in `createWorkspaceServices`, register it through typed context, and bridge sidebar drag start/end without coupling to Chat rendering. Give each window a root-level overlay that accepts Chat drops regardless of active content. Preserve sidebar reorder behavior and virtualized-source cleanup.

Tests:

- Chat payload maps the central region to exact-window add/replace and the four edge regions to new adjacent windows.
- The same drag targets Chat, Git, Files, file, Commit, Pull Requests, and Terminal windows.
- Chat center over a Chat-less destination says localized “Add as tab”; an occupied destination says localized “Replace existing chat.”
- Four-window cap blocks Chat edge targets but leaves its center target available.
- Exact-window Chat center drops publish the destination as current before layout/route observers and no-op if that destination disappears before commit.
- Surface tab strip, center, edge, same-window, and net-zero cap cases remain.
- Chat surface-tab payloads cover indexed receive/replace, center receive/replace, edge movement, last-tab source collapse, and derived surface-ID repair.
- Cancel, drag end outside app, virtualization unmount, inert transition, and responsive transition clear all state.
- Sidebar recent-sort drag can open a workspace window without enabling reorder.
- DnD data transfer does not contain a chat or surface ID.
- Sidebar chat context commands provide keyboard-equivalent placement.

Validation: run window DnD, sidebar pragmatic DnD, and virtual sidebar component suites.

### Remove the obsolete split system and finish terminology

Delete after replacements are green:

- `web/src/lib/chat/split/split-layout.svelte.ts`
- `web/src/lib/chat/split/chat-split-actions.ts`
- `web/src/lib/components/split/SplitContainer.svelte`
- Chat-specific `SplitResizer.svelte`
- old `ChatPane.svelte` after preview extraction
- `web/src/lib/components/chat/split-drop-controller.svelte.ts`
- split-layout context creation/get/set calls
- obsolete split tests and fixtures

Rename:

- Remove the sidebar `WorkspaceNewWindowActions` contract and its Search-adjacent New Window control; retain direct command-palette coordinator actions and each window’s `+` menu.
- pane focus shortcut API/label → cycle window focus.
- file placement values/UI → Same window, New window, Dialog.
- all `workspace_pane_*`, `workspace_split_*`, `chat_pane_*`, and `layout_resize_panes` messages to window equivalents.
- `data-workspace-pane-*` selectors and test helpers to `data-workspace-window-*`.

Retain the persisted left/right `chatListDock` setting. Regenerate Paraglide after message changes:

```sh
cd web
bun run i18n:compile
```

Run `rg -n "pane|split view|split pane" web/src web/messages integration-tests` and classify every survivor. Only unrelated domain terms may remain.

### Replace browser-level coverage

Replace stale host-era E2E coverage rather than adapting its old expectations:

- Replace `integration-tests/tests/e2e/workspace-host-fullscreen.test.ts` with `workspace-window-fullscreen.test.ts` proving other windows become hidden/inert without resource disposal, chat list hides, exit restores exact topology and keyed instances, and reload during fullscreen restores the ordinary persisted topology with fullscreen off.
- Replace `desktop-layout-order.test.ts` with `chat-list-dock.test.ts` proving left/right docking and reload persistence.
- Add `workspace-windows.test.ts` covering command-palette new-window opens, window-local tabs, Chat moves into empty/occupied destinations, directional Chat moves, sidebar Chat center add/replace and edge-copy behavior, absence of the sidebar New Window control, chat drag onto a non-Chat window, tab overflow, close, resize, reload, route/focus, and draft preservation.
- Update `git-view-surfaces.test.ts`, `file-viewer-scrolling.test.ts`, `multi-chat.test.ts`, and driver helpers for window selectors and local menus.

Lightpanda covers state and DOM contracts. Run the native DnD and pointer-resize workflow in the configured Chromium integration tier because synthetic DOM events do not prove browser drag behavior.

## Test plan

### Unit and component gates

Run focused tests during each implementation item, then:

```sh
cd web
bun run i18n:compile
bun run check
bun run lint
bun run test
```

Expected result: zero Svelte diagnostics, zero lint warnings, and all web Vitest projects passing.

### Repository gates

From the repository root:

```sh
bun run check
bun run test
bun run build
timeout 30s bun run start --port 0
```

Expected result: root lint/type checks pass, server/CLI/web tests pass, the production web build succeeds without a new actionable chunk warning, and a new isolated server binds on `0.0.0.0` at an allocated port before timeout.

### Integration gates

```sh
bun run test:integration:e2e
bun run test:integration:chromium
```

No live-provider suite is required because the change does not alter provider behavior. Existing scripted server integration coverage remains part of `bun run test`.

### Manual desktop verification

Use a new isolated server and verify at 1440×900 and a narrow desktop width:

- Dock chat list left, then right; resize it on each side.
- Open Git from the command palette and confirm a new window; open Git Compare from that window and confirm a local tab. Confirm the sidebar has no New Window control beside Search.
- Confirm each title bar always has a draggable tab strip plus a `+` menu for adding tabs/terminals and a separate three-dots menu for active-tab actions; neither menu contains the other’s commands. Confirm a sole window has no Close Window `X`.
- Focus an inactive one-tab Chat window and confirm its 40 px bar does not shrink or become covered when the live Chat workspace moves into it.
- Confirm a one-tab window never paints a selected-tab background behind its sole title in either current or inactive state; after adding a second tab, confirm selected current/inactive backgrounds return.
- In a window whose portable views are both absent and placed in other windows, confirm the `+` menu keeps all eligible Open views entries together in `Git Workbench → Git History → Git Compare → Pull Requests → Files → Commit` order before Open terminals.
- Confirm the three-dots menu starts with Move Tab Left/Right, eligible Move to Window entries, Move to New Window Left/Right/Above/Below, and neutral Close Tab, then a separator and current-tab actions; right-click the tab and confirm exact parity.
- Open tabs with long and short labels; confirm natural widths are used while they fit, then labels truncate, then tabs become icon-only, and finally overflowed tabs remain in the menu.
- Focus window A, focus the chat list, select chat B; only A’s Chat view changes.
- Focus window B and repeat; A remains unchanged.
- Move a Chat tab to a window without Chat and confirm the source presentation disappears, the destination receives/focuses it, and an emptied source window collapses. Repeat onto a window with Chat and confirm the destination presentation is replaced without deleting either chat record.
- Drag a Chat tab onto a Chat-less center and tab position, then onto a Chat-occupied center. Confirm the occupied preview says localized “Replace existing chat,” the source Chat disappears, the destination replaces/focuses it, and dragging the last source tab collapses that window.
- Drag a sidebar chat onto the center of a Chat-less window and confirm localized “Add as tab,” exact-window activation, and no new window. Repeat over a Chat-occupied window and confirm localized “Replace existing chat.” Repeat both at the four-window cap, then confirm edge drops remain blocked with “4 windows max.”
- Confirm a sole-tab Chat has no directional movement, an empty Chat has no cross-window movement, and sidebar Chat “Open in New Window” still copies.
- Hold one foreground and one background Chat in processing states; confirm each visible tab replaces its Chat icon with the semantic-blue pulse, then restores the icon when processing ends. Verify reduced motion and a missing-session fallback.
- Confirm no active-window border appears with one window, several windows, or fullscreen. Verify that inactive title bars and selected tabs in multi-tab windows use the distinct muted light, dark, and inherited colorblind token values while the current window retains the stronger active treatment; verify one-tab triggers stay transparent.
- Drag a chat onto Chat, Git, Files, Terminal, and file windows at all four edges.
- At four windows, confirm blocked new-window overlays and disabled menu commands while center add/replace drops remain available.
- Move/reorder tabs by pointer and keyboard-equivalent menu actions.
- Resize nested horizontal and vertical partitions by pointer and keyboard.
- Type a Chat draft, switch rapidly among Chat windows and non-Chat tabs, and verify no focus, draft, or scroll jump.
- Confirm every non-focused Chat window uses its entire body for the transcript and contains no fake composer or textarea.
- Enter fullscreen with three windows; confirm the other two are hidden and inert. Exit; confirm the same windows, tabs, active IDs, MRU, ratios, drafts, and resources return with the chat list.
- Enter fullscreen with a dirty file and retained Commit draft in another window; confirm no destructive prompt appears and both remain intact after exit.
- Reload while fullscreen; confirm the ordinary persisted multi-window topology returns with fullscreen off.
- Close a Terminal window; reopen the same unplaced terminal session.
- Reload and verify window topology, tabs, chat IDs, ratios, chat-list dock, and terminal placement.
- Switch through the mobile breakpoint and back; confirm the last-focused desktop window and Chat selection remain coherent.
- Confirm no browser-console errors, duplicate frame attachments, or stale drop overlays.

## Rollout

No feature flag or server data change is required. Implement in the ordered stages above and keep each stage internally green. Do not merge an intermediate state that has both universal Chat windows and the old Chat split UI exposed. Earlier local workspace and setting values are intentionally ignored; affected clients start with canonical window defaults without affecting chat or server data.

## Resolved decisions

- Product term: window. Code term: `WorkspaceWindow`; browser `Window` remains unshadowed.
- Binary branches remain only as internal partitions.
- Tabs are stored and rendered only on window leaves.
- Canonical first run is one Chat window, not a preloaded Chat/Git/Pull Requests tab list.
- Four visible desktop windows remain the limit.
- Chat selection replaces or adds the stable Chat view in the current window.
- The same chat may be presented in several windows; each presentation has a window-owned surface ID.
- Chat click replaces in the current window. A sidebar Chat center drop adds or replaces Chat in the exact target window, while an edge drop opens a new adjacent window.
- A sidebar Chat drag has one center add/replace outcome and four new-window edge outcomes. At the cap, only the edges are blocked.
- Generic surface center drop adds a tab; generic edge drop opens a new window.
- One live Chat workspace remains mounted; other active Chat windows are transcript-only previews with no composer.
- Every desktop window always has one in-flow title bar.
- Every title bar uses the same draggable tab strip, including one-tab windows, with natural-width, truncated, icon-only, then overflow tiers.
- Adjacent windows share one-pixel separators. Dedicated title-bar tokens use a lighter inactive and darker active value in both light and dark themes, while selected tabs in multi-tab windows use separate current-window and muted inactive-window tokens with inherited colorblind parity. A sole tab has no selected background. No active-window border or focus-ring overlay renders.
- A `+` add menu, active-tab actions menu, and fullscreen are direct controls for every window. Close Window appears only when at least two windows exist.
- The `+` menu owns window-local additions and keeps every eligible portable view in canonical order under a localized Open views group before Open terminals, including views placed in other windows. The actions menu begins with Move Tab Left/Right, eligible Move to Window entries, Move to New Window Left/Right/Above/Below, and neutral Close Tab, then a separator and current-tab actions. The tab context menu matches this ordering.
- Close Window destroys local tabs and never merges them.
- The sole window and the window owning the final Chat view cannot close.
- Non-empty Chat tabs expose every other window as a move destination. Moving into a Chat-less window installs and focuses the source Chat; moving into a window with Chat replaces and focuses its presentation. The source presentation is removed in both cases.
- Non-empty Chat tabs use the same native drag affordances as other movable tabs. Center and indexed drops receive or replace the destination Chat, occupied centers say localized “Replace existing chat,” edge drops move into a new window, and an emptied source window collapses atomically.
- Chat directional tab actions are true moves. Empty Chat views and sole-tab directional cases do not expose them; the reducer preserves identity for stale sole-tab attempts. Sidebar Chat edge-drag/context actions remain explicit copy operations, while center drops add or replace the exact destination presentation.
- Processing Chat tabs replace their ordinary icon with the existing pulsing semantic-blue status indicator regardless of active tab/window; session activity comes from the root registry and respects reduced motion.
- The sidebar has no Search-adjacent New Window button. Global open commands remain in the command palette, and every workspace window retains its local `+` menu.
- Fullscreen hides other windows without changing topology or resource ownership; exit restores the same keyed layout.
- Window-focus cycling is inert during fullscreen.
- Fullscreen state is transient and omitted from persistence; ordinary topology continues to persist unchanged.
- Chat-list dock left/right remains a Local Settings option.
- Mobile remains a one-surface projection.
- Only the current window-based V2 schema is supported.

## Deferred risks

- Whole-window title-bar drag/reordering is intentionally deferred. The unblock condition is a separate product specification for whether dragging moves, swaps, or repartitions complete windows.
- The four-window cap may be revisited only after profiling preview, renderer, terminal, and title-bar observer cost above four windows.
- Lightpanda cannot independently prove every native DnD and pointer-capture behavior; Chromium integration and the manual matrix remain required merge evidence.
- Persisting several chat IDs increases local layout metadata compared with one last-selected ID. No content is persisted, but privacy review should confirm this remains acceptable under the existing local-storage policy.

No unresolved product or architecture decision blocks implementation of this design.
