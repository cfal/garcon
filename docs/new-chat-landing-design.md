# New chat landing screen

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
A Choose folder button requests the selected executor's system folder dialog. Worktree selection
uses the inline list without a separate picker button.
Ordinary folders remain usable when they are not Git repositories.
The executor owns the dialog and returns a full, validated directory path within
its configured filesystem boundary. Windows uses its system folder dialog, macOS
uses Finder selection, and Linux uses Zenity or KDialog when a desktop is available.
Headless executors retain Garcon's folder browser. Cancellation keeps the current
selection; dialog failures offer explicit browsing. No automatic retries reopen a
dialog. The pending request is cancelled or fenced when its project, executor,
connection generation or owning screen changes.
Equivalent executor snapshots and unrelated Git capability updates do not cancel
folder selection. Its stable context includes only the selected executor's path
identity, Files readiness and bulk-lane availability.
This change adds a typed POST `/api/v1/files/select-directory` endpoint and the
bulk, session-scoped `files.chooseDirectory` executor operation. Protocol revision
44 prevents mixed builds. CLI forwarding does not allow this browser interaction.
It does not introduce environment presets or change stored settings, execution
admission or provider configuration.

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
