# ACP child processes

## Where the original uses it

- `server-agents/common/src/acp/transport.ts:59-74` (`defaultSpawn`) starts the
  agent with `Bun.spawn([command, ...args], { cwd, env, stdin: 'pipe',
  stdout: 'pipe', stderr: 'pipe' })`, and `AcpProcess.kill(signal)` forwards
  `SIGTERM` or `SIGKILL`.
- `transport.ts:11-19` (`writeFrame`) reads `stdin.write(frame)` and
  `stdin.flush()` to confirm a send, and `transport.ts:276-355` reads both
  output pipes and `exited`.
- Antigravity (`agy`) and Cursor (`cursor-agent`) are the agents; each chat
  session owns one process.

## Behavior the port must keep

- `env` replaces the whole environment: the child has exactly the keys given,
  and a key whose value is `undefined` is left out. It does not inherit.
- The child gets no process group of its own; `kill` reaches that process
  only. The port signals the pid it started (`libc::kill`), as the front door
  does for the original.
- `exited` resolves to the exit code, or 128 plus the signal for a signal
  exit (`kill` then `exited` gave 143 for `SIGTERM`, 137 for `SIGKILL`).
- `stdin.write(frame)` buffers the frame and returns at once: a byte count
  for a small frame, or a promise for a large one (1 MiB against a process
  that had not read yet returned a promise at once). `stdin.flush()` returns
  a byte count when nothing is left, else a promise.
- Against a child that closed its stdin: `write` returns a count for a small
  frame and `flush()` throws `EPIPE`; a large frame's promise rejects with
  `EPIPE`. A send that is not confirmed reports nothing; a confirmed one
  fails with the `EPIPE`.
- After `exited` was awaited, `write` returns `true` and `flush` returns
  `undefined`. The transport turns the `true` into `Incomplete ACP frame
  write` when a send is confirmed and treats it as written otherwise.
- A process that never existed is different from one that exited: spawn
  throws `ENOENT` before any pipe exists.

## Rust crate

`tokio::process::Command` with the three pipes and `env_clear().envs(..)`,
behind `AcpProcess` in `rust/garcon-agents-common/src/acp/transport.rs`. The
stdin sink (`transport/pipe.rs`) buffers as `FileSink` does: `write` hands
what the pipe takes at once and reports the count, or a future for the rest;
`flush` reports an error at once when the pipe is already broken.

## Traps

Observed on pinned Bun 1.4.3 on Linux; no Windows runtime verification.

| Input | Original result |
| --- | --- |
| `Bun.spawn(env: { A: '1', B: undefined, C: '3' })` of a script printing `process.env` | `{"A":"1","C":"3"}` |
| `stdin.write('hello\n')`, then `stdin.flush()` to a live `cat` | both return `6`; a later `flush()` returns `0` |
| `stdin.write(1 MiB)` to a `sleep` that never reads | a promise at once, resolving to `1048576` after about 1 ms |
| Child alive with its stdin closed; `stdin.write(13 bytes)`, then `stdin.flush()` | `13`, then `flush` throws `EPIPE: broken pipe, write` |
| Same child, at the buffer boundary | 4095 bytes returns a count; 4096 bytes returns a rejected promise |
| Child alive with its stdin closed; `stdin.write(1 MiB)`, then `stdin.flush()` | a promise, then `0`; the promise rejects with `EPIPE` |
| After `await exited`: `stdin.write(..)`, `stdin.flush()` | `true`, `undefined` |
| `kill('SIGTERM')`, `kill('SIGKILL')`, then `await exited` | `143`, `137` |

## Known difference

The malformed `not json` stdout line in the `acp-transport-wire.ts` oracle
has the same diagnostic prefix in the port, followed by the Rust JSON
parser's error rather than JavaScriptCore's. The manager approved that
diagnostic-only difference on 2026-11-28 under ADR-028.

## Sources

- Probes on Bun 1.4.3 of `Bun.spawn` and of the stdin `FileSink` it returns.
- `rust/research/process-supervision.md` for the tokio process model.
- [Tokio process](https://docs.rs/tokio/1.54.1/tokio/process/).
