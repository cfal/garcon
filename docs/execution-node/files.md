# Files On Execution Nodes

Status: architecture and design, 2026-09-21. Implementation uses the existing shared Noise WebSocket. No scheduler, pacing, priorities, or second channel is included; congestion isolation is deferred, likely to a second channel if needed.

This follows [Execution Node Interfaces](./interface.md) and [Execution Nodes In The App](./app-integration.md). Current implementation references were checked at `808d869658325b62c60c23782e986f76ded8b7a3`. Earlier documents describe their respective stages; the source now includes mandatory Noise encryption on execution-node connections.

## Scope

Make the existing file experience work against the selected execution node:

- Browse directories and select a project path, including before a chat exists.
- Resolve canonical file identities and populate file lists and autocomplete.
- Read text and binary content within the existing viewer limits.
- Check revisions and save edited text with conflict detection.
- Keep Local available through the same service boundary.

This is not filesystem synchronization, cross-node file copying, a general upload/download service, or a distributed filesystem. Git, terminals, filesystem watches, directory mutations, and unrestricted large-file transfers remain outside this proposal. Chat attachment uploads are a separate controller-side ingress path, even though their current HTTP routes live in the files module.

## Working Decisions

- Files are a node-level service, not an agent capability. They do not depend on the chat's provider, model, or native session.
- Browser requests continue through the controller's authenticated HTTP API. The controller-to-node hop uses Noise WebSocket transport.
- No worker REST listener or custom Noise-over-HTTP protocol. Both existing connection directions must remain usable, including workers that can only make outbound connections.
- Small operations use typed RPC. Content transfers use bounded chunks and ephemeral transfer references behind the file-service adapter.
- Writes stage content before a revision-checked commit. An uncertain commit is not automatically retried.
- File RPCs use the existing shared Noise WebSocket. Fragmentation only accommodates message size limits. Traffic scheduling versus a second channel remains a future decision, not implementation scope.

Method names and tuning values below are proposals, not an already implemented protocol.

## Existing Building Blocks

| Area | Current behavior |
| --- | --- |
| [ExecutionNode](../../server-agents/interface/src/contracts/execution-node.ts) | Both node implementations advertise `files: false`; `getFilesService()` is an unsupported placeholder. Local application file routes bypass it. |
| [File routes](../../server/routes/files.ts) | Implement browsing, identity, revisions, reads, and text saves with controller-local filesystem access and local-only target guards. |
| [File contracts](../../common/file-contracts.ts) | Already define canonical root/relative-path identity, opaque revisions, conflict policy, tree responses, and a 25 MiB viewer limit. Identity does not yet include the node. |
| [Revision operations](../../server/files/file-revision.ts) | Read bytes with before/after revision checks on an opened handle. Revisions derive from filesystem metadata, not a content hash. |
| Text saves | Serialize Garcon writes using a file lock, re-resolve the target, compare the expected revision, and return a revision from the opened write handle. The current implementation truncates/writes in place; it is not an atomic rename. |
| [Browser file sessions](../../web/src/lib/files/sessions/file-session-registry.svelte.ts) | Own documents, views, save/conflict handling, and draft recovery. Current document identity is root plus relative path, without node identity. |
| [Execution-node RPC](../../server/execution-nodes/agent-protocol.ts) | Already carries node-level methods such as project inspection alongside provider calls. A second generic RPC framework is unnecessary. |

Reuse these contracts and behaviors rather than building a separate remote editor. Move machine-dependent work behind the node boundary instead of retaining parallel local and remote route implementations.

## Architecture And Ownership

```text
Browser Files / editor / project picker
                 |
       Controller HTTP file routes
                 |
       selected ExecutionNode
                 |
         ExecutionFilesService
           /              \
Local implementation    Remote facade
           |              |
   Local filesystem   Noise WebSocket / typed RPC
                          |
                  Node file implementation
                          |
                    Node filesystem
```

The browser owns document state, unsaved buffers, conflicts, and user intent. Its API layer supplies an explicit node-qualified target. UI components never manage transfer handles or encode chunks.

