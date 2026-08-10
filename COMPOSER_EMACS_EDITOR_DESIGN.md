# Composer Emacs Editor Design

## Document Status

- Status: Approved for implementation
- Repository: `/garcon/.worktrees/fix-hotkeys`
- Branch: `composer-emacs-editor`
- Base commit: `ce525b752a69d31cb403e084be23b9e6881e571f`
- Product area: Chat composer and workspace shortcuts
- Last researched: 2026-08-10

`AGENTS.md` is normative for implementation. There is no earlier design document for this feature.

## Summary

Garcon will add a composer-only expanded text editor backed by the CodeMirror 6 packages already in the dependency graph. The compact textarea remains the primary composer surface. Users can open the expanded editor from an icon button or the configurable `Ctrl+Shift+E` workspace shortcut.

The expanded editor is an ephemeral projection of the existing `ComposerState`. Every document change is synchronized to that state and its existing draft persistence path. Closing through Escape, the backdrop, or the close button therefore preserves the draft without an Apply or Cancel buffer.

The editor provides a deliberately small Emacs-style keymap:

| Command                              | Movement | Selection                           |
| ------------------------------------ | -------- | ----------------------------------- |
| Beginning of line                    | `Ctrl+A` | `Ctrl+Shift+A`                      |
| End of line                          | `Ctrl+E` | `Ctrl+Shift+E`                      |
| Previous visual line                 | `Ctrl+P` | `Ctrl+Shift+P`                      |
| Next visual line                     | `Ctrl+N` | `Ctrl+Shift+N`                      |
| Delete selection or through line end | `Ctrl+K` | Existing selection is deleted first |

The full Emacs mode, mark mode, kill ring, yank behavior, and unrelated chords are intentionally excluded. `Ctrl+U` and `Ctrl+D` keep Garcon's half-page scrolling behavior, scoped to the editor dialog while it is the top modal.

## Problem Statement

Native browser text controls do not provide consistent Emacs navigation across browsers and operating systems. Rewriting key events for every input would make ordinary settings fields surprising and would conflict with Garcon's workspace shortcut dispatcher.

The composer is the high-value editing surface where longer multiline prompts benefit from editor navigation. CodeMirror is already used by Garcon and provides portable visual-line movement, selection, deletion, history, and viewport rendering. The feature should reuse it without replacing the compact composer or creating another draft owner.

Two conflicts require explicit coordination:

- The workspace dispatcher listens at `window` in the capture phase and currently consumes some of the requested chords before CodeMirror receives them.
- Half-page scrolling must target the CodeMirror scroller in the top dialog and never the conversation feed behind that dialog.

## Goals

- Add a large, accessible, composer-only editor for long prompt text.
- Keep `ComposerState` as the sole owner of text and draft persistence.
- Synchronize CodeMirror changes into the compact composer on every document transaction.
- Synchronize external composer changes back into CodeMirror without echo transactions.
- Preserve text on every close path.
- Preserve and restore the compact textarea's directional selection.
- Provide only the curated movement, selection, and deletion bindings listed above.
- Keep half-page scrolling inside the top editor dialog.
- Add a configurable `open-composer-editor` command with default `Ctrl+Shift+E`.
- Lazy-load the CodeMirror renderer.
- Keep the terminal and all non-composer editboxes unchanged.

## Non-Goals

- Changing settings fields, search boxes, file-name inputs, terminals, file editors, or other editboxes.
- Replacing the compact composer textarea.
- Applying key rewriting directly to native textareas.
- Shipping full Emacs emulation, mark mode, a kill ring, yank, prefix arguments, search, transpose, or multi-chord commands.
- Adding a second draft value, an Apply/Cancel buffer, or durable CodeMirror undo history.
- Duplicating attachments, model controls, permissions, menus, or other composer controls in the dialog.
- Changing HTTP, WebSocket, server, provider, database, or shared protocol contracts.
- Adding a dependency.

## Resolved Decisions

- The feature is limited to `PromptComposer`.
- Editing synchronizes live into `ComposerState`.
- The open command is configurable and defaults to `Ctrl+Shift+E`.
- Firefox's Network Monitor conflict is accepted while Garcon owns the focused chat surface.
- Shift extends the four movement commands; mark mode is excluded.
- `Ctrl+K` uses CodeMirror's `deleteToLineEnd` behavior.
- The editor is plain text and Enter inserts a newline.
- Input method composition owns its key events.
- Repeating the open command while the dialog is open focuses the editor rather than creating another dialog.
- A chat switch closes the editor after existing draft-switch handling preserves the outgoing text.

## Current System

### Composer State

