# Regular expressions

## Settings validation

`common/hidden-bash-command-patterns.ts:37` calls `new RegExp(pattern)`
without flags, only to check syntax. The browser then compiles accepted
patterns itself and drops ones that throw
(`web/src/lib/chat/transcript/hidden-bash-commands.ts:74`).

`regress` 0.12.0 has no public parse-only entry point.
[`Regex::from_unicode`](https://docs.rs/regress/0.12.0/regress/struct.Regex.html#method.from_unicode)
accepts UTF-16 code units, as needed for non-Unicode character classes.
Use [`Flags::no_opt`](https://docs.rs/regress/0.12.0/regress/struct.Flags.html#structfield.no_opt)
for syntax checks. It skips IR optimization but still emits bytecode.
The unoptimized emitter visits a repeated body once and stores the counts in
a loop instruction, rather than expanding the body according to a count
(`regress` source `src/api.rs:419`, `src/emit.rs:315`).

The remaining syntax differences from Bun 1.4.3 are listed beside the
hidden-bash-command-patterns recording. They cover quantified boundary
assertions, non-Unicode character-class ranges, overflowing counts,
astral group identifiers, and deep groups.

## Escaped literals at word boundaries

`common/chat-filter-query.ts:287` removes tags with an escaped literal and
`\b` under `gi`. The transcript search literal at
`server-agents/common/src/search/query.ts:224` instead uses `iu` and
lookarounds built from Unicode letter, number, and mark classes; the
`\b` probes below do not establish parity for those lookarounds.

Each pattern is given to `new RegExp(pattern, flags).test(input)` on Bun
1.4.3 and `regress::Regex::with_flags(...).find(input).is_some()` on
Rust 1.99.1 using `regress` 0.12.0, with optimization disabled.
Cells are match results for `i`, then `iu`. Escape spelling is literal
regex input; input column escapes denote the actual characters.

| Pattern | Input | Bun | regress |
| --- | --- | --- | --- |
| `\btag:\u017f\b` | `tag:s` | no / yes | **yes** / yes |
| `\btag:\u0073\b` | `tag:\u017f` | no / yes | no / yes |
| `\btag:\u006b\b` | `tag:\u212a` | no / yes | no / yes |
| `\btag:\u212a\b` | `tag:k` | no / yes | no / yes |
| `\btag:\u0069\b` | `tag:\u0131` or `tag:\u0130` | no / no | no / no |
| `\btag:\u0073\b` | `\u017ftag:s` | yes / no | yes / no |
| `\btag:a\+b\b` | `tag:A+B` | yes / yes | yes / yes |

In particular, non-Unicode case folding of long s is asymmetric in the
tested `regress` paths. Do not assume escaping a literal makes `gi`
interchangeable with the original engine.
