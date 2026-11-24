# Matched WebKitGTK scroll coverage

Upgrading only the Debian WebKitGTK release did **not** eliminate the previously observed gaps. On 2.52.6 both marker columns showed the background at every y in the 806 px viewport during a measured down train. These are two sequential display reads, not proof of a blank full-width frame.

| Production bundle at `39a970d23`; 4 measured trains per release | 2.50.6 | 2.52.6 |
| --- | ---: | ---: |
| Pairs with common background in dispatch loop / all pairs | 3/261 | 10/250 |
| Largest common contiguous band in dispatch loop | 27 px | 806 px |
| Pairs with common background / pairs in first second after | 3/320 | 10/320 |

On 2.52.6, measured pair 2 down, a pair of reads at +462.007..462.520 ms from sampler arm returned 806 exact sizer pixels on each column and no other colors (last acknowledgement +782.418 ms). On 2.50.6 the measured maximum was y=779..805 at +724.672..725.145 ms of pair 1 up (last acknowledgement +807.889 ms).

Each fresh browser/fixture ran down/up once for warmup then down/up twice for measurement. [Per-train data](matched-gtk-stripes.csv) includes warmups as pair 0. All twelve trains delivered 14 trusted pixel-mode wheel notches, moved exactly 1,680 px, and made zero JavaScript writes through the receiver's scrollTop setter or scroll methods. Content/controls/geometry digests across all 100 wrappers matched, as did every intersecting wrapper index, top and height at every start and endpoint. Versions ran in sequence, not randomized. **No comparative frequency, speed, physical GPU or iPhone claim.**

**Environment.** One disposable amd64 `debian:trixie-slim` image (index `sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0`), one 2200 x 1250 x 24 Xvfb, GTK 3.24.49, Mesa 25.0.7, scale 1, same installed fonts, same build, 1840 x 960 browser and 1520 x 806 feed. Both MiniBrowsers' `webkit://gpu` reported X11, llvmpipe (LLVM 19.1.7, 256 bits) and DMABuf with shared memory support. `dpkg-query -W` differed **only** for `webkitgtk-webdriver`, `libwebkit2gtk-4.1-0`, and `libjavascriptcoregtk-4.1-0` at `2.50.6-1~deb13u1` vs `2.52.6-1~deb13u1`. The old package additionally required `libwoff1`; installed in both arms. This does not isolate [WebKit 305441](https://bugs.webkit.org/show_bug.cgi?id=305441) or reproduce the upstream scrollbar-fade trigger.

**Reproduction.** On the disposable Trixie container install the three matching packages, Xvfb, Xauth, D-Bus, Mesa utilities, DejaVu/Liberation fonts and `python3-xlib`. Debian Snapshot's [old](https://snapshot.debian.org/package/webkit2gtk/2.50.6-1~deb13u1/) and [new](https://snapshot.debian.org/package/webkit2gtk/2.52.6-1~deb13u1/) versions contain the matching trio. Start a fresh driver per release with identical display and env: `GDK_BACKEND=x11 GTK_OVERLAY_SCROLLING=0 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe LP_NUM_THREADS=2`. From the repository root, after `bun run build`:

```sh
bun integration-tests/scripts/transcript-row-scroll.ts --webdriver=http://127.0.0.1:PORT \
  --pairs=2 --expect-bubble-shadow=absent --stripe-container=CONTAINER --stripe-display=:97
```

The runner locates two display fiducials, removes them, then checks the static markers. Suppressing each of row 52's markers in isolation must uncover precisely its 64 px band at relative y=445..508 without disturbing the other column. Baseline and restoration must have no holes. Missing row ink can expose real message pixels as well as sizer ink; the results above count **only exact common sizer ink**. Acquisition uses two X11 root-column reads 1,004 px apart, at a target 12.5 ms cadence. Both reads must fall strictly inside the reported phase. The first phase starts at sampler arm immediately before scheduling the first notch, not the timestamp of the first native wheel event, and ends at the last acknowledgement. The sender and sampler verify a common Linux monotonic clock.

The [compact capture](matched-gtk-capture.jsonl) records the package/renderer checks and per-train visible rectangles, displacement and JS writes. Each sample is `[start_us, end_us, longest_common_sizer_band_px]` from sampler arm; the phase counts can be recomputed against `armToAckUs`. The runner also emits individual-column color counts and first/last unmarked offsets. These instrumented runs are not unmarked wheel-latency benchmarks.

Two old-engine preflights failed before any measured dispatch: Bun's process-relative timer did not match X11's monotonic clock, then a one-sided control incorrectly required sizer color beneath every disabled pixel. The accepted runs use the OS clock and the exact row/column geometry controls above. No app-side CSS or scrolling policy changed.