`web/src/lib/chat/composer/composer.svelte.ts` owns `ComposerState`. Assigning `inputText` increments `contentRevision`, and `queueDraftSave(chatId, text)` persists a debounced draft. `PromptComposer.svelte` binds its textarea to this state and queues saves from its input path.

`web/src/lib/components/chat/prompt-composer-state.svelte.ts` owns component-private transient state and resets it on chat changes. Dialog identity, open state, and focus requests belong at this boundary.

### Workspace Shortcuts

`web/src/lib/workspace/global-shortcuts.ts` owns shortcut IDs, defaults, overrides, conflict resolution, formatting, and matching. `KeyboardShortcuts.svelte` dispatches at `window` capture through `workspace-shortcuts.ts`.

The dispatcher must recognize when a focused descendant owns a key chord. This local ownership decision belongs after top-modal authorization and Escape handling but before global command dispatch.

### Modal And Scroll Ownership

Bits UI dialogs register with `TransientLayerRegistry`. The default dialog modality makes the application surface inert, and Escape closes only the top visible transient.

`FileDialogHost.svelte` establishes the modal surface pattern with `data-workspace-surface-id`. `CodeEditor.svelte` establishes the native CodeMirror scroll pattern through `registerNativeWorkspaceScrollRegion`.

The expanded composer will use the chat surface ID on its dialog and register its CodeMirror scroller as the primary native scroll region. Existing top-modal filtering will then admit the editor and reject the conversation feed behind it.

### Existing Dependencies

The repository already includes `@codemirror/commands`, `@codemirror/state`, and `@codemirror/view`. Vite already places CodeMirror in dedicated vendor chunks. No dependency or manual chunk change is required.

## External Research

### CodeMirror 6

The official CodeMirror command reference supplies `cursorLineStart`, `selectLineStart`, `cursorLineEnd`, `selectLineEnd`, `cursorLineUp`, `selectLineUp`, `cursorLineDown`, `selectLineDown`, and `deleteToLineEnd`.

The full `emacsStyleKeymap` is intentionally unsuitable because it captures many unrelated chords, including the existing half-page-down chord. A curated keymap is smaller and keeps ownership explicit.

### Svelte 5

Svelte 5's `{@attach ...}` primitive runs when an element is mounted and may return cleanup when it is removed. The CodeMirror `EditorView` lifecycle will use an attachment so construction and destruction remain tied to the editor host element.

### Full Emacs Extension

`@replit/codemirror-emacs` was inspected at commit `5c6c94f454a116e0846fbe835589363ae6f09252`. It adds mark mode, kill behavior, block-cursor rendering, broad command interception, and compatibility fallbacks beyond this request. The installed CodeMirror commands cover the requested subset without that dependency.

## Design

### User Experience

The compact composer gains a `Maximize2` icon button in `ComposerBottomBar`, with a localized tooltip and accessible name. The callback is optional so other users of `ComposerBottomBar` do not acquire the feature accidentally.

The dialog contains:

- A stable title, `Expanded composer`.
- A compact attachment count when the composer already holds attachments.
- A plain-text CodeMirror editor filling the remaining height.
- Standard dialog close behavior.
- A retryable error state if the lazy renderer fails to load.

The dialog uses a bounded large desktop layout and fills the mobile viewport. Editor controls compute to at least 16 px on touch devices to prevent mobile browser focus zoom.

Opening focuses the compact textarea without scrolling before presenting the dialog. Its selection and direction seed CodeMirror. Closing snapshots the CodeMirror selection before unmount, restores the directional selection to the textarea, refreshes composer trigger detection at the active head, resizes the compact textarea, and returns focus there.

### Single Draft Ownership

CodeMirror has no independent draft buffer. A user document transaction:

1. Verifies that the captured chat is still selected.
2. Assigns the new string to `ComposerState.inputText`.
3. Calls `queueDraftSave(capturedChatId, text)`.

An external `ComposerState` change dispatches an annotated replacement transaction into CodeMirror. The annotation keeps that transaction out of the local user-change callback and undo history. Selection offsets are clamped to the new document length.

CodeMirror history exists only while the dialog is open. Closing destroys the `EditorView`; reopening starts from current composer text with fresh history.

### Directional Selection

The compact textarea snapshot includes `selectionStart`, `selectionEnd`, and `selectionDirection`. CodeMirror represents the same information using `anchor` and `head`, preserving backward selections. The controller exposes a normalized snapshot rather than leaking CodeMirror objects into the composer shell.

Every close path asks the controller for the latest snapshot before the renderer unmounts. The textarea restore occurs after dialog focus restoration so Bits UI does not overwrite the intended selection.

### Curated Keymap

`composer-editor-keymap.ts` exports the key bindings and an event ownership predicate from the same declarative binding catalog. Keeping these derived from one catalog prevents the window dispatcher and CodeMirror from disagreeing.

