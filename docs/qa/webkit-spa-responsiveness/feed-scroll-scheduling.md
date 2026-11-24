# Does the scrollbar or the virtual window explain the remaining delay?

These controls start at `e6e3fb1f8`, **after** removal of the resting user-bubble shadow. They test a tall transcript in Linux WebKitGTK, not mobile Safari. All flags are confined to a diagnostic build; no app preference was changed.

## Scroll surface

On one shared Bookworm VM, WebKitGTK 2.50.6, Xvfb 21.1.7 and Mesa 22.3.6, the first screening series gave the following medians, in milliseconds. Each gesture contributes one median callback gap and one largest gap, including the two intervals crossing its first wheel and last wheel/scroll. The reported numbers are the medians of those per-gesture statistics; a long gesture does not get extra weight.

| Condition | Measured gestures | Typical gap | Typical largest gap |
| --- | ---: | ---: | ---: |
| Normal | 12 | 53.5 | 107 |
| Hide custom track; its thumb and listeners still run | 8 | 35.5 | 94.5 |
| Omit custom scrollbar; keep native overflow and hide native chrome | 8 | 29.5 | 72 |
| CSS layout containment on viewport | 8 | 53.5 | 102.5 |
| CSS layout containment on each row | 8 | 59.25 | 132.5 |

The normal blocks themselves measured 72, 52.25 and 51.25 ms typical. A focused unit-test process overlapped the start of the series. The hidden-track blocks measured 28.5 and 66.25 ms; do not translate those differences into paint time. Removing the scrollbar also removes input/resize listeners and thumb updates. The feed's native **scrolling** is still active, but there is **no visible native scrollbar** in that arm. Older [pre-shadow controls](../../webkit-spa-optimization-results.md#alternatives-not-shipped) actually favored leaving the scrollbar alone.

**That apparent scrollbar win did not repeat.** A separate, serial nine-block run compared normal, paint containment on *only the real narrow track*, the existing always-shown scrollbar preference, and the no-track control. Every visible row's index and viewport-relative rectangle had to match the normal page at every start and finish. Containment had to preserve the real thumb's nonzero size and position to within 1 px. Neither containment nor changing the preference removes Bits' underlying thumb-position work.

| Follow-up condition | Measured gestures | Typical gap | Typical largest gap |
| --- | ---: | ---: | ---: |
| Normal | 12 | 80.75 | 198.5 |
| Real track with `contain: paint` | 8 | 72 | 191 |
| Always show the scrollbar when overflowing | 8 | 100.5 | 197.5 |
| Omit custom scrollbar | 8 | 89.5 | 175 |

The normal blocks spanned 76.5-93 ms typical and 147.5-229.5 ms for the per-gesture largest gap. Removing the thumb was no longer faster on the typical metric; the small difference for track containment does not establish an improvement in painted coverage or justify shipping a clipping change. The existing scrollbar, dragging and preference are unchanged. The experiment used a wheel over the **center of the feed**, not over the track.

## Virtual window changes

Stock adds/removes wrappers as the overscan and following buffer advance. A diagnostic rounded the contiguous ordinary render range outward to multiples of four rows, then unioned the existing retained keys. This batches changes to **which wrappers mount**; it does not throttle scroll events or change the virtualizer's range calculations. A separate control extended each edge by two rows without rounding, to test whether more ordinary rows alone would help. It is not an exact DOM-count match.

In order normal/rounded/extra/normal/extra/rounded/normal on a fresh fixture, the typical / typical largest callback gap was **92 / 174 ms** normal, **73.75 / 153.5 ms** rounded, and **79 / 196.5 ms** with two extra per edge. The two rounded blocks had typical gaps of **63.5 and 100.5 ms** against normal blocks of 84, 91.75 and 92. Settled endpoint counts were 29-30 stock, 32 rounded, and 33-34 with extra rows. All arms matched every visible rectangle at both ends and the formula for each mounted range. A lower pooled median with one worse return block is not a reason to change the production window. No claim about during-motion pixel coverage, history prepend or focus retention.

In a **separate** counting run, a MutationObserver watched only the sizer's direct children, from before the train through settlement. The rounded down/up pair produced six wrapper-changing deliveries in each direction, versus 10/6 and 13/8 in the two normal pairs; fixed extra produced 10/11. The rounded down/up gestures added 20/24 wrappers; stock added 21/22. These are observer deliveries, not rendered frames; the instrumented callback gaps are not part of any timing table.

## Method

One synthetic chat with 98 entries and 100 virtual items, a 1520 x 806 CSS-pixel feed inside an 1840 x 960 window. Visit every row before each block; check ordered content, row sizes and interactive markup against the normal document. Position the first row at index 46 (down) or 66 (up), 5 px above the viewport. Send 14 trusted pixel-mode wheel actions, target cadence 60 ms, then wait for scroll and callbacks to settle. In all 66 screening trains, motion was exactly +/-1,680 px and final offsets were 67/-49 down or 44/-71 up. First-to-last wheel time ranged from 756 to 854 ms. The normal scrollbar was opaque at every measured endpoint. Sampling is bracketed by callbacks; this does not measure displayed FPS, blank pixels or physical touch latency. Normal and diagnostic timing runs have no mutation observer or Inspector attached.

The [sanitized CSV](feed-scroll-scheduling.csv) contains 178 trains: 162 with no mutation observer (108 measured, 54 warm-ups) and 16 with it. For each non-counting run, discard pair 0 in each block; take consecutive differences from `preceding_callback_ms` through the semicolon-separated `further_callbacks_ms`, then compute each train's median and maximum **before** aggregating by mode. Each run had a fresh fixture and is compared against its own normal blocks, not against other runs. All 178 trains passed the same input, displacement and end-anchor checks. These nominal CSS-pixel wheel actions do not reproduce touch inertia.

To reproduce, apply [the diagnostic patch](feed-scroll-scheduling.patch) with `patch -p1 --fuzz=0` to a disposable archive of `e6e3fb1f8` with the pinned dependencies, then run `bun run build` from that archive's root. The patch includes the stricter visible-rect and thumb checks added after the screening series. Run the [transcript scroll driver](../../../integration-tests/scripts/transcript-row-scroll.ts) with `--engine=gtk --webdriver=http://127.0.0.1:PORT --expect-bubble-shadow=absent`, one series at a time:

```text
--pairs=2 --modes=normal,hidden-track,no-track,viewport-layout,row-layout,normal,row-layout,viewport-layout,no-track,hidden-track,normal
--pairs=2 --modes=normal,track-paint,always-track,no-track,normal,no-track,always-track,track-paint,normal
--pairs=2 --modes=normal,chunk,extra,normal,extra,chunk,normal
--pairs=1 --count-mutations --modes=normal,chunk,extra,normal
```
