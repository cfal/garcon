# Web font optimization

Departure Mono and both JetBrains Mono faces are subset by hand and committed. Both Inter faces remain byte-identical copies of the originals because the proposed subsets changed browser metrics and rendering. Normal builds consume the WOFF2 files and CSS directly; they do not install Python, download source fonts, or run font processing. Public CSS family names, `font-display: swap`, fallback stacks, optical sizing, and default/system typography are preserved.

## Sources and inventory

The baseline is `7230e3e98e1139d0b998fc2599ca15b607452ad0`. [Source manifest](../scripts/fonts/sources.json) pins upstream commits and SHA-256 digests matching its five original assets. [Inventory](../scripts/fonts/inventory.json) records original and output bytes, glyph/character counts, axes, GSUB/GPOS features, hint programs/tables, actual cmap ranges, and hashes. OFL licenses are in [sources](../scripts/fonts/sources).

| Original face | Bytes | Glyphs | Characters | Original axes (minimum/default/maximum) |
| --- | ---: | ---: | ---: | --- |
| Departure Mono | 22,496 | 1,186 | 1,079 | Static 400 |
| JetBrains Mono | 113,672 | 1,754 | 1,372 | wght 100/400/800 |
| JetBrains Mono italic | 123,160 | 1,741 | 1,372 | wght 100/400/800 |
| Inter | 352,240 | 2,937 | 2,852 | wght 100/400/900; opsz 14/14/32 |
| Inter italic | 387,976 | 2,901 | 2,816 | wght 100/400/900; opsz 14/14/32 |

None of these originals has embedded glyph hint instructions. Browser auto-hinting still affects rendering; removing reference cmap entries can change it. JetBrains has a 7-byte `prep` and 8-byte `gasp` in each face; these control rasterization and are retained because removing them changes pixels. Departure uses CFF outlines; its CFF names, as well as the three subset faces’ name/PostScript records and variable-instance names, are renamed with a Garcon prefix. CSS aliases remain unchanged.

## Usage and fidelity budget

[Usage audit](../scripts/fonts/usage.json) records stylesheets, Svelte classes and inline `style:font-family` directives, CSS shorthands, and editor/terminal-generated styles. It includes source/message character inventories. The important exceptions to a simple 400/700 budget are tickets' 550 and 620 weights, the TypographyPreview component's independent inline family, editor bold/italic syntax styles, bold inside italic Markdown, and strong headings reaching 900. There are no explicit optical-sizing overrides, so Inter retains its entire automatic opsz 14–32 range. JetBrains retains wght 400–800; unchanged Inter retains its original wght 100–900 and opsz 14–32. No variable axis is pinned to a single value.

For the three subset faces, the retained feature allowlist is `calt ccmp clig curs kern liga locl mark mkmk rlig rclt tnum`, intersected with each source's actual tables. It preserves default shaping/positioning and the explicitly used tabular numbers in tickets, usage, and file search. In these subsets, unselected stylistic sets, character variants, small caps, fractions, superscripts/subscripts, and other opt-in alternates are removed. The inventories list every original and remaining feature by table. Inter retains all original features.

Garcon displays arbitrary chat, file, diagram, and terminal text. A scan of repository strings cannot bound that content. All existing cmap coverage is retained, including Latin-1, Latin Extended-A, Greek, Cyrillic, symbols and supported combining marks. Unsupported characters retain their previous system fallback. None of the five originals covers CJK, and no CJK font is introduced.

Core seeds are ASCII, NBSP, U+2010/U+2011, curly quotation marks, en/em dashes, ellipsis, current English UI messages, and common keyboard symbols. No current stylesheet enables `hyphens: auto`; U+2010 is nevertheless reserved for browser-generated hyphens. Every character connected to the seed by an active kerning/mark positioning lookup stays in the core. Supported combining marks, Unicode spaces and format controls are duplicated in both files. The extended face is declared first so the core wins overlapping runs. In particular, U+2001 must be in both files: isolated advances matched in the previous candidate, but `A ` and ` A` changed from 14 to 19 pixels at 12px. Every CSS range exactly equals its file’s cmap. There is no generated fallback face between core and extended.

Inter is deliberately not split. Review exposed changed advances for U+2212/U+2264 and changes to glyph ink bounds missed by the earlier fixed-text matrix. Keeping hidden reference glyphs was insufficient. The [pre-fix quick probe](font-optimization/glyph-regression-before.json) found 2,060 changed Inter glyph/configuration comparisons. Original Inter bytes, names, axes, features and loading semantics are restored; only the selected normal face is preloaded.

For JetBrains, the generator preserves original positive-weight `glyf`/`gvar` data and removes only tuples confined to the unused negative half of the weight axis. Generic FontTools axis instancing rounds inferred IUP deltas, shifting JetBrains' 0/8 outlines by half a font unit. The manual check compares every mapped output outline and advance against its source at boundary/fractional weights in addition to the browser pixel matrix.

