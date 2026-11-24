# Which part of a real row delays scrolling?

The [earlier lightweight control](../../webkit-scroll-and-fullscreen.md) removed both component work and visible content. This follow-up keeps the text, native scroll viewport and row geometry constant on WebKitGTK 2.50.6. The question is whether a **particular part** of the row is sufficient to recover the earlier control's callback cadence.

## Menu, Markdown and placement

| Entering ordinary rows | Warm trains | Median typical gap | Median worst gap |
| --- | ---: | ---: | ---: |
| Normal | 12 | 111.5 ms | 193 ms |
| Inert menu root and trigger, same visible controls | 8 | 100.25 ms | 195.5 ms |
| Warm simple paragraph rendering | 8 | 121 ms | 165.5 ms |
| Both layer changes | 8 | 91 ms | 215.5 ms |
| Absolute `top` instead of `translateY` | 8 | 143.5 ms | 224.5 ms |

Each gesture has equal weight: compute its median and maximum callback interval separately, then take the median of each across gestures. The three normal blocks had typical gaps of 98.25, 111.5 and 117.5 ms. None of these controls consistently approached the earlier retained/empty-row result. Do not remove the menu, add a second Markdown cache or change positioning on these numbers.

The inert trigger leaves the More button, author classes, text and geometry but **not** the menu's interactive behavior. The Markdown control uses the existing parser's output for exact-source, exact-policy repeat visits to simple paragraphs, not a second interpretation of arbitrary Markdown. All eligible paragraphs at measured endpoints used that path. A separate 18-case actual-component check compared cold/warm semantics and complex-content fallback. Neither disabling every message action nor serving cached render data for mutable live content is an acceptable production shortcut. The position control changes how real rows are placed, not virtualization or overscan; callback timings alone do not test missing pixels.

## Visible pixels versus row components

A second build used the same workload, separately baselined. On a fresh document, capture native clones of the 98 real message subtrees during the untimed calibration walk. Arm only after verifying all keys. Newly entering clone rows get the real DOM and CSS again, but not live message components or listeners. Real virtual wrappers, positions and observers remain. None of the 29/30 messages at a measured clone endpoint was a placeholder or a cache miss. Independently, the `visibility:hidden` control leaves real message DOM and box geometry in place. It also suppresses painting, hit testing and accessibility; it is not a paint profiler.

| Same viewport and text in the DOM | Warm trains | Median typical gap | Median worst gap |
| --- | ---: | ---: | ---: |
| Normal live rows | 12 | 182.5 ms | 277 ms |
| Visible cloned DOM | 8 | 100 ms | 279 ms |
| Live rows, message contents hidden | 8 | 28 ms | 71 ms |
| Cloned rows, message contents hidden | 8 | 23.5 ms | 58.5 ms |
| Live, visible text and controls, decorations flattened | 8 | 55 ms | 119 ms |

The three normal block medians were 129, 210.75 and 156.5 ms. Cloning reduced typical delay in the aggregate but did **not** recover the worst gaps. Hiding live messages made a much larger difference without removing component construction. More usefully, keeping text and controls visible while removing shadows, radii, filters, background images and transitions improved both statistics in both blocks. That points to how the real rows are drawn, not just to the JavaScript library that creates them. The broad CSS rule changes several things; it is not a remedy to ship.

## One visual property

The next comparison kept every component, text node and interactive control live. Only the injected CSS differed between documents. Computed styles after the gesture confirmed which bubbles/buttons retained shadows, rounding and transitions.

| Change from normal | Warm trains | Median typical gap | Median worst gap |
| --- | ---: | ---: | ---: |
| None | 12 | 135 ms | 218.5 ms |
| Remove only the user bubble's box shadow | 8 | **31 ms** | **72 ms** |
| Remove all message box shadows, including buttons | 8 | 32.5 ms | 79 ms |
| Remove border radii | 8 | 147.5 ms | 211.5 ms |
| Remove transitions | 8 | 108.25 ms | 246 ms |
| Flatten all decorations | 4 | 30 ms | 65 ms |

Both bubble-only blocks improved independently (37 and 27.75 ms typical; normal blocks 135, 113.5 and 144.75 ms). No need to turn off focus rings, buttons, rounded corners, or transitions: removing one resting shadow reproduced most of the broad control's improvement. This is evidence about **these large recurring bubbles on this renderer**, not about every box shadow on the site.

## Production builds

The actual [user-bubble class](../../../web/src/lib/components/chat/transcript/ConversationMessage.svelte) omits the resting shadow only for ordinary messages with a closed context menu. It does not set `box-shadow:none !important`. A presented CLI message, an ordinary bubble with its menu open and the More button keep their own styles. No virtualizer, markup, clipping, selection, tab order or Markdown change is needed for the shadow fix.

Rebuilt stock and candidate independently, without diagnostic app sources. Their only non-test web source difference was that bubble class; both included the same atomic resume code. For each engine/corpus use separate, fresh fixtures in stock/candidate/candidate/stock order, with the ordinary `normal` route, no injected CSS and two measured pairs per block. Each build therefore contributes eight measured gestures. Across builds in a cell, the digest of all 100 items' ordered text, row dimensions and control semantics matched, as did both reading anchors, endpoint membership counts and travel. Synthetic identities differ and were excluded from the digest. Each measured candidate endpoint still had rounded bubbles and buttons with shadows and transitions; no resting bubble had a shadow.