The controller owns application authorization, node selection, chat-binding validation, HTTP response construction, cancellation propagation, and remote transfer orchestration. It does not use its own `realpath`, home directory, or filesystem to interpret a remote path.

The execution node owns its configured filesystem boundary, canonicalization, directory enumeration, file handles, revisions, save locks, transfer storage, and final writes. Local calls invoke that implementation directly; remote calls reach the same behavior through typed handlers. Common file behavior belongs in the node/file modules, not in individual provider packages.

Add the service contract alongside `ExecutionProjectService` and make `getFilesService()` return it. Advertise support in node descriptions and app DTOs. Enable file actions from that capability and node availability; do not remove the independent remote Git/terminal guards. Keep project inspection and authored `@file` expansion in the existing project service.

Noise protects the controller-to-node hop, including paths and contents. It does not hide files from the controller, encrypt the browser HTTP hop, or make local caches private. Browser connections still require the application's normal transport and authentication policy.

## Identity And Routing

A document identity is:

```text
(nodeId, canonicalFileRootPath, normalizedRelativePath)
```

Normalize absent/null node selection to `local` at the boundary. An explicit unknown or offline remote never falls back to Local. Identical path strings on two nodes identify different documents.

Carry the node through file requests, identity responses, document/session keys, pending loads, revision polling, tree/navigation state, and draft recovery keys. Keep the existing user/deployment partition on recovery data. The serving generation is not part of durable document identity: reconnecting must not lose an unsaved editor buffer.

Resolve paths on their owning node using its filesystem semantics and configured project base. Browsing before chat creation uses the chosen node's base directory. Chat-scoped files remain constrained to the validated project root; a client-supplied canonical path is not authority to escape that root or the node's base. Containment and symlink checks belong at actual file access, not just during project selection.

For chat-bound requests, capture and validate the node/path binding across asynchronous resolution and before mutation dispatch. A changed binding produces a stale-target error, not a second lookup that redirects the operation. Once dispatched, an operation stays attached to its captured node and target; a later handoff is not remote rollback.

An already-open file tab retains its own identity after chat selection or ownership changes. Transcript and permission-row links use their panel's chat context, not the global selected chat. New Chat browsing, tab completion, and sidebar path selection similarly retain their draft node while requests are in flight.

## Service Surface

The service exposes domain operations; chunking is an internal remote-adapter concern.

| Operation | Contract |
| --- | --- |
| Browse/list | Return bounded directory entries, breadcrumbs, or project-file candidates from the selected node. Include explicit pagination or truncation rather than silent incomplete success. |
| Resolve identity | Validate the root/path and return the node-qualified canonical identity. |
| Check revision | Return an opaque revision or the existing missing-file result. |
| Read text/content | Return bounded content and its revision. Raw-byte transport supports both text and binary viewers. |
| Save text | Accept content, expected revision, and explicit conflict policy; return the written revision only after confirmed success. |

Keep the existing browser HTTP shape where practical, adding node qualification and necessary bounded-list metadata. The remote facade assembles or stages content without exposing transport details to editor code. In-process calls do not need serialization, base64, or artificial network chunks.

Directory bounds must cover encoded bytes as well as entry counts. The current recursive file list has depth/result limits, but those alone do not bound the size of long paths, and the tree route is not a paged transfer. Exact paging versus capped-result behavior is still to be chosen. Do not accumulate an unlimited listing at the controller after making each individual RPC small.

## Framing And Identifiers

There are several independent identities on the current execution-node connection:

| Identity | Meaning |
| --- | --- |
| Logical transport session | The continuity lifetime that can survive a brief physical reconnection. |
| Transport `ordinal` | Monotonic per direction within that session, across all application messages. Supports replay, duplicate suppression, and gap detection. |
| RPC `id` | A UUID for one request, echoed by its result, error, or cancellation. |
| Producer `binding` | Routes chat events to one exact controller publication lease, scoped by node, serving instance, and integration. Lifecycle events also identify their run. |
| Transcript row identity | Controller-owned durable conversation identity, independent of transport numbering. |

