# JSON and strings

Checked 2026-11-27 against Bun 1.4.5, the original's runtime, and Rust 1.99.1. Every
result in an "original" column is the output of a Bun 1.4.5 script on that input.

## Where the original uses it

- Compact output: 225 `JSON.stringify(x)` sites, for example
  `server/controller/ws/utils.ts:14` (`sendWebSocketJson`), and 184 `Response.json(x)`
  sites, for example `server/controller/routes/auth.ts:49`. `Response.json(x)` writes
  the text `JSON.stringify(x)` writes (checked on numbers, escapes, key order,
  `undefined`, and `toJSON`).
- Indented files: `server/common/json-file-store.ts:119` and
  `server-agents/common/src/lib/json-file-store.ts:13` write
  `JSON.stringify(value, null, 2) + "\n"`. `server/controller/app-title.ts:66` indents
  with a tab. `cli/transcript-message-format.ts:20` passes a replacer function.
- Input: `server/common/http-body.ts:20` (request bodies),
  `server/common/stored-json.ts:12` (state files),
  `server/controller/ws/server-sockets.ts:86` (socket messages). None passes a
  reviver. Each of the three replaces a parse error with a fixed message
  (`Malformed JSON`, or `<name> is not valid JSON`), so parse error text is not
  contract at those edges.
- Strings: 31 `.sort()` calls without a comparator; code-unit limits such as
  `server/controller/chats/chat-title.ts:88` (`.slice(0, 120)` on a title).

## Behavior the port must keep

- A number is a double, printed by `Number::toString`: the shortest digits that read
  back, fixed notation from 1e-6 up to but excluding 1e21, otherwise `d.dddde+23` with
  an explicit exponent sign. `-0` prints `0`.
- A parsed number loses its spelling: `1.0`, `1E2`, and `3.0e0` print back as `1`, `100`, `3`.
- `undefined` is omitted in an object and becomes `null` in an array. `NaN` and the
  infinities become `null`. A BigInt throws.