The predicate claims exact Control-only A, E, P, N, and K events, with Shift allowed only for A, E, P, and N. It rejects Meta, Alt, repeat-specific global behavior, `Ctrl+U`, `Ctrl+D`, and `Ctrl+Shift+K`.

During composition, the editor root owns all key events so global shortcuts and chat Escape handling cannot preempt the input method.

### Local Shortcut Boundary

The workspace shortcut layer gains a DOM-scoped owner registry. An editor registers its root element and predicate while mounted. For a keydown event whose composed path is inside that root, the dispatcher asks the predicate whether the descendant owns the chord.

When a descendant owns an event, the dispatcher returns without calling `preventDefault` or `stopPropagation`, allowing CodeMirror to receive it normally. The boundary does not install another global event listener and does not know about composer commands.

Ordering remains:

1. Reject events outside the presented top modal.
2. Let transient-layer Escape handling run first.
3. Defer a locally owned chord to its descendant.
4. Run global workspace shortcut dispatch.

Registration cleanup removes the root entry. Element containment and the composed event path make nested shadow/portal behavior explicit.

### Modal Scroll Isolation

The editor root deliberately does not claim `Ctrl+U` or `Ctrl+D`. The workspace half-page handler therefore runs. The CodeMirror `scrollDOM` is registered through `registerNativeWorkspaceScrollRegion(..., 'primary')`, and the dialog content carries the chat workspace surface ID.

While the dialog is topmost, transient-layer candidate filtering permits only descendants of that modal. The CodeMirror scroller is selected and the feed behind the modal is ineligible. Terminal handling stays unchanged because this feature does not register ownership or scroll regions in terminal DOM.

### Open Command

`GLOBAL_SHORTCUT_IDS` gains `open-composer-editor` with exact default `Ctrl+Shift+E`. The existing shortcut configuration machinery makes it recordable, disableable, rebindable, resettable, and conflict-aware.

`ConversationWorkspace` handles the command only for the active chat surface and increments a monotonic `composerEditorOpenRequestId`. `PromptComposer` opens at most once for each request. Repeating the command while open increments an editor focus request instead of reconstructing the dialog.

The icon button calls the same open method, keeping shortcut and pointer behavior identical.

### Lazy Renderer

`ComposerEditorDialog.svelte` owns the modal shell and lazy-load state. `ComposerEditor.svelte` imports CodeMirror and is reached only through a dynamic import. The shell remains closable during loading and failure.

The renderer uses `{@attach}` to create a `ComposerEditorController`, returns cleanup that destroys it, and forwards focus and synchronization requests through a narrow component API.

### PromptComposer Integration

`PromptComposer.svelte` is already at the repository's architecture ceiling. A focused `PromptComposerEditor.svelte` shell and sibling controller therefore own expanded-editor coordination and selection restoration. The main component remains responsible for composer interaction and its existing resize behavior; CodeMirror lifecycle and editor commands stay outside it.

The prompt UI state owns:

- The captured editor chat ID.
- Whether the dialog is open.
- A monotonic editor focus request.
- The initial and latest directional selection snapshot.

Chat identity changes close the dialog. A separate presentation signal closes it when the Chat surface is genuinely hidden; the transient interactivity signal must not close it when the dialog itself makes the main workspace inert. Late callbacks include their captured chat ID and are ignored when it no longer matches.

## Data And API Impact

- No server or shared protocol shape changes.
- No database changes.
- No new persistent draft state.
- One new global shortcut ID and its optional persisted override.
- New localization keys for the button, dialog title, attachment count, load failure, and retry action.
- No package or lockfile changes.

## Failure Modes

### Renderer Load Failure

The dialog remains closable and displays a localized retry action. Retrying clears the rejected lazy-renderer cache. The compact composer text remains authoritative throughout.

### Chat Switch Or Deletion

The dialog captures a chat ID. A chat change closes it after the existing switch path saves the outgoing draft. Late editor callbacks fail the identity check and cannot mutate the newly selected chat.

### Programmatic Draft Mutation

External text changes replace the CodeMirror document through a non-echoing transaction. A no-op comparison avoids redundant transactions. Selection positions are clamped.

### Modal Layering

The dialog uses default `main-inert` modality and the global transient backdrop. Escape is processed by the top transient before local editor ownership. Half-page scroll candidates are restricted to the top dialog.

### Input Methods

The open command ignores composing events. While CodeMirror is composing, the local boundary owns all key events. Composition Escape neither closes the dialog nor reaches the chat abort shortcut.

### Accessibility

