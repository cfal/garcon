# Two-column GTK scroll coverage

Two columns **1,004 px apart** exposed the virtual sizer at matching heights in three of four normal-position wheel trains with **zero JavaScript viewport scroll writes**. Neither of the two absolute-`top` control trains did. This narrows the [single-column observation](scroll-row-stripe.md); it does not establish missing text between the columns, full-width blanking, or a positioning fix.

| Placement / train | Pairs during dispatch | Left / right affected | Same-y pairs | Longest common band | Same-y pairs in first second after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal down 1 | 66 | 0 / 0 | 0 | 0 px | 0 / 76 |
| Normal up 1 | 64 | 22 / 22 | 22 | 221 px | 18 / 80 |
| Normal down 2 | 63 | 5 / 6 | 5 | 49 px | 0 / 80 |
| Normal up 2 | 62 | 13 / 12 | 12 | 137 px | 0 / 79 |
| Top down | 69 | 0 / 0 | 0 | 0 px | 0 / 80 |
| Top up | 63 | 0 / 0 | 0 | 0 px | 0 / 80 |

**What was measured.** WebKitGTK 2.50.6/Xvfb; disposable `58a2bdf0a` row-experiment build, unchanged paragraph corpus (98 entries), one 1520 x 806 feed. Both modes kept normal virtualization and real content. Four default `translateY` trains preceded a full reload with `?rowPosition=top`; placement and equal row geometry/content were checked. Each train delivered 14 trusted 120 px wheel events and moved exactly 1,680 px in the intended direction, starting at row 46 down or 66 up, offset -5 px. Two top trains, always last, are not an estimate of comparative reliability.

**Pixel controls.** Read X11 root columns x=344 and 1348 at y=78..883: one near the sizer's left edge, one at 68% of its width. Each has its own sizer and real-wrapper markers. Both baselines and restorations had no holes. Muting either marker on row 52 exposed exactly 64 px at relative y=445..508, with the other column intact. A far-right candidate failed static calibration before any wheel input and was not used.

**Timing.** Each pair used sequential `XGetImage` calls, left then right. “Same-y” means at least one identical y offset was unmarked in both reads; in these trains every affected pixel showed its respective sizer marker. The reads are **not simultaneous**. First request to second reply was at most 20.678 ms among affected dispatch pairs (27.319 ms across all train pairs). Pair cadence was 12.499 ms median, 13.481 ms p95, 90.601 ms max. For the 221 px band at y=0..220, the requests/replies were +550.283..552.019 ms left and +552.019..552.060 ms right from first dispatch. Neither strip samples nor repeated images are physical frames.

The [CSV](scroll-row-paired-stripes.csv) assigns a pair only if both read windows are strictly inside a phase. No affected pairs fell outside the tabulated windows. Neither column was affected 1..4.5 s after final wheel acknowledgement or in the 4.5..6 s window (0/720 late pairs). At checks targeted for +0.35 s and +6.075 s the **custom scrollbar was hover-visible at 100% opacity** on every train; no scrollbar opacity transition ended. This is late-settle evidence, not an observed scrollbar fade.

**Write guard.** [Virt's DOM writer](../../../web/src/lib/virt/virtual-list-dom-driver.ts#L91-L96) assigns `viewport.scrollTop`. Only that feed instance's setter and its `scroll`, `scrollBy` and `scrollTo` methods were wrapped, delegating to the originals. A no-op assignment and `scrollBy(0,0)` verified the hooks outside acquisition. All six trains had zero writes or method calls from before input through late readback, with the hooks still attached. This rules out a Virt setter correction during these trains, not native movement or paint work. Other elements, direct prototype calls, native engines and assistive technology were not instrumented.

## Final product builds

**Removing the ordinary user bubble's resting shadow did not eliminate sampled gaps.** One down/up pair per build, no positioning or paint flags. Counts are paired reads with a common sizer band at the same y, not physical frames. Rows are in run order.

| Build / direction | During dispatch (max band) | First second after (max band) |
| --- | ---: | ---: |
| Stock down | 0/63 (0 px) | 31/80 (806 px) |
| Stock up | 8/61 (377 px) | 16/80 (377 px) |
| Candidate up | 0/65 (0 px) | 6/80 (309 px) |
| Candidate down | 11/62 (649 px) | 0/80 (0 px) |

Both builds used the same Virt changes. At each start all 14 mounted user bubbles were closed: 14 had a computed shadow on stock, zero on candidate. All 100 wrapper sizes and all visible start rectangles matched by direction. The same columns and independent 64 px removal controls passed in both fresh sessions. Each train delivered 14 trusted notches, moved exactly +/-1,680 px and made zero JS viewport writes or scroll-method calls. Neither column was affected in the 4.5..6 s window (stock 0/238; candidate 0/240); the custom scrollbar remained hover-visible at late readback. The candidate's 649 px band was observed at y=157..805 in both columns within a 0.321 ms read envelope. This demonstrates a remaining gap, not its frequency, full-width text loss, or a reversal of the separately measured speed improvement.
