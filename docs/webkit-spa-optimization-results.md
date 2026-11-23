# SPA responsiveness: optimization follow-up

This pass compares changes *after* the [popup backdrops](linux-webkit-pane-popups.md) and [stable editor stylesheet](webkit-spa-responsiveness.md). The comparison build, `0ea1d731c`, already contains both. These experiments address different costs in the same web client served to the Linux package. They are not benchmarks of Tauri IPC, V8 versus JavaScriptCore in isolation, or a physical iPhone.

## What changed

| Path | Removed work | Contract retained |
| --- | --- | --- |
| [Transcript scroll](../web/src/lib/components/chat/transcript/ConversationFeed.svelte) | Scrolling a range no longer rebuilds the position view or rebinds every retained row. A 380 px component-test scroll that added two rows did **2 instead of 21** attachment lookups. An unchanged observer echo did **0 instead of 1** viewport reads. A collapsible message uses one observed content rectangle instead of size bindings on two elements. | Prepaint measurement on first mount, anchor correction, native scrolling, draggable scrollbar, focus/selection retention. Pending corrections still reconcile. |
| [Receiving chat](../web/src/lib/components/chat/transcript/conversation-feed-virtual-items.ts) | An ordinary tail append after 128 tools read **0 instead of 256** historical message fields and **0 instead of 128** historical tool IDs to project the combined feed. Previous navigation targets are reused. An inactive announcer no longer computes candidate announcements or repeatedly publishes an empty string. | Immutable snapshots; index maps still incur a copy. Appends preserve tool grouping, permission placement and target navigation. Visible background chats still update. |
| [Message actions](../web/src/lib/components/chat/transcript/ConversationMessage.svelte) and [pane menus](../web/src/lib/components/workspace/WorkspaceWindowMenuRoot.svelte) | Create menu/dialog content on first use. An untouched message row no longer creates 26 direct body nodes; narrow one- and two-tab titlebars no longer create 37 and 48, respectively. No tab-action model is resolved until a menu opens. | Triggers remain. Once opened, the content owner stays for dismissal and focus return. Counts include portal markers in a component test, **not visible elements**, and are not milliseconds. |
| [Composer](../web/src/lib/components/chat/composer/ComposerMarkdownEditor.svelte) | Two formatted edits no longer read the hidden Source field's rectangle twice. An empty editor mount avoids a selection dispatch and editable refresh. Small edits skip the full node-count walk when document size proves it unnecessary. Restoring 192 formatted paragraphs parses **193 instead of 384** tokens to map the caret. | Visible Source still fits; native editor reconciliation, immediate text publication, size limits, independent drafts, undo and caret are retained. Token reuse is local to one parse request. |
| [Sidebar](../web/src/lib/sidebar/display/sidebar-row-model.ts) | Index each distinct project spelling per executor once, skip that work without project grouping, reuse delegation counts, and share reorder-scope keys. A changed preview or title with identical keys and estimates no longer submits a virtual geometry update. | Fresh row objects reach the UI. Filters, ordering, executor-qualified grouping, measured heights and drag/reading anchors remain independent. |
| [Files](../web/src/lib/workspace/workspace-services.ts) | Compare the document IDs actually presented by two layouts, rather than checking each parked file view. With 40 parked files and one visible, an unchanged presentation made **0 instead of 41** polling visibility checks. | Changing documents notifies the two affected IDs and checks the revealed document immediately; multiple views of the same document count once, including the desktop dialog. |

The changes do not suspend visible tiles, substitute a simpler message renderer, or buffer foreground input. Reopening a retained context menu from link B after opening it from A exposed a focus bug: Bits correctly restored B, then Garcon focused A. Bits now owns that per-open restoration; regression tests check both final focus and the absence of a spurious focus on A.

## Production-build comparison

Compared `0ea1d731c` to `06d727623`. Both were production builds, with the same server code and isolated synthetic provider. Each block starts a fresh browser and controller, twelve chats, 28 short paragraphs per initial prompt, and 48 additional turns in the active chat (98 entries). The layout uses the real workspace reducer. One pane and twelve balanced visible panes share an 1840 x 960 viewport. The active feed is 806 px tall at one pane but only 86 px at twelve. Hold tile size *as well as* count constant when testing a different layout.

