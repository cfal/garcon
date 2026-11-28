# Title emoji extraction

## Where the original uses it

`server/controller/chats/recent-title-icons.ts:9-20` calls
`emoji-regex@11.0.0` for every title. Lines 23-47 maintain the rolling
recency list (default 20).

## Behavior the port must keep

- Use matches of the installed generated regex, not code points with
  `Emoji` or `Extended_Pictographic`, and not arbitrary grapheme clusters.
  The matches can include ZWJ, a variation selector, a skin tone or a
  country flag pair. Match left to right and keep the first occurrence of
  each exact matched substring. Do not NFC-normalize or strip variation selectors.
- Across titles move existing icons to the newest end, then drop oldest
  entries above capacity. The public read returns newest-first
  (`recent-title-icons.ts:34-47`).

## Rust implementation

Exactness requires tables derived from the installed version's generated
pattern or equivalent pinned sequence data, preserving match order and
optional variants. A general Unicode grapheme library is not a substitute.
No Rust matcher or generated table has been verified on Rust 1.99.1 yet.

## Traps

Observed with the original `extractTitleIcons` on Bun 1.4.3.

| Input | Original match list |
| --- | --- |
| `❤ ❤️ ❤` | `["❤","❤️"]` |
| `👩‍💻 👩‍💻 👩` | `["👩‍💻","👩"]` |
| `🇺🇸 🇨 🇨🇦` | `["🇺🇸","🇨🇦"]`; no single regional indicator |
| `1 1⃣ 1️⃣` | `["1⃣","1️⃣"]`; plain digit is not a match |
| `👍🏽👍🏻👍` | `["👍🏽","👍🏻","👍"]` |
| `🏴‍☠ 🏴‍☠️` | `["🏴‍☠","🏴‍☠️"]` |
| Plain ASCII text or a lone high surrogate | `[]` |

## Sources

- Installed `server/node_modules/emoji-regex/index.mjs` and its
  `package.json` (11.0.0);
  [upstream emoji-regex](https://github.com/mathiasbynens/emoji-regex).
