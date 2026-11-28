# Codex code-mode command projection

## Where the original uses it

`server-agents/codex/src/agents/codex/code-mode-command-parser.ts:38-66` parses
with `acorn@8.19.0`, latest ECMAScript module mode. The recognizers at
lines 68-145 read direct awaited calls, literal `Promise.all` batches, and
statically resolvable mapped batches. The sibling
`code-mode-command-expressions.ts` resolves only supported expressions.

## Behavior the port must keep

- This is static projection for display, not a JavaScript evaluator.
  Preserve the 64 KiB UTF-8 source cap and cap of 64 commands.
  Invalid syntax, reserved bindings, unsupported AST shapes, or any
  unconsumed unsafe-to-project statement return null.
- Port the AST predicates, not the spelling or a source regex. They depend on
  declaration kind, exact callee/member shape, cooked versus dynamic
  template strings, patterns, statement identity and source order.
  Acorn parses as a module, permitting top-level await and rejecting
  TypeScript annotations and duplicate top-level lexical declarations.
- The Rust parser may produce an AST on failure. Require clean diagnostics
  and perform the parser's prescribed early syntax-error checks before
  projection. An ESTree-compatible serializer is not required; compare the
  final command projection, not backend-specific AST names/offsets.

## Rust crate

Candidate: `oxc_parser 0.160.0` with defaults (including the
`regular_expression` feature), `oxc_allocator 0.160.0` and
`oxc_span 0.160.0`. A top-level-await module and a syntax-error check
passed on Rust 1.99.1. Use `SourceType::mjs()` and the arena AST; the
default parser options leave regex parsing off even with the feature
enabled. The parser documents separate semantic checks for
additional syntax errors, so passing a simple parse is not full Acorn
parity. The final recognizer and its semantic checks were not built here.

## Traps

Observed with the original projection on Bun 1.4.3.

| Input | Original result |
| --- | --- |
| `const r = await tools.exec_command({cmd:"pwd"});` | `{"commands":["pwd"]}` |
| Same with callee `tools["exec_command"]` | Null despite valid JavaScript. |
| Same with command template string without interpolation | Projects the literal text. |
| Same with command template string containing unresolved interpolation | Null. |
| Append `extra();` or a duplicate `const r = 2;` | Null. |
| Prepend `const tools = {};` or annotate `r: any` | Null. |
| Literal `Promise.all` of exec calls for `pwd`, then `ls` | `{"commands":["pwd","ls"]}` |

## Sources

- Installed `server-agents/codex/node_modules/acorn/dist/acorn.mjs` (8.19.0)
  and the original recognizers above.
- [oxc parser](https://docs.rs/oxc_parser/0.160.0/oxc_parser/),
  [SourceType](https://docs.rs/oxc_span/0.160.0/oxc_span/struct.SourceType.html).
