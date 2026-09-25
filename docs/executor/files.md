# Files On Executors

Status: architecture, updated 2026-09-24. Files use bounded inline RPC over the existing shared Noise WebSocket. No bulk transfer subsystem, scheduler, or second channel is included.

This follows [Executor Interfaces](./interface.md) and [Executors In The App](./app-integration.md). Current implementation references were checked at `808d869658325b62c60c23782e986f76ded8b7a3`. Earlier documents describe their respective stages; the source now includes mandatory Noise encryption on executor connections.

## Scope

Make the existing file experience work against the selected executor:

- Browse directories and select a project path, including before a chat exists.
- Resolve canonical file identities and populate file lists and autocomplete.
- Read text and binary content within the existing viewer limits.
- Check revisions and save edited text with conflict detection.
- Keep Local available through the same service boundary.

This is not filesystem synchronization, cross-executor file copying, a general upload/download service, or a distributed filesystem. Git, terminals, filesystem watches, directory mutations, and unrestricted large-file transfers remain outside this proposal. Chat attachment uploads are a separate controller-side ingress path, even though their current HTTP routes live in the files module.

## Working Decisions

- Files are an executor-level service, not an agent capability. They do not depend on the chat's provider, model, or native session.
- Browser requests continue through the controller's authenticated HTTP API. The controller-to-executor hop uses Noise WebSocket transport.
- No worker REST listener or custom Noise-over-HTTP protocol. Both existing connection directions must remain usable, including workers that can only make outbound connections.
- All operations use typed RPC. Content is limited to 4 MiB and carried inline as base64.
- Writes decode the complete request before a revision-checked save. An uncertain save is not automatically retried.
- File RPCs use the existing shared Noise WebSocket. Fragmentation only accommodates message size limits. Traffic scheduling versus a second channel remains a future decision, not implementation scope.

The limits below describe the supported protocol.

## Existing Building Blocks

| Area | Current behavior |
| --- | --- |
| [ExecutionRuntimeApi](../../server-agents/interface/src/contracts/execution-runtime.ts) | Both executor implementations advertise `files: false`; `getFilesService()` is an unsupported placeholder. Local application file routes bypass it. |
| [File routes](../../server/controller/routes/files.ts) | Implement browsing, identity, revisions, reads, and text saves with controller-local filesystem access and local-only target guards. |
| [File contracts](../../common/file-contracts.ts) | Already define canonical root/relative-path identity, opaque revisions, conflict policy, tree responses, and a 25 MiB viewer limit. Identity does not yet include the executor. |
| [Revision operations](../../server/runtime/files/file-revision.ts) | Read bytes with before/after revision checks on an opened handle. Revisions derive from filesystem metadata, not a content hash. |
| Text saves | Serialize Garcon writes using a file lock, re-resolve the target, compare the expected revision, and return a revision from the opened write handle. The current implementation truncates/writes in place; it is not an atomic rename. |
| [Browser file sessions](../../web/src/lib/files/sessions/file-session-registry.svelte.ts) | Own documents, views, save/conflict handling, and draft recovery. Current document identity is root plus relative path, without executor identity. |
| [Executor RPC](../../server/remote/transport/rpc-protocol.ts) | Already carries executor-level methods such as project inspection alongside provider calls. A second generic RPC framework is unnecessary. |

Reuse these contracts and behaviors rather than building a separate remote editor. Move machine-dependent work behind the executor boundary instead of retaining parallel local and remote route implementations.

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

The controller owns application authorization, executor selection, chat-binding validation, HTTP response construction, cancellation propagation, and remote transfer orchestration. It does not use its own `realpath`, home directory, or filesystem to interpret a remote path.

The executor owns its configured filesystem boundary, canonicalization, directory enumeration, file handles, revisions, save locks, transfer storage, and final writes. Local calls invoke that implementation directly; remote calls reach the same behavior through typed handlers. Common file behavior belongs in the executor/file modules, not in individual provider packages.

Add the service contract alongside `ExecutionProjectService` and make `getFilesService()` return it. Advertise support in executor descriptions and app DTOs. Enable file actions from that capability and executor availability; do not remove the independent remote Git/terminal guards. Keep project inspection and authored `@file` expansion in the existing project service.

Noise protects the controller-to-executor hop, including paths and contents. It does not hide files from the controller, encrypt the browser HTTP hop, or make local caches private. Browser connections still require the application's normal transport and authentication policy.

## Identity And Routing

A document identity is:

```text
(executorId, canonicalFileRootPath, normalizedRelativePath)
```

Normalize absent/null executor selection to `local` at the boundary. An explicit unknown or offline remote never falls back to Local. Identical path strings on two executors identify different documents.

Carry the executor through file requests, identity responses, document/session keys, pending loads, revision polling, tree/navigation state, and draft recovery keys. Keep the existing user/deployment partition on recovery data. The serving generation is not part of durable document identity: reconnecting must not lose an unsaved editor buffer.

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

Keep the existing browser HTTP shape, adding executor qualification and bounded-list metadata. The remote facade encodes complete bounded files without exposing transport details to editor code. In-process calls do not need serialization or base64.

Directory bounds must cover encoded bytes as well as entry counts. The current recursive file list has depth/result limits, but those alone do not bound the size of long paths, and the tree route is not a paged transfer. Exact paging versus capped-result behavior is still to be chosen. Do not accumulate an unlimited listing at the controller after making each individual RPC small.

## Framing And Identifiers

There are several independent identities on the current executor connection:

