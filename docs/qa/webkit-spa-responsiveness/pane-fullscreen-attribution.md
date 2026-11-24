# What runs when eleven chat panes reappear?

A slow geometry getter is not necessarily a profitable getter to remove. On production `58a2bdf0a`, the first reappearing feed's `clientWidth` read took **243, 260 and 335 ms** in three warm WebKitGTK exits. Returning the correct width without that read moved a comparable delay to the very next geometry read. The other ten panes did work, but did not each incur a second delay of that size.

## Production observation

Used [the fullscreen fixture](pane-fullscreen.md), Source mode, 1840 x 960, 12 chats with eight completed echo turns apiece, one detached reader, and GTK 2.50.6. Verified the original feed elements, restored rectangles, owner, editor, end pin and detached row/offset. The shortcut and a separate hidden processing/delivery cycle also passed. Watched native calls and DOM mutations only between trusted titlebar pointerdown and the second frame callback after the label change. Each transition was preceded by a settled idle two-frame control. No targeted calls were seen in those idle windows.

| Observation | Enter | Exit |
| --- | --- | --- |
| 1 pane, slowest native call (3 warm trials) | Active tab strip rect: 16 ms each | Same rect: 18 to 28 ms |
| 12 panes, slowest native call | Active tab strip rect: 203 to 251 ms after label change | First revealed viewport width: 243 to 335 ms before label change |
| 11 neighbors, original mounted wrappers | All 110 remained connected | All 110 remained connected |
| Neighbors, wrapper observer operations | 110 unobserves | 110 observes, 110 consumed border-box entries |
| Neighbors, synchronous wrapper height reads | 0 | 110 |
| Neighbors, viewport / sizer rect reads | 3 / 2 | 213 / 213 |
| Neighbors, viewport scrollTop writes | 0 | 21 |

On entry, the detached reader's [anchor capture](../../../web/src/lib/components/chat/transcript/conversation-feed-virtual-runtime.ts#L145) also incurred a 42 to 65 ms viewport rect read before the label changed. The larger later read was [the active tab strip measuring its label rail](../../../web/src/lib/components/workspace/WorkspaceWindowTabStrip.svelte#L210), not eleven repeated full-feed measurements. On exit, every neighbor recorded two DOM mutation batches and no wrapper replacements. Across the eleven there were 539 mutation records, including chrome child-list changes and row attribute changes. The active feed expanded by seven wrappers on entry and shed those seven on exit. Mutation records identify DOM work, not Svelte commit count, physical paints, or component teardowns below each wrapper.

The three warm 12-pane instrumented exits recorded 2,144 targeted native calls each. Reading every retained wrapper and registering the observers did not account for hundreds of milliseconds of synchronous native-call time; the long read was on the first revealed pane. Browser delivery and later layout/paint can still cost time. Method wrappers passed native arguments/results unchanged, timed only the native call and recorded bounded generated callsites for slow reads. Resize entry counts are distinct consumed entries, not every browser rendering event. Stacks were matched to the unmodified served JS; these are in-page observations, not an Inspector trace. Do not compare instrumented duration directly to an uninstrumented result.

## Width control

