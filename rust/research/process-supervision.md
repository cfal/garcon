# Child processes and supervision

## Where the original uses it

- `server/runtime/git/run.ts:20-43,174-228` spawns Git directly with an
  executor-local cwd, separate bounded output pipes and a choice of stdin.
  It explicitly owns cancellation of the process group.
- `server-agents/codex/src/agents/codex/app-server/client.ts:112-141,576-598`
  holds a long-lived piped stdio process and escalates on shutdown.
- `server-agents/claude/src/agents/claude/claude-cli.ts:940`,
  `cli-process-transport.ts:66,249-252,291`, and
  `server-agents/common/src/acp/transport.ts:60-72,110,189` use separate
  pipe/exit controls for protocol processes.
- Not all agents use Bun.spawn:
  `server-agents/opencode/src/agents/opencode/server-instance.ts:1,94-105`
  uses Node child_process and observes termination beyond server readiness.
  `server-agents/common/src/lifecycle/process-exit-fence.ts:35-44` fences
  state until the process actually exits, not just until a signal is issued.

## Behavior the port must keep

- Spawn argv directly. Preserve each call's cwd, inherited or explicitly
  supplied environment, and ignored/inherited/piped descriptor choices.
  Concurrently drain both output pipes and observe exit. Pipe EOF, exit
  and draining queued output are distinct events. Do not substitute
  unbounded output collection at a bounded call site.
- Closing the last writer sends stdin EOF. Codex uses this before
  SIGTERM of the child and finally SIGKILL of its POSIX group; Windows
  uses the direct child in that adapter. Git uses a POSIX group for both
  signals with 250 ms grace, or `taskkill /PID ... /T /F` on Windows.
  Preserve the per-operation choice rather than applying one policy to
  every child.
- Bun's `exited` uses 128 + signal for a signal exit on the measured
  platform; its `exitCode` is null, and `signalCode` names the signal.
  Keep signal identity separately from a process that deliberately exits
  with the same number. A failed spawn is not a started process exiting.
- Retain lifecycle identity over waits: do not publish from retired
  processes or release admission while an unconfirmed child can still
  act. Reap children after cancellation, and do not rely on handle drop
  as the successful-termination event.

## Rust crate

`tokio 1.54.1` with `process`, `io-util`, `macros`, and a runtime
(`rt` in the scratch probe; see `rust/Cargo.toml` for workspace features).
The piped echo/exit case passed with this version on Rust 1.99.1.
Use `tokio::process::Command` and explicit pipe reads/drains. Unix
`process_group(0)` sets a process group but does not create the new session
that Bun's detached process has; audit callers before treating them as
equivalent. `Child::start_kill` is forceful and targets one process. It
neither implements a SIGTERM grace period nor a POSIX group signal.
Tokio defaults to not killing a child on drop; `kill_on_drop` is not a
substitute for confirmed exit and explicit group cleanup. Use
`ExitStatusExt::signal` on Unix; `ExitStatus::code` is then absent.

## Traps

Observed on pinned Bun 1.4.3 on Linux; no Windows runtime verification.

| Input | Original result |
| --- | --- |
| Piped `sh -c 'cat; printf error >&2; exit 7'`, write `stdin-line\n`, then end stdin | Exit 7, stdout `stdin-line\n`, stderr `error`. |
| Pass an already-aborted signal for `/bin/true` | Spawn throws synchronously with `AbortError`. |
| Spawn a nonexistent absolute executable | Throws synchronously with `ENOENT`. |
| Spawn a normal `sleep`, invoke `child.kill()` | Linux process is not its own group/session leader. `exited` resolves 143, `exitCode` is null, `signalCode` is `SIGTERM`, `killed` is true. |
| Spawn detached `sleep`, deliver SIGTERM to its group | Linux group ID and session ID both equal child PID. Exit reporting is identical to the direct SIGTERM case. |

## Sources

- [Bun spawn](https://bun.com/docs/runtime/child-process) and original call sites.
- [Tokio process module](https://docs.rs/tokio/1.54.1/tokio/process/),
  [Command](https://docs.rs/tokio/1.54.1/tokio/process/struct.Command.html),
  [Child](https://docs.rs/tokio/1.54.1/tokio/process/struct.Child.html), and
  Rust [ExitStatusExt](https://doc.rust-lang.org/std/os/unix/process/trait.ExitStatusExt.html).
