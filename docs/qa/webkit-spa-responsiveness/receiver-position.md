# Typing with a pinned or scrolled-back neighbor

The same completed reply advanced the receiving pane's model in both positions. At settlement the reply was mounted and in view only in the pinned pane. Typing in A reached native input at the same median, but the callbacks following input came later with C pinned.

| From A's trusted keydown, median ms | C pinned | C scrolled back |
| --- | ---: | ---: |
| Native input | 4 | 4 |
| First animation-frame callback | 36 | 29 |
| Second animation-frame callback | 59 | 47.5 |

WebKitGTK 2.50.6 on Trixie/Xvfb/llvmpipe. Four visible desktop tiles at 1840 x 960. Four fresh fixture/browser blocks in pinned, detached, detached, pinned order; one excluded warmup and four measured keys per block. In each, C began with the same 84 synthetic entries, a 760 x 440 viewport, and an end gap of 0 or 1,302 px after a native wheel. The same four measured history lengths apply to both arms. All 16 edits passed trusted input, original focused editor, exact draft/caret and Backspace restoration. The assistant reached the app socket during 7/8 pinned and 8/8 detached key windows; the pinned receipt 45 ms before keydown remains in the medians.

C's held user row was committed and projected **before** the timed key. Only then was the completed assistant reply released alongside the native key. The page's two wire ordinals and view had to match the ledger's final two presented entries after the successful terminal. Each row advanced the entry count, virtual model count and data revision by one without shifting the loaded head. The pinned assistant had to intersect the viewport; the detached one had to be absent from the mounted DOM with the same first intersecting durable row, pixel offset and scroll position (1 px tolerance). A subsequent explicit return to latest showed the exact reply. This is not partial token delivery.

In separate instrumented blocks, the two measured pinned replies each triggered two JS viewport writes and one native scroll event. The virtual sizer gained/lost 3/2 wrappers and 4/3 respectively. Both detached replies produced zero writes, scrolls, wrapper adds or drops. Instrumentation covered only C's own viewport setter/methods and direct virtual wrappers between settled user and assistant observations; it was absent from the timing blocks. Counts do not establish either write was redundant or separate mounting from style/layout and paint. The frame intervals overlap; neither rAF is a pixel timestamp. Do not disable bottom-follow or defer visible replies on this evidence.

The next discriminator is whether the two calls reach **different physical ends**. An estimated append, a later row measurement, and an explicit end request can all reach [the same DOM writer](../../../web/src/lib/virt/virtual-list-dom-driver.ts). In a separate attribution run, record the [transaction source and reason](../../../web/src/lib/virt/virtual-list-transaction.ts), the requested offset, and physical maximum and actual offset immediately before/after the assignment. A stale planning read or a single coalesced scroll event cannot distinguish a necessary correction from a same-value write.

Reproduce from the repo root with a gated production build and a dedicated loopback WebKitWebDriver:

```sh
bun integration-tests/scripts/composer-input.ts --webdriver=http://127.0.0.1:PORT --receiver-position=pinned
```

Run the four positions above serially, then one fresh block per position with `--receiver-counters`. [Block starts and outcomes](receiver-position-blocks.csv); [all samples](receiver-position.csv), including warmups and counters. A prior detached-only warmup smoke validated the method and is not in the matrix. No iOS touch or scroll behavior was tested or changed.
