# Files On Executors

Status: implemented architecture, updated 2026-10-05. Files use bounded inline RPC over the executor's paired Noise lanes. Content, directory listings, and directory creation use bulk; identity and revision use primary. There is no generic transfer-handle or byte-replay protocol.

The historical [Executor Interfaces](./interface.md) and [Executors In The App](./app-integration.md) describe earlier stages. [Executor Transport](./transport.md) owns the current connection contract; this document describes the implemented file service.

## Scope

Make the existing file experience work against the selected executor:

- Browse directories and select a project path, including before a chat exists.
- Create one directory inside a browsed directory while selecting a project path.
- Resolve canonical file identities and populate file lists and autocomplete.
- Read text and binary content within the existing viewer limits.
- Check revisions and save edited text with conflict detection.
- Keep Local available through the same service boundary.

This is not filesystem synchronization, cross-executor file copying, a general upload/download service, or a distributed filesystem. Git, terminals, filesystem watches, and unrestricted large-file transfers remain outside this proposal, as do renaming, moving, and deleting files or directories and creating nested paths in one request. Chat attachment uploads are a separate controller-side ingress path, even though their current HTTP routes live in the files module.

## Working Decisions

- Files are an executor-level service, not an agent capability. They do not depend on the chat's provider, model, or native session.
- Browser requests continue through the controller's authenticated HTTP API. The controller-to-executor hop uses Noise WebSocket transport.
- No worker REST listener or custom Noise-over-HTTP protocol. Both existing connection directions must remain usable, including workers that can only make outbound connections.
- All operations use typed RPC. Content is limited to 4 MiB and carried inline as base64.
- Writes decode the complete request before a revision-checked save. An uncertain save is not automatically retried.
- File RPCs use the selected lane under one executor authority. Fragmentation accommodates bounded messages; bulk loss neither retires primary nor reroutes file bodies onto it.

The limits below describe the supported protocol.

## Current Implementation

| Area | Current behavior |
| --- | --- |
| [ExecutionRuntimeApi](../../server-agents/interface/src/contracts/execution-runtime.ts) | Local and remote executors expose the typed `getFilesService()` and advertise file support. |
| [File routes](../../server/controller/routes/files.ts) | Resolve executor-qualified targets and route browsing, identity, revisions, reads, text saves, and directory creation through the selected service. |
| [File contracts](../../common/file-contracts.ts) | Define executor-qualified canonical root/relative-path identity, opaque revisions, conflict policy, tree responses, and a 4 MiB content limit. |
| [Revision operations](../../server/runtime/files/file-revision.ts) | Read bytes with before/after revision checks on an opened handle. Revisions derive from filesystem metadata, not a content hash. |
| Directory creation | Creates one named child of an existing directory inside the executor's project base. Never creates intermediate directories or replaces an existing entry. |
| Text saves | Serialize Garcon writes using a file lock, re-resolve the target, compare the expected revision, and return a revision from the opened write handle. The current implementation truncates/writes in place; it is not an atomic rename. |
| [Browser file sessions](../../web/src/lib/files/sessions/file-session-registry.svelte.ts) | Own executor-qualified live documents, views, and save/conflict handling. |
| [Executor RPC](../../server/remote/transport/rpc-protocol.ts) | Already carries executor-level methods such as project inspection alongside provider calls. A second generic RPC framework is unnecessary. |

Local and remote use the same machine-service implementation and editor behavior, without parallel route implementations.

## Architecture And Ownership

```text
Browser Files / editor / project picker
                 |
       Controller HTTP file routes
                 |
       selected ExecutionRuntimeApi
                 |
         ExecutionFilesService
           /              \
Local implementation    Remote facade
           |              |
   Local filesystem   Noise WebSocket / typed RPC
                          |
                  Executor file implementation
                          |
                    Executor filesystem
```

The browser owns document state, unsaved buffers, conflicts, and user intent. Its API layer supplies an explicit executor-qualified target. UI components never manage transfer handles or encode chunks.

The controller owns application authorization, executor selection, chat-binding validation, HTTP response construction, cancellation propagation, and RPC dispatch. It does not use its own `realpath`, home directory, or filesystem to interpret a remote path.

The executor owns its configured filesystem boundary, canonicalization, directory enumeration, file handles, revisions, save locks, and final writes. Local calls invoke that implementation directly; remote calls reach the same behavior through typed handlers. There is no transfer storage. Common file behavior belongs in the executor/file modules, not in individual provider packages.

