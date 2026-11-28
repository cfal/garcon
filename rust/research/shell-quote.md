# Shell quoting and display parsing

## Where the original uses it

- `server-agents/codex/src/agents/codex/app-server/command-display.ts:7-17`
  calls `shell-quote@1.12.0` parse with a variable sentinel; lines 19-89
  recognize exact wrapper argv shapes after a balanced-quote precheck.
- `cli/shell-quote.ts:1-3` is a separate implementation for generated CLI
  commands, imported by `cli/connection-options.ts:2`, `cli/chat-status.ts:8`
  and `cli/chat-search.ts:25`. It always wraps in single quotes. The
  `server/package.json` shell-quote declaration has no corresponding
  production import in `server/`; do not assume the package's quote
  routine is the CLI output contract.

## Behavior the port must keep

- The Codex normalizer is for display, not shell execution or a security
  classifier. It preserves the original string on unbalanced POSIX quotes,
  parse exceptions, any non-string token, or an unrecognized argv shape.
  Never perform interpolation with the process environment.
- Recognize basenames case-insensitively, split on either slash,
  and strip an `.exe` suffix. Only exact 3/4-token shapes qualify:
  `bash/sh/zsh -c/-lc`, `powershell/pwsh [-noprofile] -command`, and
  `cmd /c`. The Windows flags are case-insensitive; Unix flags are not.
- Port the subset of parsing from the installed `parse.js`: concatenated
  quoted/unquoted text, context-dependent escaping, empty quoted words,
  environment interpolation, operators, comments, and glob objects. The
  environment callback returns an object so interpolation is not
  mistaken for a plain argument. An operator/glob/comment object also
  prevents unwrapping. Do not treat the quoting routine and parser as
  mutual inverses for all arguments.
- Keep the CLI's always-quoted rendering and exact single-quote splice
  separate from the package's quoting behavior.

## Rust implementation

No third-party parser is required for the direct port. Use Rust 1.99.1
standard string operations and preserve the observable distinction between
strings and non-string tokens. No native parser was built or replayed here.

## Traps

Observed with Bun 1.4.3, the original Codex normalizer, and the installed
package's `quote` and `parse` functions.

| Input to display normalizer | Original display |
| --- | --- |
| `bash -lc 'echo hi'` | `echo hi` |
| `bash -lc "echo $HOME"` / `bash -lc 'echo $HOME'` | Unchanged / `echo $HOME` |
| `bash -lc echo \| cat`, `bash -c echo # comment`, or `bash -lc 'echo` | Unchanged |
| `bash -lc '*'` / `bash -lc *` | `*` / unchanged |
| `pwsh -NoProfile -Command 'Write-Output hi'` / `cmd /C ""` | `Write-Output hi` / empty string |
| Package `parse(quote(["x*y"]))` | One object `{op:"glob",pattern:"x*y"}`, not one string; the package quoted it as `x\*y`. |

## Sources

- Installed `server/node_modules/shell-quote/{index.js,quote.js,parse.js}`
  (1.12.0), and the original call sites above.