Linux WebKitGTK 2.50.6 MiniBrowser over WebDriver/Xvfb and Playwright Chromium 156.0.8078.4 headless shell, no Inspector. GTK build order: before, after, after, before; Chromium: after, before, before, after. This VM has no physical GPU or display for the study. Compare within this run; absolute times vary with load. Neither a WebDriver round trip nor a completed CSS transition is the latency measured here.

- **Scroll:** 14 trusted wheel notches, 120 CSS px each, alternating direction; check delivered deltas, changed scroll position and newly mounted row IDs. Pool intervals between consecutive page-thread animation-frame callbacks entirely inside the five warm trains per block. A delayed callback need not mean the compositor stopped scrolling.
- **Typing:** type and delete a single character with a real key, verify text, caret and focus. Time from keydown inside the page to two frames after input. Quiet first, then short completed turns alternating between two other visible chats at a target interval of 300 ms. Twelve warm keys per condition per block. This is not OS input latency, page-level INP, or token-by-token streaming.
- **Switch:** click already-visible transcripts, keep all twelve original feed elements, verify both the owning surface and enabled editor containing the destination draft. Record the two-frame checkpoint *and* the first animation-frame check that sees the right editable. A short Source or Formatted draft is separate from restoring 192 formatted blocks. Drop the first round trip in each block.
- **Popup:** focus the current pane's three-dot trigger; click it or use `Ctrl+,` for Settings. Alternate order and close with Escape. Time to DOM observation and two frames afterward. Four warm openings per kind per block. See the probe limitation below.

Median ms, before / after. Typing and menu use the two-frame checkpoint; switches use the first frame that verifies the correct editable; scroll uses the interval between callbacks.

| Workload | WebKitGTK | Chromium |
| --- | ---: | ---: |
| Formatted key, 12 quiet panes | 30 / 27 | 22 / 22 |
| Same key, 2 other tiled chats receiving turns | **98 / 31** | 22 / 25 |
| Switch between short Formatted drafts, 12 panes | 159 / 136 | 70 / 65 |
| Switch between short Source drafts, 12 panes | 140 / 112 | 41 / 36 |
| Switch to a restored 192-paragraph Formatted draft | **443 / 352** | 143 / 168 |
| Three-dot menu, 12 panes | 488 / 419 | 45 / 36 |
| Scroll one tall transcript | 127 / 105 | 16 / 16 |
| Scroll the same transcript in 12 panes | 29 / 25 | 17 / 17 |

Both builds sustained 3.3 completed background turns/s. GTK busy-key p95 fell **164 to 128 ms**, still visibly late. The hidden Source rectangle read disappeared on every measured candidate key. GTK single-pane scroll p95 **worsened from 199 to 380 ms**; the twelve-pane p95 was 87 / 86 ms. The tall pane mounted a median 21 new rows between endpoints, versus 8 in the short tile. Lower work counts and better medians are not evidence of smooth scrolling or uniformly better tails. [Samples, including warm-ups, missed captures and wheel intervals](qa/webkit-spa-responsiveness/optimization-comparison.csv).

**Chromium check:** the first comparison had worse busy-key and long-restore medians. In a separate editor-only run with reversed build order, 40 warm keys and 16 long restores per build, busy typing was **23 / 22 ms** and long restore **147 / 133 ms**. The median regression did not repeat, but the maximum long restore again got worse (168 / 249 ms in the repeat). These samples are too few to establish a population p95. Don't promise a Chromium speedup. Across both engines no measured 192-block editor was ready at the ordinary two-frame checkpoint; all eventually restored the expected document and end caret. [Editor repeat](qa/webkit-spa-responsiveness/optimization-chromium-editor.csv).

**Residual switch cost:** in a separate Source-mode observer pass, every actual transfer changed the old spacer once, the new spacer once and the unrelated spacer zero times. Same-pane clicks changed none. On GTK, both spacers were zero and the composer unbound on at least one sampled frame on two of four baseline switches and one of four candidate switches; on Chromium, zero of four in each build. This identifies a transient state, not its cost. Selection and composer ownership are guarded separately so a click cannot send a draft to the wrong chat. The data do not justify bypassing that guard or freezing every pane. [Inset and frame observations](qa/webkit-spa-responsiveness/optimization-source-insets.csv).

