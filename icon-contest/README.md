# Garcon icon contest

## Outcome

`22-fork-tail` is the selected Garcon mark. The canonical production masters and color guidance live in [`docs/brand/`](../docs/brand/README.md): Phosphor Forest for public identity, Carbon for stable launcher/browser assets, and Classic Ink or Silver for theme-aware in-app branding.

Twenty-eight reproducible SVG candidates for Garcon. Every candidate uses the same theme-safe construction:

- `256 × 256` vector master with no raster dependencies
- full-canvas `#2563eb` background and white glyph
- `52 px` corner radius matching the current app icon
- glyph kept inside the central safe area for Android maskable icons
- one unchanged asset on light and dark interfaces
- simple geometry intended to remain recognizable at `16 px`

Open [`gallery.html`](gallery.html) to compare every candidate on light and dark surfaces and at favicon sizes.

## Recommended shortlist

| Candidate        | Why it works                                                                      |
| ---------------- | --------------------------------------------------------------------------------- |
| `01-g-tail`      | Cleanest evolution of the existing chat bubble; the G and tail share one gesture. |
| `07-cap-tail`    | Most distinctive brand story; a garçon cap becomes a conversation mark.           |
| `09-cap-panes`   | Strongest product-specific combination: cap, workspace panes, and app silhouette. |
| `13-pane-bubble` | Most literal representation of Garcon's windowed chat workspace.                  |
| `19-agent-hub`   | Best expression of visible multi-agent coordination.                              |
| `28-chevron-g`   | Strong coding signal without becoming a generic terminal icon.                    |

## Candidates

| ID                                                    | Family       | Concept                                                |
| ----------------------------------------------------- | ------------ | ------------------------------------------------------ |
| [01-g-tail](candidates/01-g-tail.svg)                 | Chat + G     | Continuous G with a speech tail.                       |
| [02-bubble-g](candidates/02-bubble-g.svg)             | Chat + G     | Open bubble outline completed by a G bar.              |
| [03-double-chat-g](candidates/03-double-chat-g.svg)   | Chat + G     | Two stacked conversations forming a compact monogram.  |
| [04-chat-ring](candidates/04-chat-ring.svg)           | Chat + G     | Circular conversation loop with a decisive tail.       |
| [05-g-terminal](candidates/05-g-terminal.svg)         | Chat + G     | G paired with a terminal chevron.                      |
| [06-g-cursor](candidates/06-g-cursor.svg)             | Chat + G     | G with an active pointer for direct control.           |
| [07-cap-tail](candidates/07-cap-tail.svg)             | Cap          | Garçon cap whose silhouette resolves into a chat tail. |
| [08-cap-brim](candidates/08-cap-brim.svg)             | Cap          | Minimal bellhop cap with a strong curved brim.         |
| [09-cap-panes](candidates/09-cap-panes.svg)           | Cap          | Cap containing Garcon's four-window workspace.         |
| [10-cap-terminal](candidates/10-cap-terminal.svg)     | Cap          | Cap containing a compact terminal prompt.              |
| [11-cap-nodes](candidates/11-cap-nodes.svg)           | Cap          | Cap containing a visible agent graph.                  |
| [12-bellhop-bubble](candidates/12-bellhop-bubble.svg) | Cap          | Bellhop button and brim merged with a speech tail.     |
| [13-pane-bubble](candidates/13-pane-bubble.svg)       | Workspace    | Four resizable panes inside a conversation window.     |
| [14-split-chat](candidates/14-split-chat.svg)         | Workspace    | Two side-by-side agent surfaces with one tail.         |
| [15-window-stack](candidates/15-window-stack.svg)     | Workspace    | Window-local tabs expressed as layered surfaces.       |
| [16-focus-chat](candidates/16-focus-chat.svg)         | Workspace    | Focus brackets framing the active conversation.        |
| [17-dock-corners](candidates/17-dock-corners.svg)     | Workspace    | Docking corners around a central chat surface.         |
| [18-workspace-g](candidates/18-workspace-g.svg)       | Workspace    | Four panes cut into a geometric G.                     |
| [19-agent-hub](candidates/19-agent-hub.svg)           | Coordination | Agent graph contained in a visible conversation.       |
| [20-lineage](candidates/20-lineage.svg)               | Coordination | Parent chat branching into two child chats.            |
| [21-orbit-chat](candidates/21-orbit-chat.svg)         | Coordination | Agents orbiting a shared chat surface.                 |
| [22-fork-tail](candidates/22-fork-tail.svg)           | Coordination | Fork lineage inside a speech bubble.                   |
| [23-agent-hex](candidates/23-agent-hex.svg)           | Coordination | Compact agent network with a chat-tail accent.         |
| [24-spark-chat](candidates/24-spark-chat.svg)         | Coordination | AI spark inside an otherwise restrained bubble.        |
| [25-bowtie-chat](candidates/25-bowtie-chat.svg)       | Concierge    | Bow tie reduced to a conversation silhouette.          |
| [26-key-chat](candidates/26-key-chat.svg)             | Concierge    | A control-plane key above a compact message.           |
| [27-tab-cap](candidates/27-tab-cap.svg)               | Concierge    | Window tab geometry shaped into a cap.                 |
| [28-chevron-g](candidates/28-chevron-g.svg)           | Concierge    | G and command chevron in one coding-workspace mark.    |

## Production sizing

The SVGs are the source of truth. With Bun and `rsvg-convert` from librsvg installed, one command produces the rounded web assets and full-bleed blue Apple/maskable variants:

```sh
bun icon-contest/export-icons.ts 01-g-tail
```

The optional second argument changes the output directory. The default is `icon-contest/exports/<candidate>/`.

| Use                | Output                                                              |
| ------------------ | ------------------------------------------------------------------- |
| Browser favicon    | `16 × 16`, `32 × 32`, ICO bundle                                    |
| PWA                | `192 × 192`, `512 × 512` PNG                                        |
| Apple touch icon   | `180 × 180` PNG                                                     |
| Android maskable   | `192 × 192`, `512 × 512` PNG with square full-bleed blue background |
| Website/navigation | Inline SVG or `32–64 px` SVG                                        |
| Source/archive     | Original `256 × 256` SVG; scaling is lossless                       |

Before replacing the production icon, test the winner at `16 px` without antialiasing tricks, in browser tabs, on a home screen, and against both `#ffffff` and `#0c1117` surfaces.

## Model provenance

See [`MODEL_NOTES.md`](MODEL_NOTES.md) and [`source-boards/PROMPTS.md`](source-boards/PROMPTS.md). AI boards are design research only; every contest candidate is a clean, inspectable SVG authored from basic geometry.