[MessageSession](../../server/execution-nodes/message-session.ts) carries:

```ts
type Packet =
  | { kind: 'message'; ordinal: number; body: string }
  | { kind: 'receipt'; through: number };
```

`body` is the serialized application envelope. Noise encrypts this packet and handles encrypted-record fragmentation beneath it. A cumulative receipt confirms transport acceptance, not an RPC's completion or a durable write.

Files reuse the request/result/error/cancel envelope. Add a transfer reference and byte offset inside file requests, not a new transcript-style event stream or another reliable-delivery algorithm. Each chunk has its own RPC ID; the transfer reference groups the chunks.

A transfer reference identifies one read snapshot or staged write, owned by a node serving generation and its file-transport session. It is ephemeral and is never persisted in `chats.json`, a ledger, or browser recovery. Validate its node, generation, kind, and owning session before use. Files are not provider resources: do not assign them to an arbitrary integration just to reuse an agent-scoped resource type.

## Transfer Lifecycle

An illustrative wire surface is:

```text
files.openRead(target)                         -> transfer, size, revision
files.readChunk(transfer, offset, maxBytes)     -> offset, data, eof
files.beginWrite(target, size, revision, policy) -> transfer
files.writeChunk(transfer, offset, data)        -> nextOffset
files.commitWrite(transfer)                    -> revision
files.close(transfer)                          -> closed
```

Here `revision` on `beginWrite` is the expected destination revision, and `policy` is the existing reject/overwrite choice. The target and conflict policy are captured at creation; later chunk calls cannot retarget the write. Offsets and lengths count decoded bytes, not base64 characters or JavaScript string code units.

### Reads

The simplest initial implementation uses the existing bounded versioned read to obtain bytes and a revision, then serves an immutable snapshot in chunks. A file changing after that read does not mix new bytes into the remaining chunks. This preserves the current best-effort revision semantics rather than claiming filesystem snapshot isolation.

Snapshot bytes count against an aggregate node budget. Chunking bounds wire messages, not total memory: a worker snapshot and controller assembly can each hold a full file. Enforce the actual bytes read as well as the initial stat size, including files that grow during the read. A temporary spool or genuinely incremental reader can be introduced later if measured memory use requires it.

The remote facade requests another bounded chunk only when it has capacity. It checks the returned offset, total size, and EOF, and exposes only a complete successful read. Decode UTF-8 after byte assembly, or with a streaming decoder; independently decoding arbitrary byte chunks can corrupt characters split across chunks.

### Writes

The worker creates private staging storage and reserves transfer capacity before accepting content. Chunks write to staging, never directly to the destination. Validate encoded and decoded lengths, total size, contiguous offsets, and transfer ownership. Serialize operations within each write transfer; asynchronous RPC handlers are not inherently ordered merely because their messages arrived in order.

Commit requires all declared bytes. Under the node-owned save lock, re-resolve the destination, recheck containment and target identity, and apply the expected-revision/conflict policy immediately before writing. Return the revision of the actual completed write. A chunk acknowledgement means staged acceptance, not a saved file.

Staging protects the destination from an incomplete network upload. It does not by itself make the final filesystem write atomic or crash-durable. Preserve current save semantics initially unless replacement semantics are deliberately changed. In particular, switching from in-place writes to atomic rename affects hard links, permissions, and file identity; that is not an incidental transport optimization. External processes remain outside Garcon's save lock, so revision checks are not a transactional compare-and-swap against every filesystem writer.

Never automatically retry a commit whose outcome is unknown. Keep the editor dirty/uncertain and reconcile by reading the captured target before a deliberate next save. Matching bytes can establish the current content, not prove the history of a lost response.

### Cancellation And Cleanup

Closing a transfer releases snapshots, handles, reservations, and uncommitted staging. Make close idempotent. Forward browser aborts through the controller to file RPC cancellation and transfer cleanup; also apply worker-owned expiry because callers can disappear without sending close.