**Settings probe:** in the main run, warm GTK dialogs opened but the late-installed console listener missed their insertion. A separate trusted-key reproduction found the dialog was already open inside that listener on three consecutive warm opens. The [revised probe](qa/linux-webkit-pane-popups/measure-next-open.js) uses the event timestamp when it shares the page clock, checks already-open DOM immediately, and observes state changes as well as insertion. In a fresh four-block GTK repeat, Settings took **523 / 508 ms**, the menu **388 / 370 ms**, eight warm captures per build with none missing. This does not show a substantial further Settings win. The stronger evidence for Settings remains the earlier controlled body-lock and blur tests. Do not compare absolute times across probe versions. [Popup repeat](qa/webkit-spa-responsiveness/optimization-gtk-popups.csv).

## Large sidebar

Same browser page, alternating complete old/new projections of a deterministic fixture from [the sidebar benchmark](../web/scripts/benchmark-sidebar-projection.ts). Eight warm samples per cell; each timed sample averages four projections at 2,000 chats. Compared serialized row models and sampled header membership before timing. Median milliseconds, before / after:

| 2,000 chats | WebKitGTK | Chromium |
| --- | ---: | ---: |
| Flat, no grouping | 12.13 / 5.75 | 10.01 / 5.10 |
| Flat, four grouping fields | 18.00 / 8.50 | 15.35 / 6.39 |
| Delegated tree, four grouping fields | 28.38 / 17.50 | 27.90 / 15.98 |
| Same tree, filtered | 16.75 / 11.38 | 10.92 / 5.83 |

A faster projection helps both engines. It does not make sorting 2,000 chats free or measure how often a real catalog rebuilds. [Per-sample results](qa/webkit-spa-responsiveness/optimization-sidebar.csv).

## Alternatives not shipped

- **Remove the custom transcript thumb?** On an isolated candidate build, remove the scrollbar component and corner but retain the same native overflow viewport and width. A second diagnostic instead kept the thumb and skipped the synchronous first measurement of newly mounted transcript rows, relying on ResizeObserver. Neither improved this WebKitGTK wheel test. Median callback gap at one pane: **80 ms normal, 165 ms without the thumb, 183 ms observer-only**. At twelve panes: **22, 58, 83 ms**. Normal / thumb removed / observer-only / observer-only / thumb removed / normal block order. Median movement was 1,680 px in every variant; feed dimensions were identical. This is a software-rendered, variable-load run, not evidence that a custom thumb is inherently faster. Removing it would lose dragging; waiting for the observer would weaken the prepaint guarantee. [Control samples](qa/webkit-spa-responsiveness/optimization-scroll-controls.csv).
- **Stop parsing hidden terminal output?** Xterm already batches writes and suspends offscreen rendering. A detached xterm 6 instance still answered a cursor-position query. Delaying its parser can change PTY behavior, not just performance. No change.
- **Only refresh the apparent repository on save?** Saving in B currently schedules visible Git summaries A and B on the same executor, but not a hidden A or a different executor. Project-path spelling doesn't establish distinct worktrees; an unconfirmed save can still have changed disk. Kept the conservative invalidation instead of trading fresh Git state for fewer requests.
- **Default every popup to transparent, remove focus work, or force layers?** The [prior controlled experiments](linux-webkit-pane-popups.md) support avoiding inherited body-style changes and show an independent cost from blur. They did not support removing the focus scan, disabling animations, or adding containment to each tile. These optimizations leave appearance and accessibility settings alone.

## Remaining work

The most useful next trace is the **longest tall-feed scroll frame** on GPU-backed Linux: attribute time to synchronous first-row content layout, Svelte mount, style, paint and the layer compositor, and watch the actual reading anchor. For switching, separate the time spent waiting for the right draft from editor construction and shared composer placement. Recheck busy typing with actual token streaming and realistic tool/code rows. On a physical iPhone test the compact single-chat path, keyboard, IME, VoiceOver, and a fling through a prepend while another chat updates. A narrow desktop viewport does not establish iOS performance.

Behavior was checked independently of timing: 63 Chromium regressions across composer, message selection, popup hit testing, virtualized scrolling and paging, retained transcripts, sidebar layout/reordering, and Files polling. Playwright WebKit 27.2 passed login, submission, reload, and draft restoration at 1280 and 390 px. Neither test emulates the reporter's GPU, Brave build or iPhone display stack.