| Identity | Meaning |
| --- | --- |
| Logical transport session | The continuity lifetime that can survive a brief physical reconnection. |
| RPC `id` | A UUID for one request, echoed by its result, error, or cancellation. |
| Producer `binding` | Routes chat events to one exact controller publication lease, scoped by executor, serving instance, and integration. Lifecycle events also identify their run. |
| Transcript row identity | Controller-owned durable conversation identity, independent of transport numbering. |

Files reuse the typed request/result/error/cancel RPC envelope. Reads and text saves each use one request and one result:

```text
files.read(target) -> { data: base64, path, revision }
files.save({ target, data: base64, expectedRevision, conflictResolution }) -> saved revision
```

The method set is explicit. There are no application-level chunks, transfer handles, staged uploads, transfer expiry, or crash-staging cleanup.

## Size Limits And Writes

Files are limited to **4 MiB** for viewing and text saves, on Local and remote executors. Image reads remain binary internally; the editor still saves UTF-8 text, not arbitrary uploaded binaries. Oversized files fail with `FILE_TOO_LARGE`; they are not silently truncated.

Base64 keeps the complete file below 6 MiB even when its text contains control characters that would expand heavily under JSON escaping. The existing 16 MiB session-packet limit and lower-level socket framing remain independent bounds. Validate encoded length, decoded length, and encoding before accepting a save.

A read uses the existing versioned-file snapshot and returns bytes with its revision. A save reaches the file service only after the complete request is decoded. Under the existing executor-owned save lock, re-resolve containment and target identity, then check the expected revision immediately before writing. Preserve in-place filesystem write semantics and explicit overwrite. External writers remain outside this lock.

At most eight content reads or saves run concurrently per process; metadata and directory queries do not consume these slots. Reads and saves use a 30-second remote call deadline. Cancellation is best effort, not rollback. A lost save confirmation produces `FILE_SAVE_OUTCOME_UNKNOWN`; the editor keeps its buffer and reconciles the captured target before a deliberate next save. Nothing automatically resends a mutation.

File traffic shares the authenticated executor connection. Its bounded send queue provides backpressure, not latency isolation. No traffic scheduler or second connection is included. Larger files or stronger congestion isolation require a separate product decision.

## Failure And UI Behavior

Files and Git share an executor selector. Its Network icon matches the Executors menu item and uses the semantic folder-icon theme color. Hide the selector when Local is the only configured executor; configured offline remotes still count. Without a selected chat, Files opens the Local project base and follows the next selected chat. Explicit executor browsing remains independent of chat changes until the user chooses "Go to chat project".

When switching executors, try the current directory on the destination before defaulting to its project base. Fall back only for a missing, non-directory, or outside-base path. Permission and connectivity failures remain explicit. Abort and generation fencing prevent an old executor's directory response from replacing the newly selected executor's tree. No executor switch retargets already-open file tabs or unsaved buffers.

| Observation | Behavior |
| --- | --- |
| Executor unavailable before dispatch | Fail explicitly; do not fall back to controller-local files. Preserve open documents and unsaved buffers. |
| Connection lost after possible dispatch | Report an uncertain save; never resend it automatically. Reads may be requested again. |
| Missing, inaccessible, outside-root, or oversized file | Return the corresponding file error, not generic provider failure or empty successful content. |
| Revision conflict | Preserve the buffer and use the existing conflict workflow. Overwrite remains an explicit user choice. |
| Commit may have run but its result is lost | Surface uncertainty, retain the buffer, and require reconciliation before another save. Cancellation is not rollback. |
| Chat/path/executor changes during an awaited UI request | Reject stale routing or discard stale presentation results; never attach them to a different executor's document. |

File errors need typed serialization through both RPC and HTTP boundaries. Preserve useful existing codes such as `FILE_TOO_LARGE`, `FILE_CHANGED_DURING_READ`, and `FILE_REVISION_CONFLICT`, and distinguish definite rejection/non-dispatch from uncertain mutation outcomes. Throwing an arbitrary worker `DomainError` is not enough: today's RPC error adapter is agent-oriented and would otherwise lose the file-specific contract.

Enable remote browsing, file links, and editor actions only after the corresponding executor service is available. Keep polling bounded to existing visible/user-demanded workflows; no filesystem watcher service is required. File unavailability must not clear recovery drafts or disable unrelated Local files, chats, Git, or terminals.

## Verification Criteria

The implementation must demonstrate these boundaries:

- Local and two workers with identical path strings but different contents: browse, read, save, recovery, and simultaneous panels never cross executors.
- Both connection directions, including an outbound-only worker with no reachable worker REST endpoint.
- Executor-side project-base and symlink checks, target changes during awaited resolution, and independent Git/terminal guards after Files is enabled.
- Byte-boundary and over-limit cases: image bytes, UTF-8 text, malformed base64, escaped content, and large directory responses.
- Consistent read snapshots and revision-aware writes, including two concurrent saves, external changes, and conflict/overwrite behavior.
- Deterministic disconnects before dispatch and after a save but before its reply. No blind retry or false-success UI.
- Cancellation and session replacement with bounded memory/RPC usage and retained editor buffers.
- Ordinary bounded file transfers coexist with chat traffic. No congestion isolation or latency guarantee under bulk load is implied.

Use unit/contract tests for parsers and size limits, isolated real-process controller/worker tests for IO and transport failure, and browser coverage for project selection, file identity, editor conflicts, and buffer preservation. No paid provider calls are needed to validate the file service.
