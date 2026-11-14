# New chat landing screen

New Chat opens a full-page start screen with pinned and recent project folders above the
existing composer. Each project card shows its folder name and full path, with
executor labels when multiple machines are represented. Selecting a card selects
both its executor and path without clearing the prompt or starting a chat.

Project cards reuse the existing executor-qualified pinned and recent paths. Pinned
folders appear first; recent folders retain their recorded order. Duplicate drive-letter
Windows paths with different slash styles appear once, retaining the pinned spelling.
POSIX backslashes and exact whitespace remain significant. The path field
and its pin button remain available for browsing, editing and saving folders.
This change does not introduce environment presets or change stored settings,
execution admission, provider configuration, HTTP or WebSocket contracts.

The existing NewChatDialog remains the owner of open/close, focus containment,
ticket prefills, draft creation and navigation. Its presentation fills the
available viewport and returns to the previous workspace on Close or Escape.
The form, prompt editor, model selector and worktree picker retain their owners.
The landing page scrolls within the keyboard-adjusted viewport on mobile.

Project cards remain visible when their executor is offline or removed, show the
existing availability status, and cannot select unavailable targets. Card identity
includes the executor and path; identical paths on different machines remain
distinct. The New Chat projects controller owns selection and readiness checks for both lists.

Validation covers retained drafts, Local/remote identity, offline/live pin updates,
keyboard submission, close/reopen, nested dialogs, and narrow/wide layouts.