- Escaping: `"` and `\`, the short forms `\b \t \n \f \r`, other controls below 0x20 as
  `\u00xx` in lowercase hex. Nothing else is escaped.
- Keys: integer-like keys (canonical `0` to `4294967294`) first, ascending; every
  other key in insertion order.

## Rust crates, built with Rust 1.99.1

- `serde_json = 1.0.154` with `preserve_order`, `raw_value`, and `float_roundtrip`, set
  once in `[workspace.dependencies]` (RULES, Corrections). On 40000 decimal literals
  read as `Value`: with `float_roundtrip` all 39863 finite ones are the double the original
  reads; without it 2947 differ by one unit in the last place. The other 137 are beyond
  the `f64` range: an error there, `Infinity` in the original.
- `indexmap = 2.14.2` for `Map`, `Set`, and key order.
- `ryu-js = 1.0.4`, no features, MSRV 1.71: `ryu_js::Buffer::new().format(x)` is
  `Number::toString`. Equal to the original on 119978 random doubles and on 40000
  decimal strings parsed and printed. Non-finite input gives `NaN`, `Infinity`,
  `-Infinity`; JSON needs `null`.
- Writing a number: a newtype whose `Serialize` passes a `Box<serde_json::value::RawValue>`
  built from the ryu-js text (`garcon_js::Number`). Checked: `1e+21`, `0` for `-0.0`,
  the same inside a struct and inside `json!`.
- Fixture `fixtures/number-to-string.jsonl`: 2290 lines
  `{"bits":"<16 hex digits>","output":"<String(x) in the original>"}`, 134 KB, sorted
  by bit pattern. It holds the 290 samples on which a hand-written routine differed
  from the original, then 2000 others: 64 boundary and non-finite values, and a fill
  chosen with seed 20261127. Replayed with ryu-js: 2290 of 2290. With std `Display`
  in place of ryu-js: 1038 of 2290.
- Regular expressions: `regex = 1.13.2`, `regex-lite = 0.1.9`, `fancy-regex = 0.20.2`,
  and `regress = 0.12.0` (feature `utf16`) build. No engine matches the original on
  untranslated patterns. On 502 (pattern, flags, input) cases the result of the
  original came from `regress` on 432, `fancy-regex` on 296, `regex` on 259, and
  `regex-lite` on 231. Translate one pattern at a time, as RULES says.
  `fancy-regex` and `regress` backtrack and give no linear-time guarantee.

## Traps

Numbers. The Rust column is serde_json 1.0.154, which prints `f64` through `zmij`.

| Input | Original | Rust default |
| --- | --- | --- |
| `JSON.stringify(1.0)` | `1` | `1.0` |
| `JSON.stringify(1e20)` | `100000000000000000000` | `1e+20` |
| `JSON.stringify(1e-6)` | `0.000001` | `1e-6` |
| `JSON.stringify(-0)` | `0` | `-0.0` |
| `JSON.stringify(9007199254740993)` | `9007199254740992` | `json!(9007199254740993u64)` prints `9007199254740993` |
| `JSON.parse` of `1.0`, `1E2`, `3.0e0`, then `JSON.stringify` | `1`, `100`, `3` | `1.0`, `100.0`, `3.0` |
| `JSON.parse("18446744073709551616")`, printed again | `18446744073709552000` | `1.8446744073709552e+19` |
| `JSON.parse("1e400")` | `Infinity`, which prints `null` | error `number out of range` |
| `(2.5).toFixed(0)`, `(0.5).toFixed(0)`, `(-0).toFixed(1)` | `3`, `1`, `0.0` | `{:.0}` of 2.5 gives `2`, of 0.5 gives `0`; `{:.1}` of `-0.0` gives `-0.0` |
| `Math.round(-0.5)`, `Math.round(-2.5)` | `-0`, `-2` | `f64::round` gives `-1.0`, `-3.0` |
| `parseInt("0b11")`, `Number("0b11")`, `parseInt("12px")`, `Number("12px")` | `0`, `3`, `12`, `NaN` | `str::parse` accepts none of the four |

JSON text.

| Input | Original | Rust default |
| --- | --- | --- |
| `JSON.stringify("\u2028\u2029")` | both characters unescaped | same |
| `JSON.stringify("\ud800")` | `"\ud800"` | no such `String` |
| `JSON.parse('"\\ud800"')` | a string of one code unit | error `unexpected end of hex escape`, from `from_str`, `from_slice`, and `from_reader` alike |
| `{"a":"x` newline `y"}`, a raw newline inside a string | `JSON Parse error: Unterminated string` | error `control character (\u0000-\u001F) found while parsing a string` |
| 100000 nested `[` | parses | error `recursion limit exceeded` from 128 |
| `JSON.stringify({b:1,"1":2,a:3,"0":4})` | `{"0":4,"1":2,"b":1,"a":3}` | `json!` and `preserve_order` keep insertion order |
| key `"4294967294"` beside `"b"`; key `"4294967295"` beside `"b"` | the number leads in the first object, `b` leads in the second | insertion order in both |
| `JSON.stringify({a: undefined})`, `JSON.stringify([undefined])` | `{}`, `[null]` | an `Option` without `skip_serializing_if` gives `{"a":null}` |
| `JSON.stringify({}, null, 2)`, `JSON.stringify([], null, 2)` | `{}`, `[]` | `to_string_pretty`: same |
| `JSON.stringify(1n)` | throws `TypeError: JSON.stringify cannot serialize BigInt.` | |

Strings.

| Input | Original | Rust default |
| --- | --- | --- |
| `"😀".length`, `"é".length`, `Buffer.byteLength("é")` | `2`, `1`, `2` | `str::len()` gives `4`, `2`, `2` |
| `"😀b".slice(0, 1)`, `"x".padStart(4, "😀")` | `"\ud83d"`, `"😀\ud83dx"` | not a `String` |
| UTF-8 of `"\ud800"` in `Buffer.from`, `TextEncoder`, `fs.writeFileSync`, SHA-256 | `ef bf bd`, three bytes for U+FFFD | |
| `"\ufeffx".trim()` | `"x"` | `str::trim` keeps U+FEFF and removes U+0085, which the original keeps |
| `["￿","𐀀"].sort()` | `["𐀀","￿"]` | `str::cmp` gives `["￿","𐀀"]` |
| `[null,true,"b"].sort()`, `[3, undefined, 1, , 2].sort()` | `["b",null,true]`, `[1,2,3,undefined,<empty>]` | sort the string forms by UTF-16 code unit, `undefined` last; this is the specification, and `str::cmp` on the forms gives the same here |
| `Buffer.from([0xed,0xa0,0x80]).toString()` | three U+FFFD | `String::from_utf8_lossy`: same |
| `new TextDecoder().decode([0xef,0xbb,0xbf,0x61])` | `"a"` | std removes no BOM |

Regular expressions.

| Input | Original | Rust default |
| --- | --- | --- |
| `/\w/` on `"é"`, `/\d/` on `"٣"`, `/\bword\b/` on `"éword"` | no match in all three; with flag `u` the same | `regex` and `fancy-regex`: match in all three. `regex-lite` on `"éword"`: match at byte 2 |
| `/\s/` on `"\ufeff"`, `"\u00a0"`, `"\u0085"` | match, match, no match | `regex` and `fancy-regex`: no, match, match. `regex-lite`: no, no, no |
| `/^.$/` on `"😀"` | no match | `regex`: match on the whole character |
| `/a.c/` on `"a\rc"`, on `"a\u2028c"` | no match, no match | `regex`: match, match |
| `/^b$/m` on `"a\rb"`, on `"a\u2028b"` | match at 2, match at 2 | `regex`: no match, no match |
| `/\b.+?\b/` on `"😀ab"` | `["ab", 2]` | `regex`: `["ab", 4]`, a byte offset |
| `/k/i` on `"K"`, `/[a-z]/i` on `"ſ"` | no match, no match | `regex` and `fancy-regex`: match, match. `regress`: no match, match. `regex-lite`: as the original |
| `/\e/` on `"\u001b"`, `/\u{41}/` on `"A"`, `/^\p{L}$/` on `"a"`, `/\a/` on `"a"` | no match, no match, no match, match | `regex`: parse error, match, match, no match. `fancy-regex`: match, match, match, no match. `regress`: as the original, except a match for `/\u{41}/` |
| `/(a)?b\1/` on `"b"`, `/(x?)*y/` on `"y"` | match with the group `null`; `["y", null]` | `fancy-regex`: no match, then `["y", ""]`. `regex` gives `["y", ""]` |

## Sources

- Runs on Bun 1.4.5; each row of the traps is `input => result`.
- ECMAScript: [Number::toString](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-tostring),
  [JSON.stringify](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify),
  [JSON.parse](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse),
  [OrdinaryOwnPropertyKeys](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryownpropertykeys),
  [trim](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.trim),
  [slice](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.slice).
- serde_json 1.0.154 in the cargo registry: `src/de.rs:63` (depth 128), `src/read.rs:964`
  and `:1010` (lone surrogates), `src/ser.rs:1719` (`f64` through `zmij`),
  [RawValue](https://docs.rs/serde_json/1.0.154/serde_json/value/struct.RawValue.html).
- ryu 1.0.23 `src/pretty/mod.rs:86`: fixed notation only while `0 < kk <= 16`.
- [ryu-js 1.0.4](https://docs.rs/ryu-js/1.0.4/ryu_js/struct.Buffer.html), <https://github.com/boa-dev/ryu-js>.
- [regex](https://docs.rs/regex/1.13.2/regex/), [regex-lite](https://docs.rs/regex-lite/0.1.9/regex_lite/),
  [fancy-regex](https://docs.rs/fancy-regex/0.20.2/fancy_regex/), [regress](https://docs.rs/regress/0.12.0/regress/).

## Check of RULES.md

- Rule: `JSON.stringify(value, null, 2)` is `serde_json::to_string_pretty`. True for
  layout only. Input `{"a":1e20}`: the original writes `"a": 100000000000000000000`;
  pretty prints `1e+20`. It holds when every number is an integer or a `garcon_js::Number`.
- Rule: without the `u` flag, `\w`, `\d`, and `\b` are ASCII-only. True, and they are
  ASCII-only with the flag: `/\w/u.test("é")` is `false`. The qualifier suggests
  otherwise.
- Missing from RULES, each with the original's result: `/\s/.test("\ufeff")` is `true`
  and `/\s/.test("\u0085")` is `false`; `/a.c/.test("a\rc")` is `false`;
  `/^b$/m.test("a\rb")` is `true`; a match index counts code units;
  `("\ufeffx").trim()` is `"x"`; `(2.5).toFixed(0)` is `"3"`; `Math.round(-0.5)` is `-0`.
- Three inputs the original accepts fail in `garcon_js::json` or come back changed; its
  module text lists them as known differences (checked again with the feature set above):
  `JSON.parse("1e400")` is `Infinity` and the port answers `number out of range`;
  `JSON.parse('"\\ud800"')` is a one-unit string and the port holds U+FFFD;
  100000 nested arrays parse in the original and the port fails at depth 128.
- Unverified: `localeCompare` and `Intl` on Bun. The runtime has ICU, reports `en-US`,
  and gives `"ä".localeCompare("b", "sv")` as `1`. No crate was compared.