## Loading

The original application has no font preloads. The new head preloads one normal core (the full normal face for Inter) per distinct bundled family selected in typography preferences. System/default selections preload nothing. Italic cores and all extended files load on demand. Vite's `no-inline` asset query preserves real files even for tiny subsets. Relative asset imports remain valid at runtime base paths.

Previously the service worker eagerly cached all emitted font formats, defeating font preference and unicode-range savings. It now caches fonts after a real request through the active worker. On activation, the new worker copies already-cached font responses listed in its immutable build manifest from retiring caches of the same mount before deleting them. It never fetches missing fonts or inherits unversioned static fonts. A delayed old-worker cache write is covered by its fetch-event lifetime; browser upgrade tests hold that write until the new worker is installed, then verify offline decoding at root and mounted URLs. Those cached current-build fonts remain available offline; a face never requested through the worker may use its existing fallback offline. This change is necessary for conditional downloads. Embedding core fonts in CSS and idle precaching extended fonts remain separate future work.

The real-worker probe verifies an empty font cache after installation, one JetBrains core after ASCII/quotes, and the extended JetBrains face only after adding ∑. [Cache observations](font-optimization/cache.json).

## Specialized fonts retained

[Specialized inventory](../scripts/fonts/inventory-specialized.json) also audits every KaTeX WOFF2 and both pinned external Monaspace Nerd Font faces. These resources are unchanged, rather than claiming an unverified rendering-preserving optimization:

- KaTeX: 20 WOFF2 files, **259,792 bytes**, with no variable axes or GSUB/GPOS features. Most contain real TrueType hint programs. Its lazy math renderer, glyph composition, and dependency-owned CSS retain all math coverage. The build also emits **303,116 bytes WOFF** and **513,664 bytes TTF** for older format fallbacks. One 3,624-byte WOFF2 is inlined in the lazy KaTeX CSS; the other 256,168 WOFF2 bytes have file URLs. These are alternative formats, not three downloads per glyph.
- Monaspace Neon NF: regular **1,260,028 bytes**, bold **1,275,000 bytes**, **2,535,028 bytes** together; 12,752 glyphs per face, static 400/700. Its existing terminal loader explicitly loads/registers both faces together and retains Nerd Font private-use fallback. Converting it to lazy split faces would change that activation/failure contract. No terminal loader, fallback, hinting, or font-display changes are included.

These 22 specialized faces are audited but not split or optimized in this change. Their retained byte cost is explicit above; the savings below apply to the five application-owned bundled faces. Math/terminal-specific subsetting needs its own exhaustive rendering and activation proof before replacing them.

## Regeneration

Run from the repository root with Python 3.12+ after installing the locked Bun dependencies (3.13 is shown):

```sh
python3.13 -m venv /tmp/garcon-font-tools
/tmp/garcon-font-tools/bin/pip install -r scripts/fonts/requirements.txt
/tmp/garcon-font-tools/bin/python scripts/fonts/subset.py
/tmp/garcon-font-tools/bin/python scripts/fonts/check.py
/tmp/garcon-font-tools/bin/python scripts/fonts/audit.py
```

Python 3.13 and the pinned requirements were used for these outputs. `uv venv --python 3.13 /tmp/garcon-font-tools` and `uv pip install --python /tmp/garcon-font-tools/bin/python -r scripts/fonts/requirements.txt` are equivalent setup commands. Source WOFF2 downloads are hash-verified and ignored by Git; generated assets, CSS, reports and licenses are committed. Regular tests consume committed subsets and do not require this source cache.

Rerun and review the usage audit when changing source versions, UI/localized characters, inline/component/editor font settings, weights, features, optical sizing, or the supported typography range. New content alone does not require regeneration because existing source coverage is preserved. Adding an activated OpenType feature requires changing the allowlist and rechecking shaping boundaries, not just rerunning the generator.

After regeneration, build and capture the same-content oracle:

```sh
bun run build
bun integration-tests/scripts/font-glyph-proof.ts /projects/font-proof/glyphs
/tmp/garcon-font-tools/bin/python scripts/fonts/pixel-diff.py /projects/font-proof/glyphs
bun integration-tests/scripts/font-matrix.ts /projects/font-proof/matrix
/tmp/garcon-font-tools/bin/python scripts/fonts/pixel-diff.py /projects/font-proof/matrix
bun integration-tests/scripts/font-proof.ts /projects/font-proof/application
/tmp/garcon-font-tools/bin/python scripts/fonts/pixel-diff.py /projects/font-proof/application
bun integration-tests/scripts/font-cache-proof.ts /projects/font-proof/cache
```

