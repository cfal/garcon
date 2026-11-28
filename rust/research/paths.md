# Path resolution

## Where the original uses it

- `server/common/path-boundary.ts:17-114` checks containment and walks to the
  nearest existing ancestor for a potentially missing path. Its callers include
  project inspection (`server/runtime/projects/project-service.ts:18-44`),
  Files (`server/runtime/files/service.ts:85-165`, `directory-reader.ts:56,115`),
  Git (`server/runtime/git/runtime.ts:96,231`, `operation-context.ts:96`,
  `discard.ts:76`), and terminals (`server/runtime/terminals/terminal-manager.ts:728`).
- Other user-influenced executor inputs reach realpath in file mentions
  (`server/runtime/projects/file-mentions.ts:95,106,180`), Git conflict reads
  and repository/worktree discovery (`server/runtime/git/conflicts.ts:110`,
  `repository-coordination.ts:12`, `worktree-admin.ts:42,203`), and native
  Claude/Pi sessions (`server-agents/claude/src/agents/claude/native-path.ts:56`,
  `server-agents/pi/src/agents/pi/pi-session-paths.ts:49,67,102`).
- Selected workspace/config roots and CLI cwd are also canonicalized
  (`server/common/workspace-lease.ts:35`, `server/controller/lib/workspace-lease.ts:14,16`,
  `server/common/server-runtime.ts:73`, `server/controller/ledger/directories.ts:12,32`,
  `cli/main.ts:134`). Executable or installation paths reach realpath in
  `server/runtime/agents/integration-host.ts:88,91` and
  `server-agents/common/src/cli-update/{cli-update-service.ts:256,install-resolution.ts:200}`.
- Static assets canonicalize the distribution root and candidate before
  opening through `Bun.file` (`server/controller/routes/static.ts:81-82,133`).
  Share text is opened directly from a server-owned filename
  (`server/controller/routes/shares.ts:202`).

## Behavior the port must keep

- On Linux under pinned Bun 1.4.3, **a literal backslash in the path passed to
  realpath** turns even an existing path into ENOENT. This is a property of
  the realpath input, not a filesystem name restriction: stat, lstat, access,
  and Bun.file still see the same entry. Do not apply this rule to generic
  path comparison, globbing, or all I/O.
- The boundary helper first checks lexical containment and then canonical
  containment. On ENOENT from realpath it checks lstat: if the entry exists,
  rethrow the original ENOENT. Only truly absent entries can be appended
  after finding a canonical parent. `inspectProjectDirectory` translates
  ENOENT, ENOTDIR and ELOOP to `not-found`; outside-base and permission errors
  have their own outcomes (`server/runtime/projects/project-directory-service.ts:21-46`).
- Do not expand that into a global ban on backslashes in canonical output.
  A slash-only alias can return a backslash-containing canonical name.
  Subsequent calls on that returned string may fail. Worktree administration
  has a separate forgiving walk that ignores ENOENT/ENOTDIR without an lstat
  check (`server/runtime/git/worktree-admin.ts:37-50,186`); preserve that
  caller's distinction from project containment.
- POSIX path operations treat the backslash as an ordinary name byte.
  Executor slash translation runs only with a Windows separator
  (`server/common/executor-path.ts:4-9`). The runtime realpath quirk documented
  here was measured on Linux, not on Windows.

## Rust implementation

Use the existing `garcon-js::path::{posix,win32}` for Bun-compatible lexical
operations; those paths built and their tests passed on Rust 1.99.1. Use
`std::fs::canonicalize` and `symlink_metadata` for the filesystem steps,
with the pinned-runtime ENOENT behavior at the realpath boundary only.
No external crate is needed. Native Rust filesystem parity is not yet
verified; the standard library does not promise Bun's Linux backslash quirk.

## Traps

Ran the original boundary and `ProjectService.inspect` on Linux under both
Bun versions. The fixture has real directories named `plain`, `back\\slash`,
and `C:\\`, each containing a `file.txt` whose body is `body`.

| Input | Bun 1.4.3 | Bun 1.4.5 (contrast only) |
| --- | --- | --- |
| Existing file in `plain` | All realpath forms return the canonical path. | Same. |
| Existing file in `back\\slash` or `C:\\` | Callback realpath, realpathSync, promises.realpath, callback realpath.native and realpathSync.native all return ENOENT. | All five return the canonical path. |
| stat, lstat, access, Bun.file.exists/text on either affected file | All succeed; exists is true and text is `body`. | Same. |
| `resolveRealWithinBase` with either existing affected file | ENOENT, not a missing-leaf success. | Returns the canonical path. |
| `ProjectService.inspect` on either affected directory by its literal name | `{resolution:{kind:"unavailable",reason:"not-found"}}`. | Available. |
| A symlink named `alias` to `back\\slash` | realpath succeeds and returns the backslash-containing target; project inspection of the alias is available. | Same. |
| Resolve absent `missing\\file` below the existing plain root | Boundary resolves it to the missing path, because lstat also says ENOENT and the parent canonicalizes. | Same. |

## Sources

- Original call sites above and the [Bun Node.js filesystem compatibility
  reference](https://bun.com/docs/runtime/nodejs-compat#node-fs). The
  version-specific difference is from runtime probes, not a documented Bun API.
- Rust [canonicalize](https://doc.rust-lang.org/std/fs/fn.canonicalize.html) and
  [symlink_metadata](https://doc.rust-lang.org/std/fs/fn.symlink_metadata.html);
  `rust/garcon-js/src/path.rs` and `rust/garcon-js/tests`.
