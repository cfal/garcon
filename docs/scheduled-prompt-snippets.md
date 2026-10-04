# Snippets in scheduled prompts

Use **Insert Snippet** or the configured inline trigger (default `;;`) in either
scheduled prompt editor. The shared picker includes saved snippets and named
preambles, and offers saved default arguments for snippets that use them.

Insertion saves editable text rather than a reference to the snippet. Arguments
and the authoritative project path are expanded during insertion. Active
`{{chat_id}}` tokens resolve to the destination chat when each scheduled run
executes; escaped tokens remain literal. Token-shaped argument and project-path
values remain literal across both expansion phases. Later catalog changes do not
rewrite saved schedules.

The snippet expansion API accepts a `scheduled-prompt` context with a `chat`
target (registered chat ID) or a `new-chat` target (project path and optional
executor ID). New-chat scheduling does not allocate a chat ID during insertion.
Existing chat expansion continues to resolve its path and executor from the
controller registry. Closing the editor or changing its target cancels pending
expansion, and both button and keyboard saving wait for expansion to finish.