The scripts use isolated authenticated synthetic fixtures and new random ports. The application oracle uses one production build and identical synthetic content: before/control replace only bundled font-face rules with the full original sources and remove new preloads; after uses the real generated assets. Original read state and asynchronously loaded model labels settle before capture. This isolates the font change without introducing different application content. Service workers are blocked for per-page byte measurements and tested separately by the cache probe. Bytes are compressed font response bodies, excluding HTTP headers and unchanged application JS/CSS.

`pixel-diff.py` uses exact RGB comparisons with no tolerance or masks. It writes before/after difference images and independent original-font control differences. Different-sized rejected candidates are padded with white only to visualize/count the difference; actual dimensions are recorded and the check still fails. Any nonzero result exits with failure and must be inspected and explained; it is never silently blessed.

## Compressed font bytes

| Face | Before | Core / original | Extended | After combined | Saved |
| --- | ---: | ---: | ---: | ---: | ---: |
| DepartureMono-1.500.woff2 | 22,496 | 8,316 | 12,760 | 21,076 | 1,420 |
| JetBrainsMono.woff2 | 113,672 | 41,728 | 42,400 | 84,128 | 29,544 |
| JetBrainsMono-Italic.woff2 | 123,160 | 44,804 | 46,444 | 91,248 | 31,912 |
| InterVariable.woff2 | 352,240 | 352,240 | 0 | 352,240 | 0 |
| InterVariable-Italic.woff2 | 387,976 | 387,976 | 0 | 387,976 | 0 |
| **Total** | **999,544** | **835,064** | **101,604** | **936,668** | **62,876 (6.3%)** |

## Page downloads and preloads

Cold per-page WOFF2 response-body bytes, before → after. Desktop and mobile request the same fonts. All rows include the same synthetic chat underneath a dialog/editor where applicable; these are measured application scenes, not a bound on arbitrary future content. [Per-scene requests, preloads and computed typography](font-optimization/page-loads.json).

| Scene | System | Departure Mono | JetBrains Mono | Inter + JetBrains code |
| --- | ---: | ---: | ---: | ---: |
| Code, italics, bold inside italics | 0 → 0 | 22,496 → 8,316 | 236,832 → 86,532 | 853,888 → 781,944 |
| Accents and uncommon combining clusters | 0 → 0 | 22,496 → 21,076 | 236,832 → 128,932 | 853,888 → 781,944 |
| Symbols − ≤ ∑ and mixed U+2001 spacing | 0 → 0 | 22,496 → 21,076 | 236,832 → 175,376 | 853,888 → 824,344 |
| CJK with Latin body/code | 0 → 0 | 22,496 → 8,316 | 236,832 → 86,532 | 853,888 → 781,944 |
| Typography dialog with inline family | 0 → 0 | 22,496 → 8,316 | 236,832 → 86,532 | 853,888 → 781,944 |
| Editor component with its own font | 0 → 0 | 22,496 → 21,076 | 236,832 → 128,932 | 853,888 → 824,344 |

The baseline has no preloads. Afterward, System preloads none; Departure and JetBrains each preload their normal core; the Inter preset preloads the full Inter normal face and JetBrains normal core for code/editor. All preloads are deduplicated across the nine typography surfaces. Italics load on demand. No extended face is preloaded. No extended request occurs in the ASCII or CJK scenes; uncommon supported letters/symbols and the editor’s accented text request only the relevant extended faces.

## Rejected smaller candidates and deliberate deviations

[Rejected-option measurements](font-optimization/rejected-options.json) use the same 720-row typography matrix. No candidate below is shipped. These are archived experiments against an earlier 769,172-byte candidate and its original matrix text, not deltas against the final artifacts. The candidate later failed the expanded accent cases and is not shipped; the figures quantify why those more aggressive options remain rejected.

| Candidate | Extra combined saving | Core saving | Rendering change |
| --- | ---: | ---: | --- |
| ASCII/UI-only core without positioning/combining closure | 15,064 bytes | 393,084 bytes | 2,850,163 changed pixels across the three families: kerning, mark placement and face-boundary shaping |
| Remove JetBrains rasterization controls | 104 bytes | **172 bytes larger** | 829,842 changed JetBrains pixels: different rasterization |
| Restrict Inter to 400–800 | 14,568 bytes | 9,684 bytes | 487,875 changed Inter pixels, including a 53px narrower widest row; removes used 900 and alters fractional-weight interpolation. The other 127 changed pixels in this experiment are the generic instancer's separately fixed JetBrains digit rounding. |

The kept core is larger than the requested small ASCII split because preserving shaping takes precedence. All existing characters are retained instead of a fixed Latin/content-only budget because user content is unbounded; extended files cost nothing on pages that do not need them. Glyph hinting is absent in the five original UI faces; the source JetBrains raster-control tables are deliberately kept. Specialized math/terminal fonts remain untouched at the byte costs above. These are explicit deviations from minimizing/splitting every font; they preserve existing rendering or activation behavior.

