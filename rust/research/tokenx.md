# Token estimates

## Where the original uses it

`server/controller/chats/token-fitting/budget.ts:9-11,43-95` delegates to
`tokenx@2.1.1` without options, then measures complete renderings to decide
whether to return, correct the entry budget, or fail.
`server/controller/chats/token-fitting/carryover.ts:53,74-82` also uses it for
the no-compaction threshold, fixed frame and per-entry costs.

## Behavior the port must keep

Port the installed implementation, not a model tokenizer or a different
word/byte estimate. The order below is the order in
`server/node_modules/tokenx/dist/index.mjs:2-114`:

1. Split into runs of JavaScript `\s`, runs of the explicit ASCII
   punctuation class, and intervening text. Retain both delimiter runs;
   skip empty segments. A whitespace run is 1 if it contains a newline
   followed by another whitespace character; otherwise a newline costs 1
   unless the preceding segment ends in punctuation. Other whitespace is 0.
2. For non-ASCII segments, try the installed language patterns in order:
   German (3), Romance (4.5), Czech/Polish (2.5), Cyrillic (6), Greek (3),
   and pictographic plus emoji components (0.9). The first match applies to
   the **whole segment**; round up code-point count divided by that factor.
   Use the actual ranges and non-`u` JS case folding for the first five;
   the emoji pattern is Unicode-aware and anchored.
3. If the installed BMP CJK trigger matches, count code points by the
   source's kana and Hangul ranges; everything else in the segment is
   counted as Hanzi, even Latin characters. Apply one ceiling to
   `hanzi/1.15 + kana/1.4 + hangul/1.65`. The trigger and counters are
   intentionally different.
4. Remaining rules use UTF-16 length: ASCII digit runs ceil(length/3);
   up to 3 units cost 1; ASCII lowercase words up to 8 cost 1; punctuation
   runs ceil(length/6); all others ceil(length/7). Sum costs, including
   boundary whitespace, and return 0 for an empty input.

Do not sum independently measured components in place of the actual render
check: concatenation can change segment boundaries and which rule wins.
Preserve the bounded execution of whole-document fitting.

## Rust implementation

No third-party tokenizer. Use Rust 1.99.1 standard arithmetic and a scanner
with the existing `garcon-js` UTF-16 and JS-whitespace helpers. Those helpers
build on the pinned toolchain; a native tokenx port and an exact
Extended_Pictographic/Emoji_Component table were not built or replayed here.

## Traps

Measured with the original `estimateHandoffTokens` on Bun 1.4.3.

| Input | Original estimate |
| --- | ---: |
| Empty, ASCII space, lone LF | 0, 0, 1 |
| `x\n`, `.\n`, `.\n ` | 2, 1, 2 |
| `abcdefghi`, `ABCDEFGH`, `1234567`, `!!!!!!!!!!` | 2, 2, 3, 2 |
| `\u00e9abcdefghi`, `\u00e4\u00e9abcdefghi` | 3, 4 |
| `你好abc`, `あア가` | 5, 3 |
| `👩‍💻`, `a😊b` | 4, 1 |
| `𠮷`, `𠮷漢` | 1, 2 |
| BOM `\ufeff`, NEL `\u0085`, lone escaped high surrogate `\ud800` | 0, 1, 1 |

## Sources

- Installed `server/node_modules/tokenx/dist/index.mjs:2-114` (2.1.1).
- [ECMAScript String and RegExp definitions](https://tc39.es/ecma262/),
  and the `garcon-js` source in `rust/garcon-js/src`.
