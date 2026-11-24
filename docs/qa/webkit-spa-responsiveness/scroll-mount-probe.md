# Transcript mount control

This is a diagnostic bundle, not an application change. Build from `cb649885f` with that checkout's installed dependencies. The zero-context patch targets those exact sources. From the checkout root:

```sh
repo=$PWD
probe=$(mktemp -d "$HOME/tmp/garcon-scroll-probe.XXXXXXXX")
mkdir -p "$probe/web/node_modules" "$probe/scripts"
rsync -a --exclude '/node_modules' --exclude '/.svelte-kit' --exclude '/build' web/ "$probe/web/"
ln -s "$repo/common" "$repo/node_modules" "$probe/"
ln -s "$repo"/web/node_modules/* "$repo/web/node_modules/.bin" "$probe/web/node_modules/"
cp scripts/runtime-shell.ts "$probe/scripts/"
patch -p1 --fuzz=0 -d "$probe" < docs/qa/webkit-spa-responsiveness/scroll-mount-probe.patch
(cd "$probe/web" && RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 bun run build)
```

Serve **that copy's** `web/build` for every comparison. Use an isolated fixture/controller, one visible synthetic feed of at most 150 entries, fixed viewport, fonts, wrap width, surface, view ID and settings. Block service workers or isolate the origin. Full-load the chat URL with the query below; this is document-scoped configuration, not an SPA toggle.

| Query | Control |
| --- | --- |
| No query | Normal keyed range and real message subtrees. |
| `?scrollProbe=retained` | Keep all projected rows mounted once the visible feed has a Virt range. Includes spacers; verify mounted equals model count and real rows are present before acquisition. |
| `?scrollProbe=light-rows` | Keep normal range, input, row keys, attachments, estimates and measurements. After arming, only **entering** transcript/tool-group rows with a captured size replace their heavy subtree with an empty measured-height block. Still-mounted real rows stay real. Missing keys render real content; boundaries and spacers remain real. |

For light rows, visit the entire scroll corridor on a **normal** page at settled geometry. Call `window.__garconScrollProbe.capture()` after each step; its final return value is the cumulative map of full virtual key to `[width,height]` (CSS pixels, no row content). Include overscan, settle content/fonts, and keep the same fixture data across page loads. On the fresh light page, let the initial real rows settle, then use this in one browser call:

```js
window.__garconScrollProbeSizes = table;
return window.__garconScrollProbe.arm();
```

`info().feeds[0]` exposes `entries`, `model`, `mounted`, `placeholders`, and `missingMountedSizes`. `validate()` compares mounted wrapper rectangles to the captured table and returns `checked`, `missing`, `maxWidthError`, and `maxHeightError`. Reject a light comparison with missing corridor coverage, unmatched dimensions, or no actual placeholder entries. The control removes content, not just mount JavaScript: painting, text, semantics and interactions inside placeholders are deliberately absent.

Add `scrollProbeCounters=1` only in **separate** attribution runs. Call `reset()` before the wheel sequence and `counters()` after. `driverScrollMs` covers synchronous Virt scroll callback time, not subsequent Svelte flush, style, rendering or paint. `mountReadMs` covers prepaint mount reads before transaction application; `geometryReadMs` can overlap driver time. Resize samples classify first, unchanged and changed physical sizes, not paints. Counters aggregate Chat feeds in this document. Never call `capture()`, `info()`, or `validate()` inside a timed scroll sequence; these deliberately inspect the DOM. No probe timer or counter is active in uninstrumented runs.
