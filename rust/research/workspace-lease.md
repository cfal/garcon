# Workspace lease

## Where the original uses it

- `server/common/workspace-lease.ts:30-65` creates and canonicalizes the directory,
  acquires its lock and wraps acquisition errors as `WORKSPACE_IN_USE`.
- `server/controller/lib/workspace-lease.ts:6-35` locks the config root first,
  rejects the worker's reserved directory and its descendants, coalesces equal
  canonical config/workspace paths, and releases in reverse order, including
  releasing the config lock when workspace acquisition fails.
- `server/remote/worker.ts:39` takes a lease on the worker data directory. Controller
  and worker must share the same lock protocol.

## Behavior the port must keep

- Lock `<canonical-directory>/.garcon-workspace.lock` with atomic directory
  creation. It is an empty directory, not a PID file or an advisory kernel lock.
  Canonicalization happens before calling proper-lockfile with `realpath: false`.
  Directory creation and realpath errors at that outer step are not wrapped as
  `WorkspaceInUseError` (`server/common/workspace-lease.ts:34-38,63-65`).
- On an existing lock, compare directory mtime (as integer JS milliseconds)
  using **strictly** `mtime < Date.now() - stale`. Remove stale locks with
  nonrecursive `rmdir` and attempt atomic mkdir again. A vanished entry on
  stat also permits one fresh mkdir. That immediate retry skips the stale check
  so it does not remove another contender's new lock. Ignore only ENOENT on
  removal (`proper-lockfile/lib/lockfile.js`, `acquireLock`, `removeLock`).
- Garcon defaults to 30 s stale, 5 s heartbeat, 12 retries after the initial
  attempt, randomized 1.5x backoff starting at 250 ms and capped at 5 s.
  proper-lockfile floors stale at 2 s and clamps heartbeat to between 1 s and
  half stale. The retry package multiplies each nominal delay by a random
  factor in [1, 2), rounds and clamps, then sorts the schedule
  (`server/common/workspace-lease.ts:41-49`; `retry/lib/retry.js`).
- First acquisition per FS adapter probes mtime granularity by setting both
  timestamps to the next whole second (ceiling) plus 5 ms and reading the
  result. Later acquisitions read the new directory timestamp without
  repeating that probe. Heartbeats set both timestamps with millisecond
  precision, or round up to the next second on a seconds-only filesystem.
- A heartbeat must see its own last mtime before updating it. Changed mtime
  or missing directory compromises ownership immediately. Other stat/utimes
  errors retry after 1 s until the last successful update is older than the
  stale threshold. Expiry alone does not compromise a lock whose mtime still
  matches; it can recover after a stall. On compromise, cancel further
  heartbeats, forget ownership, call `onCompromised`, and do not remove the
  entry (`proper-lockfile/lib/lockfile.js`, `updateLock`, `setLockAsCompromised`).
- Release stops the heartbeat and removes the directory nonrecursively; the
  Garcon handle calls library release at most once, even if it rejects.
  Coordinate heartbeat shutdown with release. proper-lockfile also removes
  remembered locks at process exit; an abrupt death that bypasses cleanup
  requires stale takeover, not PID inspection.

## Rust implementation

The protocol is the original's directory and timestamps, not a library lock
format. Use Rust 1.99.1's `std::fs` for create, stat and nonrecursive remove.
`File::set_times` with `FileTimes` can set mtime and atime on an open directory
on Unix; opening/updating a directory this way on Windows is unverified.
No third-party lock crate or features are required. Keep storage ownership
and heartbeat shutdown separate from the timer used to run them.

## Traps

Inputs below use the original `acquireWorkspaceLease` on Bun 1.4.3.

| Input | Original result |
| --- | --- |
| Acquire through a symlink and again through its canonical target with zero retries | First returns canonical directory and creates an empty directory. Second rejects with `WORKSPACE_IN_USE`, cause `ELOCKED: Lock file is already being held`. |
| Release. Call the same handle's release again. | Both resolve; the lock directory is absent. |
| Set lock mtime 1.5 s in the past and request stale 100 ms, zero retries | Still held: the stale threshold floors at 2 s. |
| Set lock mtime 4 s in the past, request stale 2 s and update 100 ms | Acquires; on the next heartbeat, mtime advances despite the short requested update being clamped to 1 s. |
| Change the held lock's mtime before the next heartbeat | Calls compromise with `ECOMPROMISED: Unable to update lock within the stale threshold`. Explicit release then rejects with `ERELEASED`, leaving the directory alone. |
| A stale lock directory contains a file | Rejects acquisition; cause `ENOTEMPTY`. It does not delete the file. |

## Sources

- `server/node_modules/proper-lockfile/lib/lockfile.js` and
  `lib/mtime-precision.js` (proper-lockfile 4.1.2);
  `node_modules/.bun/retry@0.12.0/node_modules/retry/lib/retry.js`.
- `server/common/__tests__/workspace-lease.test.js` exercises the actual
  controller and worker lease wrapper.
- Rust standard library:
  [create_dir](https://doc.rust-lang.org/std/fs/fn.create_dir.html),
  [remove_dir](https://doc.rust-lang.org/std/fs/fn.remove_dir.html),
  [File::set_times](https://doc.rust-lang.org/std/fs/struct.File.html#method.set_times).