In a separate twelve-pane run, captured all eleven still-visible viewport widths before each entry and checked the actual native widths immediately after exit. All were 380 px, including the first and last comparisons. A fixed-build callsite filter intercepted only the [explicit hidden-resize comparison](../../../web/src/lib/components/chat/transcript/ConversationFeedVirtualController.svelte.ts#L845) during exit: either call through to the native getter or return that pane's previously measured value. Both arms used the same filter. All other width reads, observers, scroll target resolution and actual row DOM were left alone. This substitution is valid only for the verified matched UI, not for a production hidden pane that may actually have changed width.

| 12-pane exit | Warm samples | Median to label | Median to two frames |
| --- | ---: | ---: | ---: |
| Stock, no geometry wrappers | 2 | 338 ms | 694 ms |
| Wrapped, native width | 4 | 397 ms | 772 ms |
| Wrapped, verified cached width | 4 | 410 ms | 918 ms |

Stock is a reference, not the causal pair. Wrapped blocks ran native/cached/cached/native in the same loaded document, three pairs per block, first pair excluded. Each cached exit bypassed exactly eleven native reads with no difference in restored widths, anchors or ownership. Separately, with full attribution enabled in native/cached/cached/native order, the native exits paid **252 and 238 ms** in the first revealed viewport's `clientWidth`; the cached exits paid **257 and 282 ms** in that same viewport's `scrollTop`, inside [the virtualizer's first geometry read](../../../web/src/lib/virt/virtual-list-dom-driver.ts#L69). This small control rejects a width-cache optimization; it does not show that caching generally slows WebKit.

[Sanitized gestures and aggregate counts](pane-fullscreen-attribution.csv). Blank columns mean unobserved or not applicable. No Inspector, iPhone, GPU presentation, or native-frame attribution is implied.

## One resume publication

The original [Virt resume transaction](../../../web/src/lib/virt/virtual-list-transaction.ts#L398) published current geometry at the physical offset, then read DOM geometry again and published the **intended** target before the first DOM commit. A candidate passed that first DOM sample directly to the existing scheduler for valid end/start/keyed targets. It preserved the independent post-commit read and the single physical scroll write. A removed key still published current geometry once without scrolling; a detached viewport still returned not-ready. This changes neither the visibility policy nor observer reattachment.

The end/keyed unit reproducer measured **two synchronous reads and two publications** before, **one read and one publication** after. A simulated leading-offset change between planning and commit still reached the correct offset. Other controls covered replacement by an empty generation, hidden width and typography changes, detached reading and end pinning, cancellation, coasting, and background updates.

**The structural change did not establish a fullscreen latency win.** Ran the unchanged fullscreen runner on separately gated stock and candidate builds, in stock/candidate/candidate/stock order, without counter wrappers or row diagnostic flags. Each block used a fresh synthetic fixture, tested 1 and 12 panes in alternating order, and discarded the first enter/exit pair at each size. Six measured gestures per build, direction and size:

| Panes | Toggle | Stock: state / two frames, ms | Candidate: state / two frames, ms |
| ---: | --- | ---: | ---: |
| 1 | Enter | 22.5 / 134.5 | 26 / 120.5 |
| 1 | Exit | 31 / 136 | 24.5 / 129.5 |
| 12 | Enter | 122 / 488.5 | 137 / 538 |
| 12 | Exit | 364 / 694.5 | 374.5 / 696 |

Twelve-pane exit ranged from **550 to 747 ms** on stock and **592 to 818 ms** on candidate. Entry, which does not resume the eleven panes, varied too. All 64 gestures, including warmups, retained original feed and panel nodes, the correct command owner and draft; every 12-pane exit restored its detached row and offset with zero observed drift. The separate hidden response delivery, draft selection and shortcut checks passed in all four fixtures. The reduction in redundant work is deterministic; the reveal still has to lay out eleven panes. [Candidate comparison samples](pane-fullscreen-resume.csv).

## Keeping hidden tile boxes

**Keep the stock hiding policy.** On `e6e3fb1f8`, retaining hidden layout boxes helped in the fixed-width control but did not preserve tile geometry or improve both directions with the default sidebar. Used the same GTK 2.50.6 production build, fixture and trusted button probe as above. Only the originally admitted desktop non-owner chat sections received a study marker. A kept stock `display:none`; B enabled this rule outside the timed gestures:

```css
[data-fullscreen-study-retained].hidden[inert][aria-hidden="true"] {
  display: flex;
  visibility: hidden;
}
```

| Layout | Direction | Stock: median to label / two frames, ms | Keep boxes: same, ms | Two-frame ranges: stock / keep, ms |
| --- | --- | ---: | ---: | --- |
| 12, sidebar stays | Enter | 79 / 461 | 72 / 409 | 385-575 / 376-458 |
| 12, sidebar stays | Exit | 325.5 / 506 | 326.5 / 460 | 466-621 / 399-518 |
| 12, default | Enter | 118.5 / 461 | 110 / 498.5 | 438-493 / 477-522 |
| 12, default | Exit | 356 / 562.5 | 376 / 529 | 461-615 / 463-590 |
| 1, default (no eligible neighbor) | Enter | 29.5 / 98.5 | 19.5 / 95 | 87-101 / 70-132 |
| 1, default (no eligible neighbor) | Exit | 26 / 100 | 32.5 / 105.5 | 82-114 / 91-136 |

One loaded document per layout; A/B/B/A, one discarded warmup and three measured enter/exit pairs per block, six measured gestures per cell. [All 96 gestures](pane-fullscreen-boxes.csv). Frame callbacks are not physical paint measurements.

The [window rectangles](../../../web/src/lib/components/workspace/WorkspaceRoot.svelte#L520) are percentages of the desktop host. With `fullscreenCoversSidebar:false` and autohide off, B preserved all eleven original window **and feed** rectangles; the host stayed 1520 x 960. With [default sidebar collapse](../../../web/src/lib/components/layout/AppShell.svelte#L182), the host widened to 1840 and all eleven tiles widened from 380 to 460 px. No original hidden rectangle survived in that arm. Stock had no hidden boxes in either case. Both arms restored every original rectangle on exit; all retained feeds stayed connected, only the owner was presented and claimed commands and the composer, its draft and focus survived, and reader drift and exit end gap were zero.

Separate from timing, one held turn in a hidden reader in each of three cycles (stock fixed-width, B fixed-width, B default) preserved its suspended model and all mounted wrappers. Each cycle recorded two hidden-feed mutation records, a complete processing transition, the response on reveal, and correct shortcut selection and draft switching. Sampled tile centers never hit hidden descendants. In a full descendant audit, eight nodes in default B still had computed `visibility:visible` and a client rect, versus none in fixed-width B; this does **not** establish painted leakage. A short static fixture cannot guarantee invisible layout is free during sustained updates. No CSS policy or sidebar behavior was changed.

## Tab measurements

A scratch titlebar cached the widths of tab labels only for ResizeObserver deliveries confined to the unpadded tab viewport. A changed label or rail, a new observer, or crossing zero width still forced measurement. Equivalent layout/measurement publications were suppressed. In a mounted three-label unit control, three viewport-only deliveries reduced nine label rectangle reads and three gap reads to zero. That is not the delivery pattern produced by fullscreen.

In a separate attribution pass on the real button, both builds delivered rail or label changes and **zero viewport-only deliveries** on the observed warm enter and exit at both 1 and 12 panes. The candidate still reduced label rect, client width and gap reads from three to two per pane by avoiding duplicate work (33 to 22 across the eleven neighbors). It did not eliminate the required layout.

In four uninstrumented GTK 2.50.6 runs, stock/candidate/candidate/stock, six measured gestures per build/size/direction, median time from trusted button input to two callbacks was:

| Panes | Enter, stock / candidate | Exit, stock / candidate |
| ---: | ---: | ---: |
| 1 | 175 / 149.5 ms | 213.5 / 133.5 ms |
| 12 | 630 / 633 ms | 606 / 711.5 ms |

The one-pane control improved in this run, but the hypothesized fast path did not run on the target gesture and the 12-pane result did not improve. **No titlebar cache shipped.** All four fixtures passed the usual draft, command-owner, hidden-delivery and reading-position checks. [All 64 trusted gestures](titlebar-measurement.csv); same [fullscreen runner and setup](pane-fullscreen.md#reproduce-the-toggle-matrix), three measured rounds per block.