The reviewed Inter split saved 86,312 combined bytes (normal 40,552; italic 45,760) versus originals, but changed glyph metrics and ink bounds. Those savings are rejected. Restoring Inter costs those bytes; adding shared spaces/format controls changes the three other combined faces by a net 32-byte reduction. The final total is 86,280 bytes larger than the reviewed unsafe candidate. This intentionally deviates from splitting and stripping every face to preserve rendering.

## Pixel comparisons

The expanded glyph oracle compares every original cmap character over normal/italic, 15 sizes from 9–36px, weights 400/500/550/600/620/700/800/900 and default/tabular features: **2,545,920 glyph/configuration comparisons**, plus **36,000 mixed-space comparisons**, with **zero advance changes** (default and tabular features) and **zero ink-bound changes** (default features). Both-direction contexts pair every supported Unicode space/format control with core and extended bases. [Glyph metrics](font-optimization/glyph-metrics.json).

All-glyph raster grids at 14px/400, both styles and default/tabular features, have **zero changed pixels across 20,951,040 pixels**. [Glyph pixels](font-optimization/glyph-pixels.json). The separate 720-sample matrix now includes U+2212, U+2264 and both-direction U+2001 runs, in addition to code, ligatures, kerning, accents, stacked marks, hyphens, Greek, Cyrillic and CJK. It also has **zero changed pixels across 60,452,496 pixels**. [Matrix results](font-optimization/matrix-pixels.json). The earlier matrix’s zero result covered only its sample text and did not establish full glyph fidelity.

The real application has **48 before/after pairs plus 48 independent original-font controls** (144 captures), at 1440×1000 and 390×1000. All visible text is identical across every before/after/control triple. Of **43,920,000 compared page pixels**, **23 pairs are exact**; 25 pairs contain **1,332 changed pixels**, all outside text. Every image has unchanged dimensions. The raw diff command deliberately exits nonzero; no tolerance or masks hide differences. [Every pair and its classification](font-optimization/application-pixels.json).

| Difference | Pairs | Changed pixels | Explanation |
| --- | ---: | ---: | --- |
| Rounded code/composer borders | 21 | 1,304 | Channel deltas 1–2 on rounded edges; also present in original-font controls and System scenes that load no bundled fonts. Magnified inspection confirms non-text browser edge/compositing rounding. |
| Desktop Save-button edge | 1 | 22 | Maximum channel delta 24, confined to the rounded button boundary. The original-font control has the exact same pixel differences. No text/layout change. |
| Mobile editor reload SVG edge | 3 | 6 | Two pixels per bundled preference at x261, y16/18; maximum channel delta 11. Inspection places both on the unchanged SVG stroke. |
| Content differences | 0 | 0 | Every visible body-text snapshot matches. |
| Font rendering regressions | 0 | 0 | All changed page pixels are outside text; the expanded font-only matrix and all-glyph grids are exact. |

Original-versus-original controls independently contain **1,498 changed pixels**. Controls distinguish browser compositing variation from text changes; they are not subtracted from the before/after count. The report records whether each complete difference image matches its original-font control. The archived earlier 204-pixel page result and smaller sample matrix do not describe this final revision.

Representative pairs are committed for durable inspection: [desktop before](font-optimization/desktop-before.png), [desktop after](font-optimization/desktop-after.png), [desktop diff](font-optimization/desktop-diff.png), [mobile before](font-optimization/mobile-before.png), [mobile after](font-optimization/mobile-after.png), [mobile diff](font-optimization/mobile-diff.png). Desktop includes accents, code, italics and bold inside italics and is exact. Mobile includes CJK/system fallback and has 45 non-text rounded-border pixels. The complete set also covers the independently styled typography dialog and editor.

## Check scope

The current revision passes the production build, lint/type checks, isolated server startup, generated-file checks, 16 focused service-worker unit tests, the real-worker demand-loading probe, and three Chromium cache tests (including delayed-write upgrades at both mounts). The new glyph script and upgrade test also typecheck independently.

`bun run test` was run again and stops at the Codex history API compatibility test’s unchanged five-second timeout. That failure was reproduced on the untouched baseline earlier in this work. An earlier broader web run also encountered two baseline ScrollArea lifecycle cleanup failures; the earlier editor/Mermaid Chromium checks passed. The full local suite is therefore not reported as green.

Pixel evidence is Chromium on Linux at device scale 1. It proves the captured scenes and tested typography combinations; it does not establish pixel identity on every operating system/browser/rasterizer or for every arbitrary future text/feature combination. The retained outlines, source coverage, automatic optical sizing, and rasterization controls reduce that remaining risk without changing fallback policy.