Use bounded transfer lifetimes and cleanup on owning-session replacement or node disposal. Expiry must not race a live commit or interpret cancellation as undoing a dispatched write. Crash leftovers in worker-owned staging may be removed on startup; never scan/delete arbitrary project temporary files, and never resume a staged write automatically.

## Size Limits And Backpressure

Current bounds, before file-service changes:

| Layer | Bound |
| --- | --- |
| Garcon production session packet | 16 MiB of encoded JSON, including envelopes; the standalone `MessageSession` default is only 1 MiB. |
| Noise application message | 16 MiB; larger messages are not made valid by encrypted-record fragmentation. |
| Noise encrypted frame | At most 65,535 bytes; fragmentation/reassembly is internal to the library. |
| Retained outgoing replay | 32 MiB / 4,096 messages per direction. Incoming pre-readiness replay is bounded separately. |
| Garcon socket-buffer guard | More than 4 MiB buffered causes continuity failure on a subsequent send. This is a safety guard, not a bulk scheduler. |
| RPC concurrency | 256 outgoing and 256 incoming calls; file traffic must not consume the entire shared allowance. |
| Existing file viewer | 25 MiB per file, independently of transport limits. |

Sources: [session transport](../../server/execution-nodes/session-transport.ts), [WebSocket link](../../server/execution-nodes/websocket-link.ts), [RPC](../../server/execution-nodes/rpc.ts), and the pinned Noise library's [limits](https://github.com/cfal/noise-ws/blob/536eb503e81a1f9d90436006d3821e2080630488/src/options.ts#L5) and [send checks](https://github.com/cfal/noise-ws/blob/536eb503e81a1f9d90436006d3821e2080630488/src/connection.ts#L60).

A reasonable starting point is 256 KiB of raw bytes per chunk, encoded as base64 in the existing JSON RPC. That is about 342 KiB plus envelopes, well below the message cap; a 25 MiB file takes 100 chunks. Base64 costs roughly one-third extra payload bandwidth, but avoids changing today's string-only Garcon transport. The Noise library supports binary messages; using them here would still require new Garcon framing and replay support.

The exact chunk size, in-flight window, concurrent-transfer count, snapshot/staging budgets, and expiry are tuning decisions. Regardless of channel topology:

- Bound aggregate outstanding file bytes and RPCs per node, not only per transfer.
- Advance from chunk completion and receiver capacity, not transport receipts alone. Never enqueue an entire file's chunks at once.
- Bound both memory and temporary disk use, and reject excess admissions with typed file errors.
- Reject or split oversized content/list responses before transport serialization can exhaust the session. An ordinary oversized file request must not disconnect running chats.
- Preserve per-transfer operation ordering without creating a general-purpose stream multiplexer prematurely.
- Propagate an overall operation deadline. Browser reads/saves currently have 30-second limits while RPCs default to 120 seconds; per-chunk timeouts alone cannot bound a whole transfer or prevent work after an HTTP timeout.

Keep file-size product policy separate from these limits. Retain the existing viewer cap; define an explicit text-save cap rather than accidentally deriving it from base64 size, a generic HTTP body limit, or replay capacity. No larger-file support is implied by chunking.

## Future Congestion Isolation

### Shared WebSocket With Scheduling

File RPCs share the existing logical session, replay sequence, authenticated connection, and reconnect lifecycle with agent work. This needs no second connection setup or association protocol.

If measurements later justify scheduling, it would reserve capacity for control/chat traffic and pace bulk chunks against socket capacity. That is not part of this implementation. Scheduling would need to happen before assigning transport ordinals; queued messages already in the ordered stream cannot be overtaken. Small chunks alone cannot eliminate head-of-line delay or isolate file-induced session failure completely.

### Separate Noise WebSocket

File traffic has its own socket buffers, RPC budget, and transport ordinals. Bulk congestion or a file-channel failure need not retire the chat connection. Both channels still share machine and network capacity; a second socket is not a bandwidth guarantee.

