# Graph interaction cancellation

The pinned graph engine has no complete gesture abort. These Bun patches add
`abortInteractions(host)` (re-exported by `@xyflow/svelte`) for connection,
reconnection, node/selection dragging, and marquee selection. Canvas calls it on
blur, hiding, pointer cancellation, editing disablement, source removal, and
unmount. Viewport pan/zoom remains owned by the existing zoom transport.

- `d3-drag@3.0.0`: cancels private gesture bookkeeping and owned listeners;
  balances selection suppression shared with zoom.
- `@xyflow/system@0.0.82`: registers gestures by graph host, finalizes before
  callbacks, and fences asynchronous auto-pan work.
- `@xyflow/svelte@1.6.6`: wires component destruction, pane capture, and the typed
  `oninteractioncancel` callback.

References: [XYFlow 1.6.6](https://github.com/xyflow/xyflow/tree/0a1f9575b25679f2880175de8d3eae21aedde921)
and [D3 drag 3.0.0](https://github.com/d3/d3-drag/tree/1b88d8a2d69fca86d4d90a8329987693b79ec506).

When upgrading, keep ESM, UMD, and declarations aligned. The UMD artifacts were
regenerated from the patched sources using Rollup 4.59.0 and Terser 5.46.0 with
D3 imports external. D3's UMD globals share `d3`; system globals use `d3Drag`,
`d3Selection`, `d3Zoom`, and `d3Interpolate`.

Regression coverage lives in `CanvasFlow.test.ts`,
`canvas-gesture-lifecycle.test.ts`, and
`integration-tests/tests/chromium/chat-canvases-abort.test.ts`. Run the complete
Canvas Chromium suite to check ordinary graph interactions alongside aborts.