The service contract sits alongside `ExecutionProjectService`. Executor descriptions and app DTOs advertise support; file actions require that capability and executor availability. Git and terminals have independent service admission. Project inspection and authored `@file` expansion remain in the project service.

Noise protects the controller-to-executor hop, including paths and contents. It does not hide files from the controller, encrypt the browser HTTP hop, or make local caches private. Browser connections still require the application's normal transport and authentication policy.

## Identity And Routing

A document identity is:

```text
(executorId, canonicalFileRootPath, normalizedRelativePath)
```

Normalize absent/null executor selection to `local` at the boundary. An explicit unknown or offline remote never falls back to Local. Identical path strings on two executors identify different documents.

Carry the executor through file requests, identity responses, document/session keys, pending loads, revision polling, tree/navigation state, and recovery drafts. Keep the existing user/deployment partition on persisted navigation and drafts. The serving generation is not part of document identity: reconnecting must not lose an unsaved editor buffer.

Unsaved content has best-effort browser-local IndexedDB backups, not cross-computer
synchronization. Retain the existing debounced checkpoints, bounded storage,
recovery prompts, and cleanup controls. Recover only against the original
executor/root/path; never substitute Local when that executor is unavailable.
Retain live edits through temporary outages, ordinary view switches, and executor
changes without transferring their original file identity. Explicit destructive
close/replace actions still require the existing dirty-buffer confirmation, and
page unload retains its best-effort browser guard. Backups do not replace explicit
saves or guarantee recovery after browser storage failure or eviction.

Resolve paths on their owning executor using its filesystem semantics and configured project base. Browsing before chat creation uses the chosen executor's base directory. Chat-scoped files remain constrained to the validated project root; a client-supplied canonical path is not authority to escape that root or the executor's base. Containment and symlink checks belong at actual file access, not just during project selection.

For chat-bound requests, capture and validate the executor/path binding across asynchronous resolution and before mutation dispatch. A changed binding produces a stale-target error, not a second lookup that redirects the operation. Once dispatched, an operation stays attached to its captured executor and target; a later handoff is not remote rollback.

An already-open file tab retains its own identity after chat selection or ownership changes. Transcript and permission-row links use their panel's chat context, not the global selected chat. New Chat browsing, tab completion, and sidebar path selection similarly retain their draft executor while requests are in flight.

## Service Surface

The service exposes domain operations; bounded base64 encoding is an internal remote-adapter concern.

| Operation | Contract |
| --- | --- |
| Browse/list | Return bounded directory entries, breadcrumbs, or project-file candidates from the selected executor. Include explicit pagination or truncation rather than silent incomplete success. |
| Resolve identity | Validate the root/path and return the executor-qualified canonical identity. |
| Check revision | Return an opaque revision or the existing missing-file result. |
| Read text/content | Return bounded content and its revision. Raw-byte transport supports both text and binary viewers. |
| Save text | Accept content, expected revision, and explicit conflict policy; return the written revision only after confirmed success. |
| Create directory | Accept an existing parent inside the project base and one name; return the created directory's canonical path only after confirmed success. |

Keep the existing browser HTTP shape, adding executor qualification and bounded-list metadata. The remote facade encodes complete bounded files without exposing transport details to editor code. In-process calls do not need serialization or base64.

Directory responses are capped at 10,000 entries and one MiB of encoded entries. Tree/browse overflow rejects with `FILE_LIST_TOO_LARGE`; recursive project listing returns `truncated: true` when its traversal or result budget is exhausted. There are no unbounded controller-side listing accumulators or paging handles.

## Framing And Identifiers

There are several independent identities on the current executor connection:

| Identity | Meaning |
| --- | --- |
| Transport session | One authenticated socket lifetime. Every disconnect retires it; there is no transport replay or session resumption. |
| RPC `id` | A UUID for one request, echoed by its result, error, or cancellation. |
| Producer `binding` | Routes chat events to one exact controller publication lease, scoped by executor, serving instance, and integration. Lifecycle events also identify their run. |
| Transcript row identity | Controller-owned durable conversation identity, independent of transport numbering. |

Files reuse the typed request/result/error/cancel RPC envelope. Reads and text saves each use one request and one result:

