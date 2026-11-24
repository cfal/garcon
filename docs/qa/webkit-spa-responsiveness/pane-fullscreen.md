# Tiled pane fullscreen

Returning to twelve chat panes cost more than entering fullscreen even though neither operation replaced any feed. On production build `cb649885f`, the median to two animation-frame callbacks was **527 ms in / 650 ms out on WebKitGTK** and **72 ms in / 141 ms out on Chromium**. One pane has a working fullscreen button: it fills the host in both states, but its actual rectangle changes on entry and returns on exit. The [desktop shell](../../../web/src/lib/components/layout/AppShell.svelte#L773) collapses the sidebar width in fullscreen, even with only one pane. This is not a no-op control or the browser Fullscreen API.

| Chat panes | Button | Chromium: state, ms | Chromium: two frames, ms | GTK: state, ms | GTK: two frames, ms |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | enter | 3.8 (3.3 to 4.1) | 25.75 (13.4 to 27) | 19.5 (13 to 35) | 102.5 (99 to 178) |
| 1 | exit | 3.65 (3.2 to 5.7) | 26.65 (24.6 to 28.6) | 24.5 (11 to 28) | 105.5 (95 to 131) |
| 4 | enter | 14.15 (12 to 20.4) | 43.1 (36.8 to 52.3) | 66 (48 to 110) | 275.5 (215 to 335) |
| 4 | exit | 36.45 (31.6 to 45.3) | 61.5 (54 to 70.6) | 123.5 (118 to 219) | 298 (243 to 412) |
| 12 | enter | 31.95 (27.3 to 43.9) | 72.25 (68.9 to 88.3) | 110.5 (90 to 152) | 526.5 (427 to 605) |
| 12 | exit | 78.5 (74 to 107.5) | 141.1 (122.6 to 175.8) | 355 (322 to 398) | 650 (554 to 1037) |

Median (minimum to maximum), eight warm gestures per cell. [Individual gestures](pane-fullscreen.csv) include the discarded warmups. Timings start at the in-page capture of the trusted pointerdown on the current pane's titlebar button. State is the first observer callback that sees the expected button label; two frames is the second nested animation-frame callback after that observation. Neither is a display-scanout measurement. The observer watches only the button label. Geometry, pane identities, reading position and focus are checked outside that timing.

**Where to look next (source inference, not a trace):** Entry suspends eleven feeds. Exit makes those same feeds run their [visible projection](../../../web/src/lib/components/chat/transcript/ConversationFeed.svelte#L362) again. For each, the DOM driver [re-observes the viewport and mounted rows](../../../web/src/lib/virt/virtual-list-dom-driver.ts#L270), and the [resume transaction](../../../web/src/lib/virt/virtual-list-transaction.ts#L398) reads geometry, publishes the range and restores the end or keyed reading position. A [full remeasurement of mounted rows](../../../web/src/lib/components/chat/transcript/ConversationFeedVirtualController.svelte.ts#L799) is conditional, for example on a width change while hidden; it is not an unconditional scan of every transcript. The probe verified retention and timings, not how many milliseconds each path took.

The [production fullscreen attribution](pane-fullscreen-attribution.md) measures which of those calls actually took time and tests bypassing the first slow width read at fixed tile geometry.

## Behavior

- On every entry, the current pane filled the workspace. At 4 and 12 panes, respectively, 3 and 11 other panes had no presented rectangle and were both inert and ARIA-hidden. Their original panel and scroll viewport elements remained connected; no hidden pane claimed the primary scroll region, commands, or composer anchor. Every exit restored all original pane rectangles within one CSS pixel.
- The original Source textarea retained its draft and was focused after every button gesture. In a separate twelve-pane check, the real `Ctrl+Shift+F` shortcut entered and exited fullscreen with the same draft, focus, and selected character range. Selecting the recipient after restoration, then the original chat, bound the command owner and composer to the correct draft each time.
- One background reader started halfway up its history at 4 and 12 panes. Its first intersecting row and viewport offset returned unchanged on all 40 multi-pane exits across both engines, including warmups. The active pane's end gap was zero on every exit.
- Once per engine at 12 panes, a held synthetic turn completed in the hidden reader. The browser observed the hidden tab's processing indicator turn on and then off; the same chat's terminal processing broadcast follows its messages. At that barrier the mounted hidden feed's model count had not grown and it did not render the new text. After restoration, the count grew, the reading anchor was unchanged, and scrolling to the end showed the assistant's actual echo. This tests delivery across a hide/reveal, not sustained streaming.

## Scrolling after the toggle

**Eleven quiet hidden chat panes did not consistently slow the same fullscreen scroll.** This is a separate WebKitGTK control on the production build, not a timing of the toggle. A real titlebar click put the same 98-entry chat fullscreen before each block. The active feed was at `(0, 40)`, exactly **1840 x 806** in both conditions, with the same Formatted draft, command owner and 100 virtual model items. A had one connected feed; B retained all twelve original feeds, eleven hidden and inert. Only one feed was presented in either case.

| Fullscreen condition | Measured trains | Median typical callback gap, ms | Median worst callback gap, ms (range) |
| --- | ---: | ---: | ---: |
| A: one feed | 12 | 119 | 204.5 (157 to 344) |
| B: twelve retained, one presented | 12 | 108.5 | 196.5 (134 to 290) |

Each recorded train delivered 14 trusted pixel-mode wheel events of 120 px at a target 60 ms cadence and moved exactly +1680 or -1680 px. Down started at virtual index 46, offset -5 px, and ended at 67, -73 px; up went from 66, -5 px to 44, -23 px. The active feed mounted 29 wrappers at both down endpoints and 29 then 30 for up. The [wheel probe](measure-wheel-train.js) brackets the first wheel through the final scroll with animation-frame callbacks. The table takes each train's median and maximum callback interval, then the median of each across trains. These are callback gaps, not wheel-handler times or physical frame presentations.

The primary order was A/B/B/A: one warmup pair then three measured down/up pairs per block. Session 1 completed A/B/B (median worst gaps **179.5 / 237 / 170 ms**). On the final A, after its two valid warmups, WebDriver failed to serialize a script result; no metric from the interrupted train was accepted. In a new GTK session a supplemental B immediately followed by replacement A gave **243 / 241 ms**. Only replacement A enters the primary table. The within-condition variation exceeds the pooled 8 ms difference; this is not evidence of a speedup or proof of equal performance. It does separate the cost of revealing eleven panes from scrolling with them already hidden. Do not compare the absolute gaps to a differently sized tiled or non-fullscreen feed.

[Per-train samples](pane-fullscreen-scroll.csv) include the primary blocks, the two excluded warmups from the incomplete block, and the separate supplemental block. For replication, seed a 12-chat catalog with one 28-paragraph echo per chat, then add 48 variable-height echo turns to the selected chat. Load the 1- or 12-pane layout, enter fullscreen, check the retained feeds and matching viewport, position the selected row, and run the probe with a fresh WebDriver wheel input-source ID for each notch. No transcript traffic, diagnostic row substitutions or Inspector instrumentation during the trains.

## Reproduce the toggle matrix

Use the [opt-in runner](../../../integration-tests/scripts/pane-fullscreen.ts) with a current production web build and installed Playwright Chromium or a dedicated local WebKitGTK WebDriver. It creates its own temporary integration server, fake provider and browser session. It does not accept an app-server URL. Run the engines separately without competing benchmarks or builds:

```sh
mkdir -p "$HOME/tmp"
TMPDIR="$HOME/tmp" bun integration-tests/scripts/pane-fullscreen.ts --engine=chromium
TMPDIR="$HOME/tmp" bun integration-tests/scripts/pane-fullscreen.ts --engine=gtk --webdriver=http://127.0.0.1:PORT
```

Each engine used a separate fresh fixture with the same content: 12 chats, eight completed three-paragraph echo turns per chat, Source drafts, no active turns during timing. Balanced split layouts were loaded in order 1, 4, 12, 12, 4, 1. Each block started from a fresh app document, actual feed rows and a ready editor. The first enter/exit pair warmed the block; four more pairs were measured. That is 60 button gestures per engine, 48 used in its medians. The detached reader was positioned by script, not a timed user scroll. Both engines used a verified 1840 x 960 CSS-pixel viewport: headless Chromium 156.0.8078.4 and standalone Linux WebKitGTK 2.50.6 MiniBrowser with normal WebDriver capabilities and no Inspector.

Output is JSONL with no chat identifiers, tokens, or transcript content. A final `complete` record follows browser and fixture cleanup. `--smoke` exercises behavior without publishing timings; `--panes=4` and `--rounds=2` limit a diagnostic run. CSV times are rounded to 0.1 ms; empty reader/end-gap cells mean not applicable, not zero.

This is one Linux VM, one fixture shape and the currently selected pane in Source mode. The [default fullscreen sidebar policy](../../../web/src/lib/stores/local-settings.svelte.ts#L280) was unchanged in every block. The one-pane control includes sidebar layout and input/driver/frame scheduling, but no other panes to hide. The growing cost, especially on exit, rules out feed remounting as a necessary explanation; it does not identify a particular style, layout, or application callback as the cause. These results are not an iPhone, GPU-backed desktop, physical presentation, or population-tail benchmark.
