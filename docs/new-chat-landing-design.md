# New chat landing screen

An empty workspace opens New Chat after its chat list loads successfully, without
requiring a click through the empty-chat placeholder. Closing the screen stays
closed for that empty period; an existing chat or draft rearms the behavior for
when the last chat is later removed. Explicit chat and ticket destinations and
other active dialogs retain priority. Loading and failed lists do not trigger it.

New Chat opens a full-page start screen with pinned and recent project folders above the
existing composer. Compact project cards use one column within a narrow content
area. Each card shows its folder name and a truncated path, with full paths on hover and
executor labels when multiple machines are represented. Selecting a card selects
both its executor and path without clearing the prompt or starting a chat.
Each card has its own pin toggle on the right. Selection uses highlighting without
a checkmark, and pinning a card preserves the selected project and prompt.
The pin uses the same icon in both states: faded when unpinned, fully visible and
rotated 45 degrees when pinned. Action labels remain Pin and Unpin.

Project cards reuse the existing executor-qualified pinned and recent paths. Pinned
folders appear first; recent folders retain their recorded order. Duplicate drive-letter
Windows paths with different slash styles appear once, retaining the pinned spelling.
POSIX backslashes and exact whitespace remain significant. A selectable worktree
list replaces the permanent directory text field. It lists worktrees for the selected
project on its owning executor, including the primary checkout. Worktrees use smaller,
flat rows with titles on the left and muted, root-abbreviated paths such as
`…/garcon-ui` on the right. Full paths remain in hover titles and accessible labels.
Selecting a row changes the new chat's target without clearing its prompt.
A Choose folder button reveals a manual path field and Garcon's executor-owned
folder browser. Each opening lists the configured project root's subfolders;
opening the browser alone does not change the selected project. Users can navigate
folders or paste a full directory path. The existing field validation applies to
manual paths, and Enter validates without starting a session. Desktop navigation
selects the entered folder; mobile navigation requires Select this directory.
Closing the browser leaves the path field available. Worktree selection uses the
inline list without a separate picker button. Ordinary non-Git folders remain usable.
The desktop dropdown includes a bottom check button that closes browsing without
changing the current path, including while its listing loads or reports an error.
Clicking outside also closes it. Mobile retains explicit directory confirmation.
Mobile also offers Enter path directly, without opening the full-screen browser.
Typing retains the existing debounced validation and shows path errors even when
the executor cannot provide Git services.
This replaces the unsuccessful native-dialog attempt; no OS dialog is requested.
This change does not introduce environment presets or change stored settings,
execution admission, provider configuration, HTTP or WebSocket contracts.

The existing NewChatDialog remains the owner of open/close, focus containment,
ticket prefills, draft creation and navigation. Its presentation fills the
available viewport and returns to the previous workspace on Close or Escape.
The form, prompt editor and model selector retain their owners. The preamble summary
uses an add button to open selection and only shows Clear when a preamble will apply.
The landing page scrolls within the keyboard-adjusted viewport on mobile.

Worktree discovery uses the existing executor-qualified Git API. Loading, empty,
error/retry, missing-path and offline states remain explicit. Target changes cancel
and fence old requests; results from a different project, executor or connection
generation cannot populate or select the current list. Worktree selection reuses
the same path validation and admission gates as every other submit path.

Project cards remain visible when their executor is offline or removed, show the
existing availability status, and cannot select unavailable targets. Card identity
includes the executor and path; identical paths on different machines remain
distinct. The New Chat projects controller owns selection and readiness checks for both lists.

Validation covers retained drafts, Local/remote identity, offline/live pin updates,
worktree discovery/selection, stale responses, keyboard submission, close/reopen,
nested dialogs, and narrow/wide layouts.
