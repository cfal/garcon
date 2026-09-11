# Garcon brand mark

Fork Tail is Garcon's product mark. Its speech bubble represents the visible workspace; the three connected nodes represent agent coordination and chat lineage.

## Color system

| Variant                                                 | Colors                        | Use                                                                                                                |
| ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Phosphor Forest](garcon-fork-tail-forest.svg)          | `#0a714e` / white             | Website, marketing, repository and documentation identity, social artwork, and editorial illustrations.            |
| [Carbon](garcon-fork-tail-carbon.svg)                   | `#111827` → `#475569` / white | Stable application identity: browser favicon, PWA, mobile home screen, packaged application, and launcher artwork. |
| [Classic Ink](garcon-fork-tail-ink.svg)                 | `#262626` / white             | In-app brand mark on every dark theme.                                                                             |
| [Classic Silver](garcon-fork-tail-silver.svg)           | `#d9d9d9` / `#111111`         | In-app brand mark on every light theme.                                                                            |
| [Carbon Maskable](garcon-fork-tail-carbon-maskable.svg) | Carbon, full bleed            | Android/PWA maskable exports only.                                                                                 |

Forest is the public brand color. Carbon is deliberately theme-independent: launcher and browser assets are cached outside Garcon and cannot reliably follow its selected theme. Ink and Silver are interface treatments, not alternate launcher identities.

## Usage

- Keep the Fork Tail geometry unchanged across every variant.
- Use the complete rounded tile. Do not place the bare glyph directly on a surface.
- Keep the glyph and tile colors paired as supplied.
- Preserve the Carbon gradient from upper-left to lower-right.
- Use at least `16 × 16 px`. At small sizes, export from the SVG master rather than simplifying the paths.
- Keep clear space around the tile equal to at least one quarter of its width in editorial layouts. Platform launchers may apply their own masks and spacing.
- Do not add outlines, glow, shadows, rotation, animation, or additional colors to the mark itself.
- Do not switch favicons, PWA icons, or launcher artwork when the application theme changes.

## Repository application

- `web/static/icons/` contains checksum-addressed browser, touch, and PWA exports. All except the maskable export derive from Carbon.
- `web/static/icons/icon-maskable-512.*.png` derives from Carbon Maskable.
- `web/src/lib/components/shared/GarconMark.svelte` uses semantic theme tokens to render Ink on dark themes and Silver on light themes.
- The root `README.md` and any future `website/` implementation use Phosphor Forest.

Run `bun scripts/generate-brand-assets.ts` from the repository root after changing a master. The script requires `rsvg-convert` from librsvg, removes superseded exports, updates the app shell and manifest, and writes deterministic filenames containing the first 12 characters of each file's SHA-256 checksum. These public exports are safe to cache as immutable for one year because changed bytes always produce a new URL.
