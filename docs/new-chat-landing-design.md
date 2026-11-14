# New chat landing screen

New Chat opens a full-page start screen with pinned and recent project folders above the
existing composer. Compact project cards use one column within a narrow content
area. Each card shows its folder name and a truncated path, with full paths on hover and
executor labels when multiple machines are represented. Selecting a card selects
both its executor and path without clearing the prompt or starting a chat.

Project cards reuse the existing executor-qualified pinned and recent paths. Pinned
folders appear first; recent folders retain their recorded order. Duplicate drive-letter
Windows paths with different slash styles appear once, retaining the pinned spelling.
POSIX backslashes and exact whitespace remain significant. A selectable worktree
list replaces the permanent directory text field. It lists worktrees for the selected
project on its owning executor, including the primary checkout. Worktrees use smaller,
flat title-only rows with full-path hover titles and accessible path labels.
Selecting a row changes the new chat's target without clearing its prompt.
A Choose folder button retains executor-owned folder browsing, and pinning remains available.
Ordinary folders remain usable when they are not Git repositories.
Browser folder handles do not expose the absolute executor path required to start a
chat. Native Explorer/Finder selection requires a separate desktop integration that
can establish whether the selected folder belongs to the chosen executor.
This change does not introduce environment presets or change stored settings,
execution admission, provider configuration, HTTP or WebSocket contracts.

The existing NewChatDialog remains the owner of open/close, focus containment,
ticket prefills, draft creation and navigation. Its presentation fills the
available viewport and returns to the previous workspace on Close or Escape.
The form, prompt editor, model selector and worktree management dialog retain their owners.
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