```text
files.read(target) -> { data: base64, path, revision }
files.save({ target, data: base64, expectedRevision, conflictResolution }) -> saved revision
files.createDirectory({ parentPath, name }) -> { name, path, type: 'directory' }
```

The method set is explicit. There are no application-level chunks, transfer handles, staged uploads, transfer expiry, or crash-staging cleanup.

## Size Limits And Writes

Files are limited to **4 MiB** for viewing and text saves, on Local and remote executors. Image reads remain binary internally; the editor still saves UTF-8 text, not arbitrary uploaded binaries. Oversized files fail with `FILE_TOO_LARGE`; they are not silently truncated.

Base64 keeps the complete file below 6 MiB even when its text contains control characters that would expand heavily under JSON escaping. The existing 16 MiB session-packet limit and lower-level socket framing remain independent bounds. Validate encoded length, decoded length, and encoding before accepting a save.

A read uses the existing versioned-file snapshot and returns bytes with its revision. A save reaches the file service only after the complete request is decoded. Under the existing executor-owned save lock, re-resolve containment and target identity, then check the expected revision immediately before writing. Preserve in-place filesystem write semantics and explicit overwrite. External writers remain outside this lock.

At most eight content reads or saves run concurrently per process; metadata and directory queries do not consume these slots. Reads and saves use a 30-second remote call deadline. Cancellation is best effort, not rollback. A save confirmation that cannot be recovered produces `FILE_SAVE_OUTCOME_UNKNOWN`; the editor keeps its buffer and reconciles the captured target before a deliberate next save. No mutation is retried without positive nonreceipt proof.

`POST /api/v1/files/directories?executorId=...&path=<parent>` with `{ name }` creates a directory. The target comes only from the URL. A name is one path segment of at most 255 bytes: not empty, `.`, or `..`, and free of separators and control characters. The executor's file service is the authority for this rule on Local and remote executors alike; the RPC layer checks only the request's shape. The picker applies the same rule before sending, so the user sees the reason inline, and trims surrounding whitespace from a typed name. The service creates the name exactly as given. The executor resolves the parent to its canonical path inside the project base, requires it to be a directory, and creates the child with one non-recursive `mkdir`. It opens the parent, confirms through the descriptor that the opened directory is still the validated path, and creates the child through that descriptor, so replacing a path component with a link after validation cannot redirect the creation; a parent that changed fails with `FILE_REVISION_CONFLICT` or `FILE_NOT_FOUND` and nothing is created. There is no path-based fallback. This runtime has no descriptor-relative `mkdir`, so creation needs a system that names open descriptors by path, which today is Linux with `/proc`. An executor reports this as `services.directoryCreation`, published to the browser as `machineServices.directoryCreation`. Where it is false (macOS, Windows, Linux without `/proc`), the file service rejects creation with `OPERATION_UNSUPPORTED` and creates nothing, and the picker offers neither "New directory" nor a create suggestion for that executor. Browsing and selecting are unaffected. Tests that create directories run only where the capability is detected; `bun run test:server:no-descriptor-paths` repeats the file-service tests as a system without descriptor paths, and CI runs it alongside the server tests. An existing file, directory, or symbolic link of that name fails with `FILE_ALREADY_EXISTS`. Creation does not use a content slot or the save lock. Like a save, it is journaled and is sent again only with positive nonreceipt proof; a confirmation that cannot be recovered produces `FILE_CREATE_OUTCOME_UNKNOWN`, and the directory may exist.

File content and directory traffic are isolated from primary's socket queue. Both lanes share bounded call and queue admission, reserving primary capacity. Bulk acquisition waits at most 20 seconds within the call's existing deadline. Journaled replies survive replacement on the same worker; only positive nonreceipt proof permits a resend. A missing reply alone never permits speculative save replay. CPU, disk, and network bandwidth remain shared.

## Failure And UI Behavior

Files and Git share an executor selector. Its Network icon matches the Executors menu item and uses the semantic folder-icon theme color. Hide the selector when Local is the only configured executor; configured offline remotes still count. Without a selected chat, Files opens the Local project base and follows the next selected chat. Explicit executor browsing remains independent of chat changes until the user chooses "Go to chat project".

When switching executors, try the current directory on the destination before defaulting to its project base. Fall back only for a missing, non-directory, or outside-base path. Permission and connectivity failures remain explicit. Abort and generation fencing prevent an old executor's directory response from replacing the newly selected executor's tree. No executor switch retargets already-open file tabs or unsaved buffers.