- Bits UI traps focus inside the dialog.
- CodeMirror exposes a named multiline textbox.
- Icon controls have localized labels and tooltips.
- Loading uses `aria-busy`; failures offer a keyboard-reachable retry.
- Closing restores focus and directional selection to the compact textarea.
- No accessibility suppression is required.

## Performance And Security

- The editor renderer is dynamically imported only after user intent.
- Exactly one `EditorView` exists while the dialog is open and is destroyed on close.
- Existing CodeMirror vendor chunks are reused.
- Draft persistence remains debounced.
- Large documents use CodeMirror viewport rendering.
- The editor introduces no storage, network, analytics, HTML rendering, logging, or clipboard capability.
- Prompt text must not appear in load or error logs.

## Alternatives Rejected

### Rewrite Every Native Editbox

This would change ordinary controls, rely on incomplete cross-browser selection APIs, and expand shortcut conflicts beyond the composer.

### Bind The Compact Textarea

Native textareas do not expose reliable visual-line movement for wrapped text. A separate editor mode makes the behavioral change explicit and provides consistent semantics.

### Import A Full Emacs Keymap

Both CodeMirror's complete Emacs keymap and third-party extensions capture unrelated chords, including Garcon's scrolling commands. The curated map is the smallest correct surface.

### Apply And Cancel

A second buffer creates competing drafts and makes Escape potentially destructive. Live synchronization keeps one source of truth.

### Multi-Chord Opener

Garcon's shortcut model is single-chord. Prefix state, timeouts, and recorder changes are disproportionate to this feature.

## Test Plan

### Pure Logic

- The keymap contains exactly five base bindings.
- Movement bindings use the corresponding CodeMirror commands and Shift selection commands.
- Delete has no Shift variant.
- Ownership matches only the curated exact chords and all composing events.
- Selection conversion preserves forward and backward direction and clamps offsets.
- The new global shortcut defaults, formats, rebinds, disables, resets, and resolves conflicts correctly.

### Workspace Dispatch

- Locally owned movement chords reach a target-phase editor listener instead of global commands.
- Cleanup restores ordinary global dispatch.
- Escape still closes the top transient first.
- Half-page chords bypass local ownership and scroll only the registered CodeMirror scroller in the top modal.
- The conversation feed behind the modal does not move.
- Terminal behavior is unchanged.

### Components

- The icon and request ID open a dialog initialized from textarea text and selection.
- Editing updates `ComposerState`, the compact textarea, and queued draft persistence before close.
- External text changes synchronize once without duplicate revision increments.
- Escape, backdrop, and close button preserve text and restore focus and directional selection.
- Switching chats closes the dialog and blocks stale writes.
- Repeating the open command focuses the existing editor.
- Loading and rejected imports leave a closable, retryable dialog.
- Settings show the opener in the Composer group and retain recorder, removal, reset, and conflict behavior.

### Editor And Component Integration

Real `EditorView` tests will exercise movement, selection, deletion, synchronization, local shortcut ownership, and native scroll-region registration. Composer component tests will cover dialog opening, live draft propagation, modal interactivity, close paths, focus, directional selection, and chat changes. Workspace dispatcher tests will verify that the top modal owns half-page scrolling without moving the feed underneath.

Lightpanda 0.3.5 and 0.3.6 cannot host CodeMirror: their `IntersectionObserver` delivery repeatedly schedules callbacks until Lightpanda reaches its internal timer ceiling and terminates. This feature therefore does not add a Lightpanda workflow that would fail in the browser engine before exercising Garcon behavior.

## Validation

Run focused tests during implementation, followed by:

```sh
bun run check
bun run test
bun run build
```

After code changes, start an isolated server without disturbing the user's instance:

```sh
env -u GARCON_PORT GARCON_CONFIG_DIR=/tmp/garcon-composer-editor-smoke GARCON_BIND_ADDRESS=127.0.0.1 timeout 30s bun run start --port 0
```

Exit status 124 is expected after the server prints a healthy random loopback URL and remains running until timeout.

## Acceptance Criteria

- Only the chat composer gains the expanded editor.
- No dependency or lockfile change is introduced.
- Editor edits appear live in the compact composer and survive every close path.
- The curated movement, selection, and delete bindings work inside CodeMirror.
- Window-capture global commands do not preempt locally owned editor chords.
- Half-page chords scroll only the top editor dialog and never the feed behind it.
- Escape closes the editor before chat-level Escape handling.
- Focus and directional selection restore correctly.
- Chat switches cannot leak edits into another draft.
- The open command is configurable and available from an icon button.
- The renderer is lazy and retryable.
- Generated translations, checks, tests, build, isolated startup, and real `EditorView` integration coverage pass.

## Deferred Scope

Full Emacs emulation, multi-chord shortcuts, expanded attachment management, persistent editor history, and other input surfaces require separate product decisions.
