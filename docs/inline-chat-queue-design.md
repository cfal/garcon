# Inline chat queue

Queued messages remain visible above the composer, with drag ordering, per-message
and full-list expansion, a direct edit button, and a Steer button on every text
message while the current provider supports steering. Mobile rows place actions
below the message to preserve its reading width. Remove and Send now belong in
the overflow menu; Send now retains its existing first-entry behavior.

The queue identifies its next entry, explains that follow-ups run after the active
turn, and names Expand all and Collapse all explicitly. Touch controls have 44px
targets. The pencil opens only the selected message in a desktop side drawer or
full-screen mobile editor; Save closes it and returns to the chat. The editor
retains its textarea, focus, and draft when the message departs or changes
elsewhere, with the existing conflict and queue-as-new recovery actions. Queue
ordering, deletion, and pause controls live only in the inline queue.

The public Codex CLI distinguishes pending steers from queued follow-ups and
keeps both visible above the composer. Its pending preview explains that guidance
waits for the next tool/result boundary and keeps editing separate from delivery:
[pending input preview](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/tui/src/bottom_pane/pending_input_preview.rs#L14-L22).
Its [preview rendering](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/tui/src/bottom_pane/pending_input_preview.rs#L98-L175)
shows pending guidance before ordinary follow-ups. Garcon adapts that distinction
to explicit per-message buttons and a visible Waiting to steer status.

The controller owns message selection and delivery:

- An explicit Steer selects any queued entry by its stable ID, guarded by its
  content revision and the observed queue order revision. Successful delivery
  consumes only that entry. A definite rejection restores its queued status in
  the same position; an uncertain delivery retains the existing consume and
  reconciliation behavior.
- If the active turn cannot take guidance, or another steer is pending, the
  selected entry becomes a pending steer after the last existing pending steer,
  or before queued turns when no steer is pending. A steer dragged below a
  follow-up keeps that position when newer guidance is added. Moving the selected
  entry increments the order revision. Other follow-ups
  retain their relative order, and the input keeps its submission identity.
- Automatic delivery still selects only the first entry and observes queue
  pause. An explicit ready Steer retains its existing ability to act while the
  follow-up queue is paused.
- Messages with attachments retain the disabled Steer action and its explanation.
  Unsupported providers do not expose it. Pending steers show their waiting
  status instead of offering duplicate submission.

The existing HTTP request/response shapes and executor messages remain unchanged.
No queue persistence, transport retry, or provider-specific client behavior is
introduced. The transcript boundary remains governed by
[transcript-ledger-v5-design.md](transcript-ledger-v5-design.md#71-the-queuetranscript-boundary).

Verification covers selected middle/tail entries, original-order recovery on
rejection, revision conflicts, pending-steer ordering, delayed provider readiness,
exactly-once submission, Local and both remote executor directions, and desktop
and mobile layout, including long queues and rapid chat switches.
