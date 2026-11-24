# GTK transcript stripe coverage

On WebKitGTK 2.50.6 MiniBrowser/Xvfb, the sizer showed through one marked column in all three production down trains (52/370 samples), never up (0/376). All 52 affected reads were inside wheel dispatch. The full 806 px column showed sizer color for 8, 13 and 11 consecutive samples respectively. First-to-last sample midpoints spanned 88, 149 and 125 ms, not proven continuous blank durations.

On the [diagnostic bundle](scroll-mount-probe.md), all four normal trains exposed partial bands. **Retaining every wrapper did not eliminate missing paint at this column**: one down train showed a band up to 120 px in 22/67 reads inside dispatch; the other down and both up trains were clean. All retained trains ended with the same 100 wrapper nodes (98 real messages, no placeholders). Neither mode reproduced the production full-height band.

## Rerun

1. Load 98 synthetic entries in one 1520 x 806 feed (1840 x 960 viewport, device scale 1). Run production separately; on the diagnostic fixture use fresh normal, retained, retained, normal documents (1480 px wrap). Anchor index 46 down or 66 up at -5 CSS px.
2. Paint a 6 px `#ff00ff` background stripe 2 px from the left of `[data-chat-virtual-sizer]`. Give each direct `[data-chat-virtual-item]:has([data-chat-row-id])` a matching absolute, pointer-transparent, full-height `::after` above content: `#00ff00` for even indices, `#00ffff` for odd. Verify unchanged feed size, scroll position and anchor.
3. Use temporary top/bottom fiducials to locate a 1 x 806 root-window strip 4 px from the sizer's left; remove them. Independently sample with X11 `XGetImage` every 12.5 ms, bracketing each read on the input sender's `CLOCK_MONOTONIC`. Require zero unmarked pixels at rest; disable only row 52's stripe (expected 64 px at y=445..508); restore and require zero again.
4. Sample before input through settlement. Send 14 trusted pixel-mode W3C wheel actions of +/-120 px at a target 60 ms interval, unique source ID per notch. Verify event count, +/-1680 px movement, and new normal versus unchanged retained wrappers.

## Reading the samples

[Per-phase CSV](scroll-row-stripe.csv): gaps are nearest-rank percentiles between acquisition midpoints. A row pixel has red=0 and green=255; any other pixel counts as unmarked. Bands are contiguous. `during_*` requires both request and reply strictly inside first dispatch to last acknowledgement; `during_full_sizer` counts all-magenta reads. Eight affected diagnostic-normal reads were wholly post-dispatch; none preceded or straddled dispatch. Empty fields mean no input. Repeated samples count.

Representative reads relative to first dispatch: production down 2, +283.079..286.779 ms, all 806 px magenta; +445.593..445.804 ms, 293 magenta with a 214 px band at y=325. Retained block 2 down, +470.403..471.410 ms, 230 magenta with a 120 px band at y=359. The production positive control had 53 magenta and 11 other pixels in the expected 64 px band.

Two setup failures preceded input: production clock calibration and diagnostic block 3 anchoring (fresh browser). No reported train samples were excluded. One software-rendered column cannot establish full-width blanking, DOM absence or physical display frames. Markers can change paint; stale content and between-read events can escape detection.
