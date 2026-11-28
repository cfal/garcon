# Pseudoterminals

## Where the original uses it

- `server/runtime/terminals/terminal-manager.ts:115-127` loads
  `bun-pty@0.5.1`; lines 532 and 641-662 resize and translate output/exit to
  terminal stream state. Termination calls `pty.kill()` (lines 285, 388, 577).
- `server-agents/codex/src/index.ts:446-472` spawns a PTY for interactive
  login with explicit 80 columns, 24 rows, cwd and color environment.
  Claude declares `bun-pty` in `server-agents/claude/package.json` but
  no production import was found under that provider; its primary CLI
  transport is piped stdio, not a PTY.

## Behavior the port must keep

- Preserve argv boundaries without invoking another shell, and use the
  selected executor's cwd/environment. The PTY itself supplies terminal
  line discipline, echo, size and control behavior. Do not emulate that
  with ordinary subprocess pipes.
- Keep `cols, rows` ordering straight: bun-pty accepts that order, Rust
  `PtySize` names `rows, cols`. Resize the running master rather than
  restarting the child. Use separate reader and writer ownership so
  an output read cannot block resize, input or exit.
- Stream UTF-8 decoding over read boundaries with replacement behavior;
  flush the decoder on EOF. Raw byte chunk boundaries are not valid
  UTF-8/text boundaries (`bun-pty/src/terminal.ts:157-159,250-265`).
  Preserve the application sequence and bounded replay independently of
  the native buffer. Session lifetime is not browser attachment lifetime.
- The wrapper's explicit kill emits its own exit event and closes the
  handle; natural exit comes from native status. TerminalManager already
  fences callbacks from a session in termination. Do not report two terminal
  exits or let buffered output revive a terminated session.

## Rust crate

`portable-pty 0.9.0`, default features (none), using `native_pty_system`,
`PtySize` and direct `CommandBuilder` argv. Clone the master reader and take
the sole writer; drop the parent's slave handle after spawn. Blocking reads
and child waits must not run on an async event loop. The crate exposes a
signal-only `ExitStatus` with fallback numeric code 1; preserve the
different explicit-kill path at the wrapper/manager boundary.
The Linux resize/read/write case below passed with this crate on Rust
1.99.1. Windows ConPTY behavior is unverified here.

## Traps

Observed with installed bun-pty on Bun 1.4.3 on Linux.

| Input | Original result |
| --- | --- |
| Spawn `sh` with cols 80 / rows 24, run `stty size`, resize to 111/37, send `typed\n`, run `stty size`, print the input and exit 7 | Output concatenates to `24 80\r\ntyped\r\n37 111\r\ntyped\r\n`. First `typed` is terminal echo, second is child output. Exit callback is `{exitCode:7}`. |
| Child runs `kill -TERM $$` inside the PTY | No output; natural exit callback is `{exitCode:1}`, not Bun.spawn's 143. |

## Sources

- Installed `server/node_modules/bun-pty/src/{terminal.ts,env.ts,interfaces.ts}`
  (0.5.1), and original call sites above.
- [portable-pty 0.9.0 source](https://docs.rs/portable-pty/0.9.0/src/portable_pty/lib.rs.html)
  and [API](https://docs.rs/portable-pty/0.9.0/portable_pty/).
