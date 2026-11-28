# Bun Workers

## Where the original uses it

- `server/controller/lib/task-worker.ts:36-193` runs transcript transforms
  on a lazily created Worker and sends bounded item batches.
- `server-agents/common/src/search/worker-supervisor.ts:184-187,323-330`
  owns long-lived search workers with explicit supervision and termination.
  Search's reader and writer are independent from transform-worker lifetime.

## Behavior the port must keep

- Keep large transforms and index work off the controller event loop.
  Preserve request identity, FIFO messages from one producer, and the
  distinction between a task result and a worker exit. One task worker
  takes `begin`, zero or more `items` batches and `run` in that order.
- On abort of an active task or an invalid/failed worker, fence its
  identity before starting the next task; a delayed event cannot resolve
  a replacement task. A normal task-level error may carry a code and
  does not itself retire the worker. Close rejects both active and queued
  tasks and prevents admission (`task-worker.ts:86-95,130-193`).
- Search workers have different ownership: use the fixed reader/writer
  pair and keep connection and shutdown responsibility with their
  supervisors, not a per-request worker.

## Rust implementation

Use Rust 1.99.1 threads and bounded channels with owned message types
(standard library; no third-party crate required). Use cooperatively
cancellable bounded operations or retire the consumer's generation and
arrange orderly worker cleanup. Rust threads cannot be forcibly terminated
like Bun Workers. Do not let retirement release resource ownership while
an old thread can still mutate the resource. No native worker implementation
was built or replayed here.

## Traps

Original TaskWorker recovery cases are in
`server/controller/lib/__tests__/task-worker.test.js:12-45`.

| Input | Original result |
| --- | --- |
| Active worker throws or exits, with a queued echo | Active request rejects with `worker failed:` or `worker exited`; queued echo succeeds on a fresh worker. |
| Active worker replies with wrong task ID or malformed event | Active request rejects with `worker sent an invalid event`; queued echo succeeds. |
| Active task returns code `SYNTHETIC`, then echo | Task error preserves code; next work succeeds. |

## Sources

- Original sources and fixture tests above; [Bun Worker API](https://bun.com/docs/runtime/workers).
- Rust [threads](https://doc.rust-lang.org/std/thread/) and
  [bounded channels](https://doc.rust-lang.org/std/sync/mpsc/fn.sync_channel.html).