| Observation | Behavior |
| --- | --- |
| Executor unavailable before dispatch | Fail explicitly; do not fall back to controller-local files. Preserve open documents and unsaved buffers. |
| Connection lost after possible dispatch | Reconcile on the same worker within the call deadline. Without retained proof, report an uncertain save; never retry it speculatively. Reads may be requested again. |
| Bulk unavailable with healthy primary | Preserve buffers and selection; primary identity/revision, Stop, and Git summary remain available. Content operations wait within their lane-acquisition budget. |
| Missing, inaccessible, outside-root, or oversized file | Return the corresponding file error, not generic provider failure or empty successful content. |
| Revision conflict | Preserve the buffer and use the existing conflict workflow. Accept Disk and Save Checked reject a comparison if its local buffer version changed. Overwrite remains an explicit user choice. |
| Commit may have run but its result is lost | Surface uncertainty, retain the buffer, and require reconciliation before another save. Cancellation is not rollback. |
| Chat/path/executor changes during an awaited UI request | Reject stale routing or discard stale presentation results; never attach them to a different executor's document. |
| Directory creation may have run but its result is lost | Report that the creation is unconfirmed, keep the entered name, and read the listing again. Never resend it automatically. |
| Directory creation settles after the picker moved elsewhere | Leave the picker where the user put it. A result for another directory or executor never navigates or selects. |

File errors use typed serialization through both RPC and HTTP boundaries, preserving codes such as `FILE_TOO_LARGE`, `FILE_CHANGED_DURING_READ`, and `FILE_REVISION_CONFLICT`. The RPC adapter preserves domain errors and distinguishes definite rejection/non-dispatch from uncertain mutation outcomes.

The project directory picker has two presentations over one state model. On mobile it is a full-screen sheet that opens on the field's directory, keeps navigation local, and changes the field only through "Select this directory"; a field path that names no directory opens its parent, filtered by the name when it is missing. Each ancestor tried costs one listing, so after three the sheet opens the base instead of walking a deep missing path. The picker relies on browse reporting `FILE_NOT_FOUND` and `FILE_DIRECTORY_REQUIRED` for those paths. Elsewhere it is a popover under the field: a typed path lists its parent filtered by the name under edit, and opening a directory writes that directory to the field and lists its children. Both create a directory in the listed directory and then enter it, and both offer to create a looked-for name that no listed directory has. A directory the user opened from a listing on the same executor can be selected while its own entries load; a typed, fallback, or failed directory cannot until it lists. In the popover, ArrowDown moves from the field into the list and ArrowUp returns, since a field may reserve Tab for completion. The creation form belongs to the directory it was opened in. A creation that settles after the picker closed changes nothing.

Enable remote browsing, file links, and editor actions only after the corresponding executor service is available. Keep polling bounded to existing visible/user-demanded workflows; no filesystem watcher service is required. File unavailability must not clear live buffers or disable unrelated Local files, chats, Git, or terminals.

## Verification Criteria

The implementation must demonstrate these boundaries:

- Local and two workers with identical path strings but different contents: browse, read, save, live buffers, and simultaneous panels never cross executors.
- Both connection directions, including an outbound-only worker with no reachable worker REST endpoint.
- Executor-side project-base and symlink checks, target changes during awaited resolution, and independent Git/terminal guards after Files is enabled.
- Byte-boundary and over-limit cases: image bytes, UTF-8 text, malformed base64, escaped content, and large directory responses.
- Consistent read snapshots and revision-aware writes, including two concurrent saves, external changes, and conflict/overwrite behavior.
- Deterministic disconnects before dispatch and after a save but before its reply. No blind retry or false-success UI.
- Directory creation on Local and both connection directions: identical names on different executors, existing names, names that would escape or nest, parents outside the base or reached through escaping links, a parent swapped for a link before it is opened and immediately before creation, a system without descriptor paths with the parent swapped after the last check, and a reply lost after creation.
- Cancellation and session replacement with bounded memory/RPC usage and retained editor buffers.
- Held bulk file transfers do not block primary controls; no CPU, disk, or whole-network latency guarantee is implied.

Use unit/contract tests for parsers and size limits, isolated real-process controller/worker tests for IO and transport failure, and browser coverage for project selection and directory creation in both picker presentations, file identity, editor conflicts, and buffer preservation. No paid provider calls are needed to validate the file service.
