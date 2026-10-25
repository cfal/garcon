# Dependency Patches

## Svelte derived reconnection

The local patch was retired in `svelte@5.57.2`, which includes the upstream fix
for [duplicate derived subscriptions on reconnect](https://github.com/sveltejs/svelte/issues/18898)
from [PR #18899](https://github.com/sveltejs/svelte/pull/18899). Duplicate subscriptions
previously retained detached conversation views when switching chats.
Keep `scripts/__tests__/svelte-derived-reconnect.test.js` and
`integration-tests/tests/chromium/chat-view-lifetime.test.ts` as regression coverage.

## Bits UI focus-scope mounting

`bits-ui@2.19.5` already includes the deferred-autofocus ownership and focus guards.
The remaining patch makes mounting the same container idempotent. Remounting an
unchanged scope otherwise schedules initial autofocus again and can take focus
from a menu item the user already selected.

Coverage lives in `WorkspaceWindowTitleBar.test.ts` and
`integration-tests/tests/chromium/file-editor-polish.test.ts`.

## Vim shared history

`@replit/codemirror-vim@6.4.0` accepts per-editor `undo`, `redo`, and `save`
callbacks through its extension options. Garcon's documents own history rather
than individual CodeMirror views; Vim normal and Ex commands must use the same
canonical history and checked Save as the workbench. No global Vim mappings or
commands are overwritten. Keep ESM, CJS, and both declaration files aligned on
upgrade. Unit coverage lives in `file-vim-mode.test.ts`; browser integration
coverage lives in `integration-tests/tests/chromium/file-editor-polish.test.ts`.

Reference: [Vim adapter](https://github.com/replit/codemirror-vim/blob/8640966b6977f84d2197e6adfd521fb737184587/packages/codemirror-vim/src/cm_adapter.ts#L112).

## Graph patches

The pinned graph engine has no complete gesture abort. These Bun patches add
`abortInteractions(host)` (re-exported by `@xyflow/svelte`) for connection,
reconnection, node/selection dragging, and marquee selection. Canvas calls it on
blur, hiding, pointer cancellation, editing disablement, source removal, and
unmount. Viewport pan/zoom remains owned by the existing zoom transport.

- `d3-drag@3.0.0`: cancels private gesture bookkeeping and owned listeners;
  balances selection suppression shared with zoom.
- `@xyflow/system@0.0.83`: registers gestures by graph host, finalizes before
  callbacks, and fences asynchronous auto-pan work.
- `@xyflow/svelte@1.7.0`: wires component destruction, pane capture, and the typed
  `oninteractioncancel` callback.

References: [XYFlow 1.7.0](https://github.com/xyflow/xyflow/tree/3d35b57317576b0916c0bfeaaedd573aaacc2839)
and [D3 drag 3.0.0](https://github.com/d3/d3-drag/tree/1b88d8a2d69fca86d4d90a8329987693b79ec506).

When upgrading, keep ESM, UMD, and declarations aligned. The UMD artifacts were
regenerated from the patched sources with D3 imports external. The system UMD
uses Rollup 4.64.7, Terser 5.51.2, and `@rollup/plugin-replace` 6.0.3 to replace
`process.env.NODE_ENV` with `"production"`, matching upstream's browser build.
D3's UMD globals share `d3`; system globals use `d3Drag`,
`d3Selection`, `d3Zoom`, and `d3Interpolate`.

Regression coverage lives in `CanvasFlow.test.ts`,
`canvas-gesture-lifecycle.test.ts`, `canvas-provider-lifecycle.test.ts`, and
`integration-tests/tests/chromium/chat-canvases-abort.test.ts`. Run the complete
Canvas Chromium suite to check ordinary graph interactions alongside aborts.
`integration-tests/tests/chromium/chat-canvas-provider.test.ts` checks the UMD
in a browser without a Node global shim. The root development dependency on
`@xyflow/system` gives these contract tests the same pinned, patched provider.
`scripts/__tests__/xyflow-patch.test.js` also checks browser-global loading,
ESM/CommonJS export parity, and cancellation cleanup.

## Selector parser override

`@tailwindcss/typography@0.5.20` pins `postcss-selector-parser@6.0.10`.
The root override selects `7.1.6`, which fixes
[quadratic selector parsing](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
Typography's AST parsing and trailing-pseudo extraction APIs remain compatible;
`scripts/__tests__/typography-parser.test.js` covers those transformations.
Remove the override once typography's own dependency range selects a fixed release.
