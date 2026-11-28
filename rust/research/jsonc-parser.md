# OpenCode JSONC configuration

## Where the original uses it

`server-agents/opencode/src/agents/opencode/server-instance.ts:21-65` parses
inherited `OPENCODE_CONFIG_CONTENT` with `jsonc-parser@3.3.1`; lines 68-91
put the merged JSON back into the child environment.

## Behavior the port must keep

- Missing or trim-empty input starts from an empty object. Nonempty input
  allows line/block comments and trailing commas, but rejects parser errors
  even if the parser produced a partial value. The reported error uses
  the first diagnostic's symbolic name and UTF-16 offset.
- Require an object root and optional array-valued `plugin`. Entries are
  strings or two-element `[specifier, options]` arrays where options is
  a non-null, non-array object. Retain the last matching plugin entry,
  remove other matching entries and append that retained entry after the
  unrelated plugins. Retain the rest of the configuration.
- Output standard compact JSON, not original JSONC trivia. Duplicate
  object keys take the last value; JS key enumeration and number formatting
  still govern serialization (see [JSON](json-and-strings.md)).

## Rust crate

`jsonc-parser 0.34.0` with `serde` supports parsing to a
`serde_json::Value` using `parse_to_serde_value`. A comment, trailing
comma and order check passed on Rust 1.99.1 with serde_json's
`preserve_order`. Do not forward its diagnostic text directly: the Rust
parser's ranges are byte offsets and its error kinds differ. Explicitly
turn off permissive defaults that the original excludes, including
missing commas, single quotes and unquoted property names.

## Traps

Observed with the original `mergeOpenCodeConfigContent` on Bun 1.4.3;
plugin URL is `file:///plugin.js`.

| Input | Original result |
| --- | --- |
| Undefined | `{"plugin":["file:///plugin.js"]}` |
| `{/*note*/"z":[1,], "a":2,}` | `{"z":[1],"a":2,"plugin":["file:///plugin.js"]}` |
| Comment-only input `" // only comment"` | `Invalid inherited OPENCODE_CONFIG_CONTENT at offset 16: ValueExpected.` |
| `{"😀": }` | `Invalid inherited OPENCODE_CONFIG_CONTENT at offset 7: ValueExpected.` |
| `{"x":01}` | `Invalid inherited OPENCODE_CONFIG_CONTENT at offset 6: CommaExpected.` |
| `{"mode":1,"mode":2}` | `{"mode":2,"plugin":["file:///plugin.js"]}` |
| `[]` or `{"plugin":[["bad",null]]}` | Rejects the root / rejects `plugin[0]`, respectively. |
| Plugins `["file:///plugin.js","other",["file:///plugin.js",{"value":1}]]` | `["other",["file:///plugin.js",{"value":1}]]` |

## Sources

- Installed `server-agents/opencode/node_modules/jsonc-parser` (3.3.1),
  `lib/esm/main.js` and `lib/esm/impl/{parser,scanner}.js`.
- [Rust crate source](https://docs.rs/crate/jsonc-parser/0.34.0/source/)
  and [serde adapter](https://docs.rs/jsonc-parser/0.34.0/jsonc_parser/fn.parse_to_serde_value.html).