| Engine and content | Stock: typical / worst | Candidate: typical / worst |
| --- | ---: | ---: |
| WebKitGTK 2.50.6, paragraphs | 99 / 254 ms | **44.5 / 126 ms** |
| WebKitGTK 2.50.6, Markdown links, emphasis, code, lists and paragraphs | 83.75 / 152.5 ms | **40.25 / 89 ms** |
| Chromium 156, paragraphs | 16.6 / 48.7 ms | 16.4 / 42.35 ms |

These are medians of each gesture's typical and worst page-callback gaps, not physical frames. Both GTK candidate blocks improved on both stock blocks for typical and worst gap in each corpus. Chromium's ordinary cadence barely changed; its single worst interval was 60.7 ms stock versus 76.6 ms candidate. These small samples don't support a Chromium tail claim or a percentage gain on GPUs or iOS. [Actual build samples](row-bubble-builds.csv).

**Interaction check:** On both built products in desktop Chromium, the ordinary bubble retained its 228.53 x 42 px box and 16 px radius; its open state and custom-presented bubbles retained the same computed shadow, colors, borders and selection styling. Hover revealed More. Tab from a row link reached More with the same visible 2 px focus ring; Enter opened its menu and Escape closed it. A native double-click selected a word, and right-click / Quote inserted exactly that word into the draft.

**Missing pixels remain a separate issue.** In the [four-train product output check](scroll-row-paired-stripes.md#final-product-builds) the faster candidate still showed a common band up to 649 px high at two independently sampled columns during one downward train. No JavaScript viewport correction occurred. Do not take this small sample as a frequency estimate or confuse improved callback cadence with guaranteed pixel coverage.

## Reproduce

Use the [opt-in runner](../../../integration-tests/scripts/transcript-row-scroll.ts) with a **private synthetic fixture** and an isolated production build based on `58a2bdf0a`. Keep the benchmark scripts from this revision. Do not apply the diagnostic patches to an app distributed to users. For the first matrix apply [row-layer-controls.patch](row-layer-controls.patch) with `patch -p1 --fuzz=0` at the isolated checkout root. From that root:

```sh
bun run build
bun integration-tests/scripts/transcript-row-scroll.ts --engine=gtk \
  --webdriver=http://127.0.0.1:38637 --pairs=2 \
  --modes=normal,menu,text,both,normal,top,both,text,menu,top,normal
```

For the DOM/visibility comparison use a separate checkout with [row-shell-control.patch](row-shell-control.patch) **instead of** the layer patch, and rerun with `--modes=normal,clone,unpainted,unpainted-clone,flat,normal,flat,unpainted-clone,unpainted,clone,normal`. The measured second build also included the atomic resume change described in the [fullscreen comparison](pane-fullscreen-attribution.md); no fullscreen toggle or pane reveal occurs during these trains. The CSS-only modes are injected by the test driver, not implemented in application routes. Never interact with cloned controls or cache real user DOM.

For the individual-property comparison, run on the old shadowed build with `--modes=normal,bubble-shadow,shadows,corners,transitions,flat,normal,transitions,corners,shadows,bubble-shadow,normal --pairs=2 --expect-bubble-shadow=present`. This last comparison needs no diagnostic application patch.

For the production comparison, start both private copies with the product sources at `71823c1e4`. In stock only, use `web/src/lib/components/chat/transcript/ConversationMessage.svelte` from `58a2bdf0a`; the candidate uses its unmodified component. Build both, then run the same current harness in each: `--modes=normal --pairs=2 --corpus=paragraphs` or `--corpus=mixed`, with `--expect-bubble-shadow=present` on stock, `absent` on candidate. Require the final `complete` record each time and match the block's content/geometry digest within each engine and corpus before pooling.

GTK needs an isolated MiniBrowser with enough desktop space for an actual 1840 x 960 inner window. For headless Chromium use `--engine=chromium` without a WebDriver URL. The runner asserts a 1520 x 806 active viewport. Twelve chats exist; only the synthetic 98-entry chat is visible. In every document, first visit all 100 virtual items. Compare full virtual keys, row text/width/height and descendant control semantics to the same fixture's baseline before sampling. This primes size caches and tests **warm re-entry**, not first load. Two separately anchored directions start at indices 46 and 66, both at -5 px. All 14 trusted pixel wheels must reach the page and the feed must travel 1,680 px. Each direction must end at the same key and offset across variants on one fixture. On the GTK paragraph corpus the endpoints are 67/-49 px and 44/-71 px. Do not pool different engines or corpora.

Discard the first down/up pair per fresh document. Boundaries in [row-entry-work.csv](row-entry-work.csv) are relative to the first trusted wheel; retain the interval crossing the first wheel and the one crossing the last wheel or scroll. An empty CSV field is unobserved, not a zero. The investigation serialized its own browser sweeps and builds; other work on the shared VM was not controlled. Compare interleaved blocks rather than absolute times across runs. Neither the input schedule nor JavaScript callbacks measure physical presentations.