This adds connection ownership, authentication/association, readiness, retry, and shutdown work. Preserve the configured connection direction: an outbound-only worker must initiate the secondary connection too. Bind it to the authenticated node and current serving generation, use a fresh Noise handshake/key state, and reject stale associations. Do not create a second independent `InProcessExecutionNode` or let a file-channel reconnect replace the provider serving generation.

The secondary channel's exact association and reconnect policy are not specified here. It may abort its transfers on channel replacement; it does not need durable resume. Parent serving-generation retirement always invalidates its file transfers. Do not assume ordering between chat and file channels; commit depends on accepted chunks, not on relative arrival of unrelated messages.

### Decision Boundary

The initial implementation shares the existing WebSocket without traffic scheduling or pacing. Keep the file contract, identities, transfer lifecycle, and revision handling independent of future congestion isolation. If measured chat/Stop latency becomes a problem, reconsider scheduling versus secondary-channel ownership; a second channel is the preferred direction, not a current commitment.

## Failure And UI Behavior

| Observation | Behavior |
| --- | --- |
| Node unavailable before dispatch | Fail explicitly; do not fall back to controller-local files. Preserve open documents and unsaved buffers. |
| Brief disconnect with surviving transport/transfer lifetime | Existing transport may replay retained requests/results with duplicate suppression. Do not independently resend application mutations. |
| Owning file session or serving generation replaced | Invalidate old handles and discard uncommitted transfers. A new read starts from a new snapshot; no concatenation across sessions. |
| Missing, inaccessible, outside-root, or oversized file | Return the corresponding file error, not generic provider failure or empty successful content. |
| Revision conflict | Preserve the buffer and use the existing conflict workflow. Overwrite remains an explicit user choice. |
| Commit may have run but its result is lost | Surface uncertainty, retain the buffer, and require reconciliation before another save. Cancellation is not rollback. |
| Chat/path/node changes during an awaited UI request | Reject stale routing or discard stale presentation results; never attach them to a different node's document. |

File errors need typed serialization through both RPC and HTTP boundaries. Preserve useful existing codes such as `FILE_TOO_LARGE`, `FILE_CHANGED_DURING_READ`, and `FILE_REVISION_CONFLICT`, and distinguish definite rejection/non-dispatch from uncertain mutation outcomes. Throwing an arbitrary worker `DomainError` is not enough: today's RPC error adapter is agent-oriented and would otherwise lose the file-specific contract.

Enable remote browsing, file links, and editor actions only after the corresponding node service is available. Keep polling bounded to existing visible/user-demanded workflows; no filesystem watcher service is required. File unavailability must not clear recovery drafts or disable unrelated Local files, chats, Git, or terminals.

## Verification Criteria

The implementation must demonstrate these boundaries, not just successful chunk round-trips:

- Local and two workers with identical path strings but different contents: browse, read, save, recovery, and simultaneous panels never cross nodes.
- Both connection directions, including an outbound-only worker with no reachable worker REST endpoint.
- Node-side project-base and symlink checks, target changes during awaited resolution, and independent Git/terminal guards after Files is enabled.
- Byte-boundary and over-limit cases: binary data, split UTF-8 characters, malformed chunks, invalid offsets, incomplete writes, and large directory responses.
- Consistent read snapshots and revision-aware writes, including two concurrent saves, external changes, and conflict/overwrite behavior.
- Deterministic disconnects before dispatch, during chunks, and after commit but before its reply. No blind save retry, false-success UI, or stale transfer reuse.
- Cancellation, expiry, session replacement, and crash-staging cleanup with bounded memory/disk/RPC usage and retained editor buffers.
- Ordinary bounded file transfers coexist with chat traffic. No congestion isolation or latency guarantee under bulk load is implied.

Use unit/contract tests for parsers and transfer state, isolated real-process controller/worker tests for IO and transport failure, and browser coverage for project selection, file identity, editor conflicts, and buffer preservation. No paid provider calls are needed to validate the file service.
