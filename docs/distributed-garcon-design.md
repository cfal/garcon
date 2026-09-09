# Distributed Garcon: One Controller, Supervised Execution Nodes

Status: comprehensive implementation proposal, revised 2026-09-09 against
`bb1b4a019e28f76a172ba27a775c0b617047f895`. The product decisions below are
settled; distributed execution is not implemented by this document. Other
untracked proposals are not evidence of shipped behavior. All new paths,
flags, endpoints, and contracts below are proposed, not existing APIs.

## Resolved product decisions

- One controller owns the chat registry and authoritative per-chat V5 ledgers.
  Execution nodes host multiple provider instances plus files, Git, and PTYs.
  Multiple instances of the same provider are supported.
- The controller is the parent and must stay available. A bounded reconnect
  grace period tolerates network blips; it is not unattended offline execution.
- Nodes initiate authenticated, bidirectional connections to a reachable
  controller. Nodes need no public inbound port. Self-signed certificates are
  supported through explicit, connection-scoped trust; a public CA is optional.
- Remote output may use an optional, lossy replay cache. Initial implementation:
  RAM, five-minute retention, 20 MiB aggregate cap per node/controller namespace.
  Temporary disk is a permitted later backend, not durable execution recovery.
  An unrecoverable gap stops the affected turn and offers manual native Reload.
- V5 remains entirely on the controller. Transport sequence numbers, buffering,
  duplicate suppression, and acknowledgements are outside its publisher.
- Without configured nodes, preserve the current startup, local agents, and UX.
  No loopback RPC, remote replay cache, heartbeat, enrollment, or node selectors.
- Files and Git retain selected-chat-following behavior. Existing editor and
  terminal sessions retain their original resource targets.
- Changing execution location uses the existing handoff/carryover/compaction
  mechanisms. Never copy or resume native history on another machine, including
  Direct history. No repository or file synchronization is implied.
- Preamble scopes are Everywhere, Selected nodes, and Selected projects.
  Definitions and ordered chat selections remain controller-owned.
- Schedules exist only on the controller. New-chat schedules select a node;
  existing-chat schedules follow that chat's current execution binding.
- Title, handoff-summary, commit-message, and prompt-refinement generation default
  to the controller, with an independent configured placement for each operation.
  Native `/compact` always executes with its existing session on its owning node.
- Direct endpoint definitions, shared settings, and credentials are managed on
  the controller. Compatible nodes receive the configuration and credentials
  needed for admitted work; their native sessions remain node-local.
- Remote web previews and general port forwarding are out of scope. There is
  no existing single-node web-preview feature to preserve.

The governing transcript contract remains
[`docs/transcript-ledger-v5-design.md`](transcript-ledger-v5-design.md),
revision 37. Its Direct-history correction describes shipped behavior. This
proposal does not add retries, producer identities, asynchronous acceptance,
pruning, or a second serving ledger to V5. The controller ingress invokes the
existing captured sink synchronously. A short boundary clarification may be
added when implementing the adapter; transport recovery belongs in this design
and its own tests. Historical execution-location metadata is a separate,
explicit ledger/codec extension described below, not a transport cursor.

## Decision and scope

Use the same Garcon distribution. Its default startup remains one controller
hosting local server agents and files/Git/terminals in the same server process,
with providers spawning their ordinary processes as today. Execution-only or
controller-without-local-execution roles are explicit opt-ins. The architecture
may call the default composition hybrid, but users do not select a hybrid mode
or run a second Garcon daemon. Factor services by ownership rather than having
one full chat server call another full chat server's chat APIs.

Proposed `--execution-node --node-config ...` selects execution-only startup;
`--no-local-execution` selects a controller without local workspace/provider
services. Neither flag is required for the ordinary combined server. Disabling
local execution preserves its stable identity and existing chat bindings; those
bindings become unavailable until explicitly restored or handed off.

```text
Browser and user CLI
        |
        v
Controller: one Garcon data workspace
  chats.json, per-chat V5 databases, derived search
  auth, settings, preambles, schedules, chat execution and delegation
        |
        +-- local execution service
        +-- authenticated remote node
        |     project workspaces, files, Git, PTYs
        |     Codex/account-A, Codex/account-B, Claude/default
        +-- authenticated remote node
              project workspaces, files, Git, PTYs, provider instances
```

The controller can itself run on a user-owned always-on machine; it need not
be the browser's machine. A laptop controller sleeping is controller loss,
not browser disconnection. Ordinary browser disconnection does not stop work.

First-version boundaries:

- One controller authority per execution namespace; no controller mesh,
  elections, replicated chat registries, or multi-controller execution writers.
- Existing local defaults resolve placement without a new user selection.
  Remote placement is explicit once configured. No automatic placement
  optimization or failover to a different working copy.
- No filesystem synchronization, shared-worktree illusion, or native-session
  transfer between nodes. A ledger-seeded handoff is not native migration.
- No automatic command retry after ambiguous delivery, reconnect, or restart.
- Output replay is not command replay. Native Reload is manual and cannot
  guarantee recovery of output the provider never persisted.
- Matching node/controller wire versions; reject incompatibility explicitly.
  No compatibility layer for mixed protocol versions.
- Pairing a standalone Garcon server does not import its existing chats.
  Standalone-controller import is a separate product operation.

### Standalone is the default product

- The existing startup command and configuration start the complete local
  application. No new mandatory flags, pairing, certificates, manually supplied
  node files/workspace registrations, or provider-instance configuration is
  required. Internal local identities may be persisted automatically.
- Internal local-node/instance identities are resolved automatically and stay
  out of the normal UI. Local execution uses in-process service calls, not a
  loopback RPC connection, transport serialization, heartbeat lease, or extra
  process introduced solely to represent a node. Existing provider process
  lifetimes, native homes, credentials, and storage paths remain unchanged.
- With no configured remote nodes and the default local provider instances,
  preserve the existing provider/model picker, project selection, chat creation,
  composer, sidebar, file/Git/terminal flows, scheduling, and CLI defaults.
  Do not add node selectors, local-node badges, connection indicators, or setup
  prompts to those flows. Node management is an optional settings entry; users
  who never use it need not learn the distributed topology.
- Adding a remote node does not move existing chats, change their native
  bindings, or change default local execution. Reveal placement controls only
  where remote resources are configured; extra same-type instance controls
  likewise require explicit instance configuration. Visibility depends on
  configuration, not current connectivity: an offline configured node remains
  identifiable and never silently redirects a bound chat to local execution.
- Standalone parity is a release gate, not a later UX cleanup. Local-only
  startup and interaction must gain no remote discovery/handshake dependency
  or background connection retry work. Returning to an ordinary local-only
  setup hides unnecessary placement controls, while any surviving remote-bound
  chat still reports its unavailable origin rather than being rebound.

## Authority and lifetime

| State or operation | Owner | Lifetime |
| --- | --- | --- |
| Chat existence, configuration, current placement, parent relations | Controller `chats.json` | Durable |
| Ordered served transcript and native-session facts | Controller per-chat V5 ledger | Durable |
| Search index and preview metadata | Controller | Derived, rebuildable |
| Preamble definitions/selections and schedule definitions | Controller | Durable |
| Queue, command receipts, pending permissions, delegation waiters | Controller | Process-ephemeral |
| Handoff decisions and pending native deletion | Controller ownership journal | Durable exception |
| Project files, Git repositories/worktrees and filesystem validation | Owning node | Node filesystem |
| Provider-native history, including Direct JSONL/checkpoints | Owning provider instance on node | Durable |
| Provider execution, operation handles, permission callbacks, transport buffers, PTYs | Node | Supervised process lifetime |
| Remote ingress cursors, replay attempts, node operation receipts | Controller and node transport endpoints | Process-ephemeral; never reconstructed after restart |
| Native credentials/configuration | Configured provider instance | Node-owned unless explicitly delegated |

An execution-only node has no authoritative `chats.json`, V5 serving ledger,
search index, scheduler, or parent/child workflow engine. Node configuration
describes resources and pairing, not a second chat registry. The default
standalone composition uses those service boundaries locally without requiring
a separate execution-node daemon or loopback network hop.

## Current-source constraints

These are implementation anchors at the research commit, not merely proposed
interfaces. Recheck them before each implementation stage.

- `server/agents/integration-registry.ts` keys integrations by provider ID,
  rejects duplicates, and rolls back all started integrations when startup
  fails. Remote unavailability must not become controller startup failure.
- `server/agents/runtime-router.ts` resolves execution from `entry.agentId`,
  creates ledger-derived carried context only for start, and treats abort as
  best-effort. `server/chat-execution/execution-ownership.ts` remains the sole
  execution-ownership authority; the processing projection is separate.
- `server-agents/interface/src/contracts/{execution-v5,execution,services,producer}.ts`
  contain synchronous methods, opaque object handles, callbacks, and abort
  signals. They are in-process contracts, not wire DTOs.
- `server/ledger/garcon-command-publication.ts` dispatches extracted agent
  commands only after their source rows commit. The start/resume/schedule and
  reply controllers under `server/chats/` own the workflows centrally.
- `server/projects/project-directory-service.ts` and
  `integration-tests/tests/server/on-demand-project-resolution.test.ts`
  separate project availability from existing transcript reads.
- `server/chats/file-mentions.ts` and preamble project-scope services still
  resolve local paths. Files/Git/terminal APIs also assume one machine.
- `server/routes/files.ts`, `server/files/file-revision.ts`, and
  `server/git/{working-path-token,review-document-service}.ts` already carry
  revision/freshness checks. Keep those checks beside the actual mutation.
- `cli/discovery.ts` requires a secure local runtime descriptor and a loopback
  endpoint. That discovery cannot simply point at the remote controller.
- `server/terminals/terminal-manager.ts` isolates principals, deduplicates
  requests, and owns attachment/replay lifecycles. Relaying must preserve them.
- Direct persistence and its removed legacy-import path are verified in
  `server-agents/common/src/direct/`,
  `server/ledger/__tests__/adoption-architecture.test.js`, and
  `integration-tests/tests/server/direct-native-history.test.ts`.
- `server/ledger/{service,producer-lease}.ts` commit through a concrete captured
  sink. `server-agents/common/src/execution/producer-adapter.ts` currently hands
  that sink directly to provider execution; the remote emission adapter must
  separate those roles without weakening local synchronous publication.
- `common/chat-view.ts:applyTranscriptAppend` validates ordinal intervals;
  `web/src/lib/chat/transcript/transcript-reconnect-replay.ts` guards stale
  attempts and buffers live arrivals during replay. `server/ledger/view-reader.ts`
  reads to a fixed `throughOrdinal`. Reuse these sequencing principles, not the
  browser's transcript store or V5 ordinals as node transport identity.
- `ConversationPanel.svelte` hides the quick Git tray when disabled, unavailable,
  or processing; `ConversationPanelStatusDock.svelte` substitutes a running
  display. The execution-location control therefore needs a shared tray shell,
  not placement inside the Git-only component.
- `web/src/lib/chat/conversation/conversation-execution-draft-state.svelte.ts`
  stages a provider switch until Send. Both its comparison and
  `server/agents/agent-handoff-service.ts:resolveTarget` currently compare provider
  IDs only; location and configured instance must become part of that identity.
- `server/preambles/{matching,selection}.ts` distinguish creation-time automatic
  filters from saved ordered selections. `common/scheduled-prompts.ts` and
  `server/scheduled-prompts/dispatcher.ts` preserve default versus explicit
  preamble choices; neither may be flattened into an editor-time prompt.
- `common/settings.ts` already owns four generation settings. The existing
  `AgentSingleQuery` contract in `server-agents/interface/src/contracts/services.ts`
  explicitly does not guarantee tool-free execution.
- `server/config.ts` and `server/server.ts` currently have no TLS configuration.
  Bun's installed `bun-types@1.4.1` declares client WebSocket `tls.ca` and
  `rejectUnauthorized`; see the TLS section for runtime verification.
- Svelte 5.57.0's installed `src/internal/client/context.js:createContext` and
  `web/src/lib/context/index.ts` are the canonical typed-context references.
  Placement state belongs in feature domains, not rendering components.

## Identity and placement

Do not encode an instance or machine into the provider type. Keep `agentId`
as provider type for settings, normalization, and rendering. Add explicit
placement. Proposed shared contracts belong in `common/execution-location.ts`:

```ts
export interface ExecutionLocation {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly workspaceId: string;
}

export interface ExecutionOrigin extends ExecutionLocation {
  readonly projectPath: string;
  readonly ownershipEpoch: string;
}

export interface ExecutionInstanceRef {
  readonly nodeId: string;
  readonly instanceId: string;
}

export interface NodeIncarnation {
  readonly nodeId: string;
  readonly bootId: string;
}

export interface ProjectWorkspaceRef {
  readonly nodeId: string;
  readonly workspaceId: string;
}
```

Node and configured-instance IDs are persistent configuration identities.
Controller/node boot IDs and logical-session IDs are ephemeral fencing
identities. A physical socket ID fences callbacks on a replaced socket, but
does not identify the logical execution session. The existing
`agentOwnershipEpoch`, `runId`, and `transcriptViewId` keep their distinct
roles; none is replaced by a node ID. The current runtime descriptor's
`instanceId` identifies a server boot, not a configured provider instance.
Use explicit names at the new boundary to avoid conflating them.

`chats.json` stores one current `executionLocation` alongside the existing
provider type and configured project path. A node workspace maps a stable ID
to a canonical root and permitted access; the controller never resolves that
path using its own OS. Distinguish this project workspace from the controller's
Garcon data workspace containing `chats.json`.

Identical absolute paths or Git remotes on different nodes remain distinct.
Instance placement must be compatible with the selected workspace. Changing
node, instance, or working copy is an explicit ownership/placement operation,
not an ordinary model setting change or fallback.

Persist configured nodes, workspace registrations, and instance references in
controller-owned `execution-nodes.json`, separate from `chats.json`. Store only
enumeration-required current placement in each chat entry. Keep node pairing
credentials in a private configuration file, not in public node snapshots.
Node IDs and workspace IDs are never recycled. Removal retains a body-free
tombstone/label while chats or cleanup records still refer to the resource.
Reusing a label, hostname, or directory does not adopt those references.

An execution-only process serves one paired controller workspace namespace in
v1. Running another independently paired process requires isolated native
homes and resource ownership. A second controller must not take over a live
namespace, even if it presents the same human-readable node name.

Native session references remain provider-private blobs with their existing
provider `ownerId`. Qualify their enclosing facts and lookup keys by execution
instance; do not rewrite native owner IDs to pretend they are instance IDs.

Historical file links also require origin. Add immutable execution-origin
metadata to newly accepted provider rows and session facts. Capture it on the
concrete execution publisher, not at event arrival: late output may belong to
the old project path or instance. Current bindings stay in the registry;
growing historical provenance stays in the per-chat ledger, not an array in
`chats.json`. Legacy rows with no origin retain explicit legacy-local
interpretation, never inferred remote provenance. This is a provider-neutral
ledger/codec contract change requiring typed API and renderer coverage.

Origin is resource provenance, not another transcript identity. Preserve it
through frozen-prefix copies and qualify the current native source by its
instance. Native imports stamp newly imported current-binding rows with the
captured source location; preserved prefix rows retain their original origin.
Extend the existing `agent-switch` presentation with from/to locations so a
same-provider cross-machine handoff has a truthful durable boundary. Public
shares/exports keep their existing private-path/native-reference exclusions;
authenticated file-link resolution receives only the origin it needs. Adding
these fields must not change V5 ordinal assignment, replay, or view rotation.

## Execution-node service boundary

Introduce `server/execution-nodes/` for controller-side node directory,
availability, transport, and service clients; introduce `server/execution-node/`
for the node supervisor, instance host, and request dispatch. Provider code
remains behind `@garcon/server-agent-interface`; the existing default
composition module remains the sole core provider import point.

Separate type definitions/manifests from executable instance registration.
Multiple instances can share a provider type but require separately scoped
host storage, credentials, environment, and runtime objects. Audit direct
`process.env` and native-home use inside each provider. Where a provider cannot
be isolated within one process, host its configured instance in a supervised
child process with an explicit environment. Do not mutate process-wide
environment variables to switch accounts between calls.

Expose two service families, not remote chat CRUD:

| Family | Operations and owning behavior |
| --- | --- |
| Workspace | Resolve project/path, list/read/write files, bounded file-mention reads, Git snapshots/mutations, PTY create/attach/input/resize/terminate |
| Provider instance | Manifest/catalog, settings validation, endpoint validation, auth, command discovery, start/resume/abort, supported control facets, native lookup/import/release/fork, single-query work |

Capability manifests describe each configured instance. Nullable facets remain
explicit; a remote manifest must not claim a facet whose wire adapter has not
been implemented and tested. Cached metadata can describe an offline node,
but admission always checks current availability and validates on the node.

Synchronous provider settings methods remain local to the instance. Controller
admission becomes asynchronous before the durable input boundary: ask the node
to validate settings, endpoint, workspace, capability and capacity, then
revalidate the controller's view/ownership before committing and dispatching.
Never download executable provider validators into the browser or synthesize
validation by assuming that a settings descriptor captures every rule.

## Wire protocol and publication

Use an authenticated bidirectional WebSocket control channel, with typed,
strictly parsed envelopes and logical-session-qualified operation handles. Reuse
existing HTTP/WebSocket infrastructure; no generic object-proxy dependency is needed.
Nodes initiate connection to the configured controller. A reachable controller
URL is a deployment prerequisite; private networking, VPN, or a tunnel is
operator configuration, not automatic NAT traversal.

Connection establishment direction does not constrain RPC direction. The
controller sends admissions, file/Git requests, and terminal controls over the
node's established channel. Every additional bulk channel must also be initiated
by the node and authenticated to that same logical session. Never return a
node-local HTTP URL for the controller/browser to call. The browser maintains
one controller HTTP/WebSocket root and never connects directly to a node.

A cloud controller with laptop nodes is the natural deployment. A laptop
controller is also supported, but the operator must make its URL reachable
from its nodes. Dynamic IPs and roaming do not change paired identity. Automatic
NAT traversal, dual connection-direction modes, and reverse tunneling are not
part of v1.

Provide separate bounded bulk transfer for attachments, file contents, native
import batches, and large context seeds. PTY streams are separately bounded.
Bulk traffic must not starve control replies, cancellation, or heartbeats.
Reject oversized input before mutation; never silently truncate transcript
events. Chunk bulk data with bounded transfer IDs, declared length, content
hashes, cancellation, and cleanup on expiry. Bound the socket send queue as well
as the replay cache; closing a backpressured socket enters reconnect recovery.
Cache eviction drops whole records and discloses unavailable ranges. It is not
permission to trim message bodies or silently skip a terminal.

Proposed operation outcomes in `common/node-operation.ts`:

```ts
export type NodeOperationResult<T, Code extends string> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'rejected'; readonly code: Code; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: string };

export interface NodeOperationIdentity {
  readonly controllerBootId: string;
  readonly nodeBootId: string;
  readonly logicalSessionId: string;
  readonly operationId: string;
}
```

Each operation family adds its own closed error-code union and DTO parser.
These envelopes do not grant authority: authorization is the authenticated
connection plus the node's registered operation/capability table. IDs are
never accepted as permission to choose an arbitrary local path or session.

Admission sequence:

1. Controller obtains its normal chat execution admission and view/ownership
   identity. Node prepares an expiring, process-ephemeral execution ticket
   after validation and reserves capacity; it does not dispatch work.
2. Controller revalidates admission and preamble eligibility against the
   owner-validated project path, then durably commits the input and captures
   the immutable resend composition through the existing synchronous ledger
   path. No network I/O runs inside that transaction.
3. Resolve file mentions on the node from that captured composition, then
   prepend the receipt-covered preamble prefix and dispatch with the prepared
   ticket and output capability. This preserves today's post-commit mention
   resolution; a read failure does not roll back the accepted input. The ticket
   is consumed at most once during its node incarnation. Release it on
   cancellation or expiry. A transport blip suspends admissions; it does not
   create another ticket or authorize replay of the dispatch.
4. Definite rejection is reported normally. A lost reply is unknown, not a
   fresh start request. Inspect an existing in-memory receipt while the same
   logical session/operation remains valid; do not redispatch to discover its fate.
   A committed input without execution retains V5's accepted-loss semantics.

There is no distributed transaction or durable node command queue. Prepared
tickets and result caches are bounded and process-ephemeral; restart never
replays them. Reads may retry against an unchanged explicit target; mutations
may not be retried merely because their reply was lost.

### V5 stays behind controller ingress

Keep the core ledger's `AgentProducerSink.publish()` synchronous and durable.
Do not hand remote providers an object claiming that its return means the
controller committed. Introduce a separate provider-emission contract and
node transport adapter whose return means only validated local enqueue.
The local execution adapter can still deliver inline without buffering.

The node aggregates provider instances, translates provider-specific events
inside their existing packages, and emits normalized output. It has no V5 view,
ordinal allocator, serving database, resend fold, or transcript search engine.
The cache stores the serialized output of this translation, not a second copy
of `server/ledger`. Shared message codecs may be reused without adopting ledger
storage or its lifecycle.

At the receiving controller, deserialize normalized messages through the
shared message parser, reconstruct local permission-response capabilities,
and invoke the exact captured ledger sink synchronously. No ledger transaction
spans an await. Broadcast and terminal-driven lifecycle events stay in the
existing per-chat server-event queue.

Transport stream handles select only immutable captured sinks. A physical
socket replacement may resume the same logical stream; it never rebinds that
stream to a new sink. Reload, handoff, deletion, and process restart invalidate
the old binding. Content/session facts may outlive a run while their original
sink remains open, as V5 already permits; run controls remain exact-run-scoped.

No V5 retry or acceptance amendment is required for this cache. Only events
passed to the controller publisher enter V5. A node-local enqueue is not
acceptance, and a transport ACK is not a transcript row or provider durability
claim. A V5 commit failure or uncertain commit still fences according to the
existing contract. Closed/invalid publications remain rejected; the transport
must not retry them or fail a successor's run because an old sink was closed.

### Optional, bounded output replay

Initial remote-node defaults are `enabled: true`, `maxAgeMs: 300_000`, and
`maxBytes: 20 * 1024 * 1024`. Enforce age and bytes, whichever evicts first,
across the whole paired node namespace, not 20 MiB per chat. ACKed records may
be removed immediately. Retention uses the node's monotonic clock, not host
wall-clock comparisons. Expose these settings only in node configuration.

Use an in-memory deque of immutable serialized envelopes for the first
implementation. This avoids a storage dependency and a pruning database. A
temporary-file backend is allowed only if needed later; it must retain the same
lossy contract, private permissions, byte cap, and process fencing. Surviving
files never authorize cross-process replay, and startup removes only its own
stale spool artifacts. No spool is a backup or a native resume source.

Setting `enabled: false` disables retained output, not transport sequencing.
If a reconnect requires an event that was not retained, use the ordinary gap
failure below. Standalone local execution never constructs this cache or a
transport cursor, irrespective of the remote default.

Proposed transport types in
`server-agents/interface/src/contracts/node-wire.ts`:

```ts
export interface ProducerStreamIdentity {
  readonly controllerBootId: string;
  readonly nodeBootId: string;
  readonly logicalSessionId: string;
  readonly streamId: string;
}

export interface NodeOutputFrame {
  readonly type: 'node-output';
  readonly stream: ProducerStreamIdentity;
  readonly sequence: number;
  readonly event: WireProducerEvent;
}

export interface NodeOutputAck {
  readonly type: 'node-output-ack';
  readonly stream: ProducerStreamIdentity;
  readonly throughSequence: number;
}

export type NodeReplayReply =
  | { readonly type: 'node-replay-ready'; readonly stream: ProducerStreamIdentity;
      readonly afterSequence: number; readonly throughSequence: number }
  | { readonly type: 'node-replay-gap'; readonly stream: ProducerStreamIdentity;
      readonly requestedAfter: number; readonly firstRetainedSequence: number;
      readonly lastProducedSequence: number };
```

`WireProducerEvent` is an explicit wire union corresponding to every
`AgentProducerEvent` arm. Serialize row messages through shared message codecs;
preserve opaque `providerMeta` and typed session facts. Replace a permission
response closure with a logical-session-qualified capability handle whose
occurrence UUID must match the event. The controller reconstructs a local
capability that invokes that exact node occurrence. No function, native object
handle, provider-native request ID, or `AbortSignal` crosses JSON. Strict parsers
validate both directions, including safe integer sequences and exact identities.

Its permission and row adaptations are explicit, while existing normalized
session/notice/terminal types remain reusable:

```ts
export type WireProducerEvent =
  | {
      readonly type: 'rows';
      readonly rows: readonly {
        readonly message: JsonObject;
        readonly providerMeta: JsonObject | null;
      }[];
    }
  | Extract<AgentProducerEvent, { type: 'session' | 'notice' | 'run-ended' }>
  | {
      readonly type: 'permission';
      readonly runId: string;
      readonly lifecycle: Omit<
        Extract<AgentProviderPermissionLifecycle, { kind: 'requested' }>,
        'requestedTool'
      > & { readonly requestedTool: JsonObject };
      readonly decisionHandle: string;
    }
  | {
      readonly type: 'permission';
      readonly runId: string;
      readonly lifecycle: Exclude<AgentProviderPermissionLifecycle, { kind: 'requested' }>;
      readonly decisionHandle?: never;
    };
```

The `requestedTool` inside a requested lifecycle also crosses the shared message
codec as JSON, not an object reference. The wire encoder/decoder must explicitly
serialize/reconstruct that nested tool message as well as ordinary row messages;
test both paths. `decisionHandle` selects only a capability already registered
under the authenticated session and exact occurrence, not an arbitrary callback.

Each stream closes over one producer binding and may span successive runs on
that still-open binding. Sequence every finalized rows/session/permission/notice/
run-ended event in observed order before transmission. Serialize once before
retention so later provider object mutation cannot change a replay. Ephemeral
token deltas and progress indicators use replaceable snapshots, not durable-row
claims; reconnect discards their stale overlay and refreshes current progress.

The controller retains only its in-memory contiguous accepted sequence per
stream. It discards duplicates before publication or extracted agent-command
dispatch, requires the next contiguous sequence, publishes synchronously, then
advances the cursor and ACKs without an intervening await. A successfully
handled zero-row event also advances the transport cursor. On publication
failure, retire that stream and apply the existing per-chat failure/fence; do
not replay an event whose append outcome is unknown.

For example, event 42 may commit V5 ordinals 180–182. If the ACK is lost, replay
of 42 receives another ACK but no second publication. Core-originated rows can
interleave and other events can produce zero rows, so ordinal 182 is not a
transport acknowledgement. Cursor and stream bindings disappear on controller
restart; old frames must then be rejected, never compared with the ledger tail.

### Reconnect ordering and cache gaps

On a recoverable reconnect, freeze new admissions and queue drains while the
node captures a `throughSequence` for each stream. Replay after the controller's
cursor through that fixed watermark, in order, before exposing newer live
arrivals. Buffer newer output within the same bounded cache, or finish the
stream's replay before sending its live suffix. Stale recovery-attempt and
physical-socket callbacks cannot complete a newer attempt. A gap during replay
is as explicit as a gap at its start; retention is not pinned indefinitely.

Reconcile exact operation receipts, pending permission occurrences, cancellation
results, and current processing snapshots before restoring actionable controls.
Permission history may replay, but only a still-live matching node capability
can answer it. Do not start a queued successor merely because an old terminal
was received while replay or operation reconciliation is still in progress.
After successful recovery, release this temporary admission gate without
overriding a user's existing queue pause.

An unavailable required range is a per-stream failure, not a request to guess
missing output. Stop the affected active turn, suppress its queue drain, retire
the stream, and append an ordinary core-originated failure/notice through the
existing ledger APIs. Request abort on the exact node operation. Retain all
already-committed history and report `NODE_REPLAY_GAP`; no partial replay into
a replacement sink and no automatic Reload. If the stream was already idle,
record the incomplete-history notice without inventing a running turn. Other
chats and streams remain usable. Retention may therefore be lossy without
creating silent success or an unbounded recovery obligation.

Native Reload becomes available once the owning node is reachable, the chat is
idle with no execution reservation held elsewhere, its future-turn queue is
empty, and its current binding has a source plus `nativeHistoryImport`. Failed
imports keep the current view unchanged. Reload may omit Garcon-only notices,
permission history, and provider-unreceived inputs; it is not a lossless backup
restore. Missing native history prevents resuming that native session, but the
controller ledger may still seed an explicit fresh-session handoff.

### Callback and handle adaptation

- Abort handles select exact node operations, not current native sessions.
- A permission handle addresses one exact live occurrence and expires with
  its run/logical session. A lost decision reply is unknown; duplicate effect is
  prevented by the node occurrence's in-memory response state, not by replay
  into a new occurrence.
- Steering captures one target on the node. Validation/preparation happens
  before controller input commit; delivery checks that same target again.
  A changed target is definitive non-delivery, not permission to steer a newer
  turn. Preserve existing `not-sent` versus `unknown` results.
- Goal handoff and project/session configuration callbacks become explicit
  prepare/commit/cancel operations with exact target identity. Controller
  validation/ledger work and provider mutation remain separate steps with
  typed partial/unknown outcomes, not serializable closures.
- Native imports are cancellable bounded streams. Fork disposal and release
  target exact instance-qualified artifacts. Never use a returned node-native
  path as a controller filesystem path.

## Controller-required lifetime and reconnect

Use challenge/response liveness tied to the authenticated controller boot and
logical session. Engineering defaults: challenge every 5 seconds, lease deadline
15 seconds after the last valid renewal. Renew only for a valid outstanding
challenge received before expiry. A TCP/WebSocket open event does not renew a
lease. Check expiry before every admission/control request and replay resume;
delayed heartbeats cannot resurrect an expired logical session. Make the clock
and supervisor injectable for deterministic tests.

Measure elapsed time locally, never by subtracting a remote wall clock. The
clock adapter must detect host suspension: use suspend-inclusive monotonic time
where available, or conservatively expire on a local wall-clock/monotonic
discontinuity. A resumed laptop must validate the old lease before processing
buffered callbacks. Clock uncertainty may stop work; it never extends authority.
The five-minute cache TTL is not a five-minute execution lease.

This lease applies only to remote node connections. Standalone local execution
shares the controller's process lifetime and keeps its existing shutdown path;
it does not create a synthetic connection or heartbeat dependency.

An ordinary socket close, reset, or brief partition enters `reconnecting`.
Preserve the logical session, captured sinks, exclusive execution ownership,
and current processing projection during the unexpired grace window. Block new
remote admissions, queue drains, and actionable permissions while connectivity
or replay is unresolved. Work already admitted may run during this bounded
window. Recover without a failure row if both processes, lease, streams, and
required cache ranges remain valid.

Explicit unpairing, authenticated controller shutdown/revocation, either process
restarting, lease expiry, or unrecoverable stream recovery is not a transport
blip. Invalidate the affected authority immediately; expiry does not wait for
cache retention. Node-wide revocation closes admissions, invalidates handles,
aborts active provider work, and terminates controller-owned provider process
groups and PTYs. A cache gap retires only its affected producer stream/turn,
not unrelated node work. The daemon may remain alive to establish a new session.

Supervision must cover the node process dying too, not only its WebSocket
handler. Use platform-appropriate process-group/job/service supervision and
verify cleanup before admitting a replacement incarnation. A provider that
cannot satisfy supervised lifetime must not advertise remote execution until
its cleanup is implemented. Detached external jobs and already-issued network
effects cannot be recalled reliably; no exactly-once tool-effects guarantee is
made. Strict containment requires OS isolation beyond transport fencing.

Once recovery fails or expires, a surviving controller retires the old captured
publication capabilities and records active runs as failed through ordinary
ledger/runtime paths. Schedule lifecycle fanout through the per-chat event
queue after committed content; never synchronously emit terminal-derived state
ahead of it. A failure reports lost execution control, not rolled-back tool
effects. Controller restart creates no synthetic terminal rows and restores no
queue, command receipts, permissions, waiters, ingress cursors, or old streams.

A reconnect after expiry establishes a new logical session, completes old-worker
cleanup, refreshes capabilities, and permits only fresh explicit work. Existing
native sessions may be resumed on their owning node by that fresh admission;
old runs are not resumed. A surviving controller retains its queued entries but
leaves an affected failed chat paused until explicit queue resumption. A brief,
successful recovery only removes its temporary gate. Claimed schedule
occurrences never replay in either case.

Stop remains a controller action during a partition: accept the user's ordinary
interrupt and its ledger row immediately, invalidate local permission actions,
and report that remote termination is unconfirmed. Retain only a process-local
intent for that exact operation. On successful recovery, inspect its receipt
and live identity before sending a previously unsent abort; never abort a
successor or resend arbitrary terminal input. The node's lease independently
bounds execution if the controller cannot reach it.

Node availability is a typed projection:

```ts
export type ExecutionNodeStatus =
  | 'online'
  | 'reconnecting'
  | 'recovering'
  | 'offline'
  | 'incompatible'
  | 'untrusted'
  | 'cleaning-up'
  | 'removed';
```

Each node snapshot includes its stable ID, label, status, last-seen time,
current boot identity when known, capabilities, and sanitized reason. A
`node-status-updated` event refreshes this root-owned directory. Per-chat
terminal consequences still use the per-chat lifecycle queue. Snapshot refresh
on browser reconnect repairs missed node-status events without native reads.

Do not add another public busy predicate. Node availability gates admission;
chat exclusivity continues to use `ownsExecution`, and UI running state uses
the existing processing projection. Update the execution API contract tests
for any change to those established questions.

## Workspace operations and reverse control

Extend `common/project-resolution.ts` with qualified project targets and
explicit node-unavailable/incompatible outcomes. Preserve list/history/search
availability without node I/O; initial legacy adoption and explicit native
operations may fail for their own chat without creating false-empty history.

Move path canonicalization, boundary checks, file revisions, Git freshness
tokens, native path description, and actual mutation to the owning node.
Node resource coordination uses canonical filesystem identity, so two
registered workspace aliases for one root cannot create independent mutation
locks. Controller cache qualification never replaces this node-local check.
Keep the existing no-follow/regular-file/bounded-read checks for file mentions.
Preamble bodies and selections stay controller-owned; eligibility uses the
qualified workspace and owner-validated path, never the controller OS's
`realpath` or path separator rules. Attachment transfer verifies declared size
and content identity before making a node-local temporary artifact available.

Qualify file/Git/terminal caches and snapshot IDs by workspace/node
incarnation. On lost mutation replies, refresh and reconcile the existing
revision/token before a new explicit mutation; no automatic write, Git commit,
push, PTY input, or shell-command replay. Preserve terminal principal,
client/attachment ownership, token expiry, output offsets, and truncation
disclosure. A node/controller restart is not a successful terminal reattach.

All agent-generated orchestration remains at the controller. Delegate children
inherit the parent workspace and permission policy; choosing another provider
selects an instance on that workspace's node by default. Explicit cross-node
delegation must name a provisioned destination workspace. Parentage does not
grant native-session reuse or imply an automatic cancellation cascade.
Capacity reservation rejects promptly when a waiting parent consumes the only
available slot; never hide a second waiting queue on the node. Apply capacity
accounting to auxiliary single-query work too.

Inter-agent message delivery and completion replies use existing controller
coordinator paths even when source and destination execute on different nodes.
There is no second scheduler or delegation coordinator on the execution node;
the schedule and generation placement rules below apply to agent-created work
as well as browser-created work.

Provide a node-local CLI bridge with an ephemeral, narrowly scoped descriptor
for the relevant controller namespace. It forwards allowed CLI control over
the authenticated node channel and preserves controller boot-qualified
controls. Do not copy the controller's `server-runtime.json` or global local
capability. Interactive terminal users and agent subprocesses receive distinct
scopes; neither implicitly acquires node pairing or credential administration.

This bridge listens only on local IPC/loopback and grants no public inbound node
service. It is not the controller's runtime descriptor and must not publish the
paired-node credential to agent subprocesses. Node-local CLI discovery forwards
allowed requests through that bridge; explicit cross-node control still resolves
at the controller and uses its normal ownership, permission, and capacity gates.

Node-local credentials for Git, SSH, `gh`, shells, provider CLIs, and native
login flows stay on that node/instance. OAuth or CLI authentication requiring
a node-local browser/loopback callback must advertise that limitation and
direct the operator to the node; do not invent callback forwarding. Cache
authentication status by instance, not provider type. Global API endpoint
configuration follows the Direct-provider policy below.

## User experience

### Standalone and placement visibility

The node directory exposes a configuration-derived `showNodeControls` projection.
It is not `onlineNodeCount > 1`. With no remote configuration, hide node controls
in New Chat, the composer, model settings, Files/Git headers, terminal launch,
schedules, preambles, API-provider tests, generation settings, and CLI defaults.
No mandatory Local/Default badge is added for the ordinary local instance.
Configured-but-offline nodes remain visible. A removed node still referenced by
a chat displays its unavailable origin even after the last active node is
removed; it must never look like a local chat.

Settings has one optional Execution nodes section. After pairing, its rows show
label, status, last seen, provider instances/auth/capacity, workspace roots, and
actions to inspect, rename, change approved scopes, or revoke. Removing a node
requires confirmation naming affected chats and pending native cleanup. It
disconnects access, not deletion of project files or automatic relocation.

### New Chat, composer tray, and model selector

New Chat adds a Node control before project selection. Initial defaults remain
the existing local execution unless the user explicitly changes placement.
Changing the node clears incompatible project/instance choices; a matching path
string on another machine is not enough to retain a project binding. The user
selects an existing permitted destination project, then an available instance
and model. Nothing provisions or clones a repository. A node without the
requested provider still serves files/Git/terminals but cannot execute that
provider; it is never filled in by a provider on another machine.

The location picker sits at the left of the tray above the composer, as requested.
Its shell is shared with Git and running status, rather than owned by
`GitQuickStatusTray.svelte`. Distributed-mode examples:

```text
Idle:       [buildbox v]  [project /work/app]  [main v]  3 changes  [Commit]
Running:    [buildbox v]  Working…                              [Stop]
Offline:    [buildbox · offline v]  Reconnect this node to continue
Pending:    [buildbox → gpu-node v]  Handoff on Send              [Cancel]

Composer:   [prompt / attachments]
            [Codex · work v]  [source / model / effort]          [Send]
```

These illustrate placement, not a replacement for the existing composer layout.
With no nodes configured, render the existing tray/composer exactly as today.
The node control remains visible in distributed mode when Git is disabled,
the directory is not a repository, the node is offline, or the running-status
display replaces Git. A narrow screen uses a compact node button/popover; do
not introduce a second mandatory row or remount the composer on chat switches.

Keep location separate from model selection. Within the selected node, the
existing selector still chooses Agent → Source → Model → Effort. Multiple
instances of one provider appear as named agent entries, for example
`Codex · work` and `Codex · personal`, with independent auth and catalogs. A
single ordinary instance retains its existing provider label. No duplicate
provider types or node names are encoded into model IDs. Recents and model
catalog caches are qualified by node, instance, endpoint, and catalog revision.

An offline node retains its selected labels and cached catalog as stale/read-only
information. The user may inspect it or stage a handoff to an online node; they
cannot submit against stale capability claims. A selected model disappearing
from a refreshed catalog surfaces an invalid selection and requires correction,
not silent substitution. Permission modes, steering, goals, images, native
Reload/fork, and commands use the selected instance's advertised nullable facets.

### Changing machines is a handoff

Selecting a different node/instance for an established chat stages an execution
draft just like today's provider picker. Confirm the destination workspace,
instance, model/source, and permission policy. The pending state explicitly says
that Send starts a fresh native session using carried conversation, and copies
neither files nor native state. Cancel restores the durable binding.

The tray flow extends the existing in-place ownership handoff: keep the Garcon
chat ID and ledger, append the durable boundary, advance the content-start
binding, and start a new native session at the destination. The existing
`/handoff` flow remains a new-chat continuation and may select a destination.
Both use the same carryover planner; short context can be carried directly,
while long context uses the configured opt-in compaction behavior. Do not
introduce a separate native-migration, clone-chat-to-machine, or resume-by-path
feature. Native-fidelity forks remain on the owning node/instance; a cross-node
fork uses the existing explicit handoff-fork semantics.

Compare `(agentId, nodeId, instanceId, workspaceId)` for ownership changes.
Different instances/nodes of the same provider are valid handoff targets. A
model-only change on the same owner retains its existing rules. Revalidate the
expected ownership epoch, view, destination capabilities, project, permissions,
and settings before making the durable decision. Require idle execution and
an empty future-turn queue; never silently clear or move queued inputs.

Preserve the current ownership-journal ordering: after acquiring idle/empty-queue
admission, close the source sink, capture its ledger watermark/context, verify the
checkpoint, plan carryover, then persist the decision and roll forward. Transport
stream retirement accompanies sink closure. A
pre-decision failure leaves the original binding; a post-decision failure keeps
the committed destination and reports its unavailable execution rather than
pretending to roll back. Recovery must not contact the old node to reconstruct
controller-owned conversation. The destination must be provisioned and its
admission validated; loss after that validation remains an explicit failure.

Files/Git follow the durable chat location until handoff commits, not the draft
selection. Retarget them only after the returned committed chat projection.
Dirty editors and existing terminals retain their captured targets. A handoff
from an offline source is allowed only after its old execution authority is
retired and the normal idle/queue gates pass; disclose that it carries only
controller-saved history. Missing native files do not prohibit this fresh
ledger-seeded session, but can make an attempted native resume/Reload impossible.

### Offline and failure presentation

Keep history, search, list previews, exports, existing shares, titles/tags, and
other controller-owned metadata available independently of node connectivity.
Preserve drafts and attachments on failed admission. Never display an empty
transcript because a node or its native history is unavailable.

| Condition | User-facing state | Allowed next action |
| --- | --- | --- |
| Brief output disconnect | `Reconnecting to buildbox… Current turn may still be running.` | Read history, edit draft, Stop; no new remote dispatch/permission decision |
| Connected but replay incomplete | `Recovering output from buildbox…` | Same gates until replay and live controls are reconciled |
| Idle chat's node offline | `buildbox is offline. Your saved chat history is available. Reconnect the node to continue.` | Retry connection status, inspect node settings, or stage ordinary handoff |
| Lease/recovery failure | `Connection to buildbox was lost. This turn stopped; remote actions may already have occurred.` | Reconnect; review output; explicitly resume queue or submit fresh work |
| Pruned required output | `Some output from buildbox could not be recovered. This turn stopped. Reload from native history when the node is available.` | Manual Reload when eligible; otherwise fresh handoff using saved context |
| Native source missing/unreadable | `Native history is unavailable on buildbox. Saved Garcon history is unchanged.` | Repair node-native storage or choose a fresh-session handoff |
| Trust/version failure, when the reason is known | `buildbox cannot connect: certificate trust failed` or `Garcon versions do not match` | Repair trust or upgrade to matching wire versions; otherwise show Offline/last seen, never accept unauthenticated diagnostics |
| Removed node | `This chat's execution node was removed.` | Restore explicit pairing/identity or use handoff; never implicit local resume |

Use structured node error codes (`NODE_UNAVAILABLE`, `NODE_REPLAY_GAP`,
`NODE_SESSION_EXPIRED`, `NODE_INCOMPATIBLE`, `NODE_TLS_UNTRUSTED`,
`NODE_REMOVED`) and ordinary `ApiError` adaptation. Certificate diagnostics add
typed expiry/hostname reasons. Live availability is not a new chat-busy boolean.
Use `ownsExecution` for exclusivity, the processing projection for running
presentation, and target availability for admission; do not create another busy
predicate by combining internal fields. Click, Enter, shortcuts,
steer, queued submission, and CLI all obey the same admission policy.

Stop feedback distinguishes the controller-accepted interrupt from confirmed
remote process termination. Disabled permission controls explain reconnecting
or expired authority. Historical permission rows remain visible but inert.
Show the Reload action for known supported native bindings even while offline,
disabled with its prerequisite; do not invent it for a chat with no known source.

### Files, Git, terminals, and secondary surfaces

Retain the current selected-chat-following Files/Git target. Add a compact node
label to project headers when distributed controls are enabled; no independent
pinning redesign. Every file/Git API target, cache key, freshness token, root
resolution, and async result fence includes node/workspace identity. Two machines
with `/work/app` are different targets. Node-local canonical filesystem identity
still detects two aliases of the same repository for locking.

An open file's node/root/path and revision remain captured for its lifetime.
Switching chat/node does not redirect Save. Offline editors retain loaded content
and dirty drafts, show unavailable/stale status, and disable remote saves; no
offline write queue. After reconnect, revalidate the revision and use the existing
conflict flow. A lost save reply is unknown until the owning node's revision is
read; it is not an automatic retry. File tree emptiness must not represent an
unavailable node.

Git reads/mutations run on the repository node with its Git/SSH/`gh` credentials.
Cache snapshots are visibly stale while offline; staging, commit, branch/worktree
changes, pull/push, and PR mutations require fresh owner-qualified tokens. A lost
mutation reply prompts refresh/reconciliation, not repeating the mutation. Commit
text generation may run elsewhere, but the captured diff and the actual Git
operation remain anchored to the repository and its freshness checks.

New terminals default to the selected chat's node/project; expose placement only
in distributed mode. Existing terminals never retarget on chat switch. Retain
their principal/attachment ownership and terminal-specific output replay offsets.
No keystroke or PTY-input replay. A brief valid reconnect may reattach the same
PTY; expiry or process restart ends it with an explicit disconnected/ended state.
No shell/file/Git action silently runs on the controller as a fallback.

File mentions are read and bounded on the destination node; browser-uploaded
attachments are controller-owned until admitted transfer creates a node-local
temporary artifact. Validate size/hash before making it available and clean it
up on cancellation/expiry. Historical file/tool links resolve their captured
execution origin, not the current chat location. URI/open-local actions that
cannot address a remote resource show that limitation rather than opening the
same path on the user's or controller's machine.

Sidebar project groups, recents, terminal names, node diagnostics, Chat Map,
boards/canvas, and split-chat surfaces use stable qualified identities. Existing
chat IDs and parent/child links stay controller-global; placement does not create
new chat roots or separate browser sessions. Show location only where needed to
distinguish targets. Qualify async callbacks by target and socket attempt; prune
node-derived catalogs/caches on removal, dispose terminal/file subscriptions,
and retain dirty editor drafts or referenced unavailable targets deliberately.
Chat canvas/board documents and workspace layout remain controller-owned.

## Preambles and schedules

### Preamble scopes and destination evaluation

Extend `common/preambles.ts` without changing the existing distinction between
scope eligibility and creation-time automatic agent/tag filters:

```ts
export type PreambleScope =
  | { readonly type: 'global' }
  | { readonly type: 'nodes'; readonly nodeIds: readonly string[] }
  | {
      readonly type: 'project-paths';
      readonly rules: readonly {
        readonly nodeId: string;
        readonly projectPath: string;
        readonly includeNested: boolean;
      }[];
    };
```

Labels are Everywhere, Selected nodes, and Selected projects. A node scope
matches every project on a selected node; a project rule includes its node and
retains current exact/nested semantics. Existing project rules migrate to the
persistent local node; global rules remain global. Hidden node controls in
standalone mode imply the local node, not an all-machines path rule.

Catalog bodies, enabled state, ordered definitions, permanent ID tombstones,
and saved chat selections stay on the controller. Resolve real paths, symlinks,
case/path semantics, and project boundary checks on the owning node. Scope
matching consumes that node-validated result, never the controller OS's
`path.relative` on a foreign path. Remote scope validation transmits only the
paths needed for matching, not the complete preamble catalog or its bodies.

Creation-time defaults choose IDs against the destination node/project, provider
type, and tags. Existing chats retain their explicit ordered IDs; handoff
preserves the selection and re-evaluates its eligibility at the destination.
Missing, disabled, or out-of-scope IDs remain selected and are skipped. A newly
eligible node-wide definition is not silently appended to an existing explicit
selection. Destination preview shows what will apply and lets the user adjust
the saved selection through the normal controls before Send. Agent/tag automatic
filters continue to affect creation defaults only, not later saved-ID eligibility.

At the first ordinary input after a handoff/new-chat/selection boundary, the
controller resolves the latest catalog and saved order against the validated
destination. It expands `{{chat_id}}`, validates the combined budget, commits
the same adjacent notice/input row group and private receipt, resolves file
mentions on the destination, then sends one opaque receipt-covered prompt.
The node does not independently inject, select, or reapply preambles. Their
bodies never enter V5; native history may retain the actual dispatched prompt.
Native Reload sanitation still runs on normalized imports with controller-held
receipts. No provider-specific preamble logic is added.

Preamble editors preserve dirty drafts on node/catalog invalidation. Offline
scope validation is explicitly unavailable, never reported as an empty eligible
set. Controller-owned definitions and selection IDs remain readable; changes
requiring a new canonical project rule wait for that node's validation. A
body/order edit does not remotely mutate an active provider turn. Admission
always revalidates, so an editor preview is not a frozen future prompt.

### The controller is the only scheduler

Persist and claim occurrences on the controller using the current scheduler and
run log. Execution nodes receive admitted operations, never schedule definitions,
cron jobs, offline queues, or permission to dispatch later without the controller.

New-chat schedule targets add `executionLocation` and a destination node/project/
instance picker. Validate that destination on save and again at occurrence
admission; do not use the controller filesystem. Existing-chat schedules keep
their current `chatId` target and show `Uses this chat's execution node` with its
current label. They follow a later committed chat handoff and never trigger an
automatic handoff themselves. Hide these controls/labels in standalone mode.

Preserve `preambleChoice: defaults | explicit`. Defaults resolve at actual chat
creation using the current catalog and destination; explicit IDs retain their
chosen order, including empty, and resolve current enablement/scope at admission.
The schedule editor says `Preview using current settings`; it does not persist
rendered bodies, generated prefixes, or today's automatic IDs as future truth.
An existing-chat schedule uses that chat's saved selection and pending boundary.

Busy behavior remains queue/skip for a reachable execution target. A node being
offline/recovering is not chat busy-ness: the claimed occurrence records a
node-unavailable failure and does not enter an offline queue. Claim-before-
dispatch remains the deduplication boundary; a failed/unknown occurrence is not
replayed on reconnect or controller restart. Later recurring occurrences run
normally. The schedule editor, removal, and run log remain controller-available;
a save requiring destination validation reports node unavailability explicitly.
Agent-created schedules use
these same contracts and retain existing request/message identity rules.

## Auxiliary generation and Direct providers

### Generation placement

Extend the existing four settings in `common/settings.ts` with a node/instance
selection, displayed only in distributed/multiple-instance mode. Missing placement
means the controller's ordinary local execution instance; never infer the active
chat's node. Preserve each setting's existing model/source/effort and enabled/
opt-in defaults. A controller started without local execution must select a
usable generation target; otherwise that operation reports unavailable without
blocking unrelated history or controller startup.

| Operation | Input owner | Generation location | Effect location |
| --- | --- | --- | --- |
| Chat title | Controller transcript snapshot | Controller by default; independently configurable | Controller metadata |
| Handoff/carryover summary | Controller captured conversation | Controller by default; independently configurable | Controller carryover and explicit destination start |
| Commit message | Repository node's captured diff | Controller by default; independently configurable | Git commit stays on repository node |
| Prompt refinement | Submitted draft | Controller by default; independently configurable | Returned draft; no execution dispatch |
| Native `/compact` | Existing provider-native session | Always current session's node/instance | Same native session |

Capture the text/diff and relevant revision before generation; never ask a model
on another machine to discover the source project by path. Revalidate the Git
snapshot before committing, and use the existing handoff watermark/ownership
guards before changing binding. Count one-shot generation against node capacity
and propagate timeout/cancellation. No automatic fallback to another node,
instance, endpoint, or model. A title-generation failure preserves the title;
refinement preserves the draft; commit-message failure mutates no Git state;
pre-decision summary failure leaves ownership unchanged.

Cross-location generation requires an explicit tool-free contract. Introduce
`textGeneration: AgentTextGeneration | null` as a new nullable integration facet,
not an optional method or inference from the current
`singleQuery.runsToolsWithoutPermission` flag:

```ts
export interface AgentTextGeneration {
  run(request: {
    readonly prompt: string;
    readonly model: string;
    readonly thinkingMode: ThinkingMode;
    readonly settings: AgentSettingsEnvelope;
    readonly endpoint: AgentEndpointSelection | null;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<string>;
}
```

The facet guarantees that supplied text cannot invoke tools or mutate a project.
Any required scratch working directory is created on the executing node and
cleaned up there; scratch isolation alone is not a tool-free guarantee. Each
provider implements and tests actual protocol-level tool denial before advertising
the facet, or declares null. Direct one-shots can expose the facet through their
text-only API path. A cross-location selection without it is unavailable with
an actionable explanation. Existing standalone generation keeps its current
single-query behavior and permission safeguards; extraction must not silently
disable previously available local settings. Do not weaken permission modes to
make a remote generation choice appear supported.

### Shared configuration, local native state

The controller remains the source for API-provider definitions, endpoint/model
catalog configuration, shared provider settings, and their managed credentials.
Nodes advertise compatible provider types/protocols, then receive a versioned
snapshot of only the selected endpoint/settings and necessary credentials for
an admitted operation or explicit endpoint test/discovery. Do not replicate the
whole credential store, workspace registry, preamble catalog, or unrelated agent
profiles. Keep the admitted configuration immutable for that operation; a later
settings change affects later admissions. Reconnect refreshes revisions, not a
command queue. Discard delegated in-memory credentials at operation/session
retirement where the provider allows; native tools may retain supplied secrets,
so paired nodes remain trusted execution hosts rather than a security sandbox.

The Direct integrations execute on any compatible selected node. Their native
JSONL, upstream Responses checkpoints, process caches, and resume source live
on that executing instance, exactly like other native histories. The controller
keeps the authoritative served V5 rows, not a portable Direct resume replica.
Cross-node Direct handoff starts fresh from controller-carried conversation; it
does not transfer JSONL, response checkpoints, or native paths.

API-provider settings add `Test from node` and destination-qualified model
discovery when nodes are configured. `localhost` and private endpoints resolve
from the executing/test node, not the browser or controller. Show test outcome
with the selected node and configuration revision; one successful controller
test does not certify other nodes. Reuse shared endpoint definitions, but do
not turn a node's discovery result into proof of universal reachability.
Provider-native logins/auth homes remain instance-local and separately surfaced.

## TLS, self-signed certificates, and pairing

A public CA-signed certificate is not required. Support both normal system-CA
validation and explicit trust of a self-signed certificate or private CA. Trust
is scoped to the configured controller connection, not installed globally into
the OS, Bun process, browser, or every provider endpoint.

Use Bun's existing TLS and WebSocket APIs; no RPC framework, WebSocket library,
or certificate-generation dependency is required. Add opt-in `--tls-cert` and
`--tls-key` PEM-file flags to `server/config.ts` and pass them to `Bun.serve` in
`server/server.ts`. Require both together, validate/read before listening, and
fail explicitly on invalid material. Existing startup without TLS flags remains
unchanged. Existing reverse-proxy TLS termination is also supported: its public
certificate/trust root, not an unrelated backend certificate, is what the node
must trust. Trust forwarded security metadata only from explicitly configured
proxies; an arbitrary forwarded header must not authorize plaintext enrollment.

Provide an operator recipe for creating a self-signed certificate with OpenSSL,
then pair by copying a trust bundle. OpenSSL is a setup tool, not a mandatory
server runtime dependency. The following commands run only in a newly created
private certificate directory; the hostnames/IPs are examples and must match
the actual controller URL and local CLI address:

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout controller.key -out controller.pem \
  -subj '/CN=garcon.example.test' \
  -addext 'subjectAltName=DNS:garcon.example.test,IP:127.0.0.1' \
  -addext 'basicConstraints=critical,CA:FALSE'
chmod 600 controller.key
```

Then start from the Garcon repository, using those absolute certificate paths:

```sh
bun run start --bind-address 0.0.0.0 --port 8443 \
  --tls-cert /path/to/private-certs/controller.pem \
  --tls-key /path/to/private-certs/controller.key
```

An existing self-signed PEM is equally valid. Keep the private key on the
controller/reverse proxy; the node receives only the public certificate or CA
bundle. Retain TLS chain, validity-period, and hostname/SAN validation. An IP
URL needs an IP SAN. A correct fingerprint is not an excuse to ignore expiry
or hostname mismatch. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`,
`rejectUnauthorized: false`, an accept-all identity callback, or silent HTTP
downgrade as the self-signed implementation.

Proposed node trust contract in `common/execution-node-config.ts`:

```ts
export type ControllerTlsTrust =
  | { readonly kind: 'system-ca' }
  | {
      readonly kind: 'trusted-pem';
      readonly certificatesPem: readonly string[];
      readonly certificateSha256: readonly string[];
    };
```

Compute fingerprints over each certificate's DER bytes with
`node:crypto.X509Certificate`, not over whitespace-sensitive PEM text. Parse and
compare the copied bundle before retaining it; certificate material has strict
size/count limits. The configured PEM replaces the system roots for that node
connection. A self-signed leaf is its own trust anchor; a private CA anchors
its issued leaf certificates. In system-CA mode, routine valid leaf renewal
uses ordinary hostname/chain validation. In trusted-PEM mode, changing the trust
anchor requires explicit operator approval; never auto-repin on reconnect.

The node-side connection uses only supported Bun options:

```ts
function connectController(
  controllerUrl: string,
  trust: ControllerTlsTrust,
  credential: string,
): WebSocket {
  const url = new URL(controllerUrl);
  if (url.protocol !== 'wss:') throw new Error('Node connections require WSS');
  const tls: Bun.TLSOptions = trust.kind === 'trusted-pem'
    ? { ca: [...trust.certificatesPem], rejectUnauthorized: true }
    : { rejectUnauthorized: true };
  return new WebSocket(url, {
    tls,
    headers: { Authorization: 'Garcon-Node ' + credential },
  });
}
```

Enrollment HTTP uses the same trust policy over HTTPS. Reject cross-origin
redirects instead of forwarding credentials. TLS verification must finish before
any enrollment token or paired-node credential is sent. Do not implement a
probe followed by an unrelated unverified authenticated connection. A browser's
WebSocket API cannot use Bun's custom trust options; this code runs only on
execution nodes. Browser access to a self-signed controller separately requires
the operator to trust its certificate in the browser/OS, or use a separately
trusted reverse-proxy endpoint. Node pairing does not bypass browser security.

Pairing UX and protocol:

1. Settings → Execution nodes → Add node shows the reachable controller URL,
   controller identity, selected trust mode, certificate fingerprint(s), and an
   expiring single-use enrollment bundle (10-minute default, 32 cryptographically
   random token bytes). Creating/exporting it requires normal
   controller administration; agent/terminal capabilities cannot enroll nodes.
2. The operator transfers the bundle through an already trusted channel, such
   as the authenticated controller UI or a local file copy. An unauthenticated
   remote certificate probe is not the trust source. The bundle contains the
   controller ID, URL, trust material, expiry, and a high-entropy one-use token;
   treat the whole bundle as a credential and do not put it in logs, command
   arguments, or a URL query string.
3. Proposed command
   `bun run cli nodes pair --bundle /private/enrollment.json --node-config /private/node.json`
   runs locally on the node without existing server discovery. It validates TLS,
   presents the token, and receives one node-scoped credential and stable node
   ID. Store the credential in a private node configuration file. The controller
   atomically consumes the token, stores a verifier rather than a plaintext
   reusable secret, and binds the node to this controller workspace namespace.
   If the enrollment reply is lost, revoke/reissue enrollment; do not broaden
   a one-use token into an indefinite credential-recovery protocol.
4. `bun run server --execution-node --node-config /private/node.json` starts
   the execution-only role. It initiates WSS, authenticates its node identity,
   negotiates the exact wire version and boot-qualified logical session, and
   advertises configured provider instances and allowed workspaces. This role
   does not initialize the chat registry, scheduler, search, SPA, or V5 ledger.
5. The controller shows the node label, connection status, instances, workspace
   roots, capacity, and the approved scopes. Node labels are editable; identities
   are not. No provider credential or project grant is inferred from a label.

Proposed routes are `POST /api/v1/execution-nodes/enroll` for the bounded token
exchange and `/ws/nodes` for authenticated node channels. Enrollment requires
its token even when ordinary local development auth is disabled. Management
routes use administrator auth and strict request parsing; node channels use a
separate principal and never accept the browser JWT as a node credential.
Rate-limit enrollment/auth failures, cap concurrent handshakes and frames, and
close unauthenticated connections before advertising capabilities.

Trust failure is not ordinary network retry: node CLI/status displays
`Certificate not trusted`,
`Certificate expired`, or `Certificate hostname mismatch` with the expected
controller URL and safe fingerprint information. Preserve configured bindings
and stop authenticated work until trust is explicitly repaired. Certificate
rotation uses an operator-supplied replacement bundle/CA under existing trusted
administration, or a fresh out-of-band pairing. Key loss or node-credential
revocation does not erase native files and never permits automatic re-enrollment.

TLS configuration must also update `server/lib/server-runtime.ts` URL scheme
and local CLI trust in `cli/{discovery,garcon-client}.ts`. A locally discovered
HTTPS controller may expose its public certificate path/fingerprint in the
protected runtime descriptor so the CLI can use scoped trust. Validate ownership
and descriptor paths as today; never copy this descriptor or its local
capability onto execution nodes. Do not force TLS or new trust configuration
on the unchanged standalone startup.

A node unable to authenticate cannot report a trusted diagnostic over that
failed channel. The controller shows Offline/last seen unless it already has
an authenticated diagnostic or knows its own certificate/configuration failure.
Do not accept unauthenticated error reports to manufacture more specific UI
state. Enabling remote enrollment requires configured administrator auth even
if the standalone server previously ran with auth disabled; report that setup
requirement rather than exposing node administration unauthenticated.

Verification performed for this design on Bun 1.4.2: a private, isolated
`Bun.serve` WSS listener accepted a self-signed, CA-false leaf via `tls.ca` with
`rejectUnauthorized: true`. No trust, a different trusted certificate, and a
hostname mismatch all failed before the authenticated HTTP upgrade reached the
server. Synthetic keys/certificates were removed after the probe. Preserve
these as deterministic integration tests, not an assumption based on types.

References: [Bun TLS server guide](https://bun.com/docs/guides/http/tls),
installed `bun-types@1.4.1/bun.d.ts` (`TLSOptions`, `WebSocketOptionsTLS`), and
the runtime probe above. Bun's WebSocket TLS type does not expose fetch's
`checkServerIdentity` callback; the proposal deliberately uses trusted PEMs
with normal verification instead of depending on that unsupported option.

## Security, persistence, and operations

Pair nodes explicitly using the TLS/trust flow above. Pin persistent node
identity; do not trust a changed hostname or URL as the same node. Bind each
execution namespace to one controller identity.
Reject a competing controller instead of replacing the active owner. Restrict
projects and provider instances per pairing. Do not expose unauthenticated
remote filesystem, Git, terminal, or provider-native endpoints.

An authorized execution node is trusted with supplied prompts, workspace
contents, and delegated credentials. Local V5 storage is not a confidentiality
claim: native transcripts may retain those prompts remotely. Avoid transcript
and secret bodies in transport logs. Log node/boot/connection/operation IDs,
typed outcomes, latency, queue bytes, liveness expiry, and cleanup failures.
Expose last connection, available capabilities, active capacity, and pending
native cleanup in controller diagnostics.

Project/instance grants constrain Garcon RPC routing; they are not an OS sandbox
around a shell or provider process. Preserve provider permission modes and use
OS isolation where a deployment requires stronger filesystem/process confinement.
Revoking a grant stops admissions and retires affected active capabilities/work;
it never substitutes another permitted root or instance. Report any unconfirmed
cleanup. Credential and replay-cache files, when present, use private permissions
and do not enter controller transcript backups as native recovery state.

Keep ownership-journal checkpoint ordering on the controller. Extend handoff
decisions and deletion references with immutable instance/workspace targets.
Remote cleanup must be idempotent and must not delay deletion of unrelated
chats or controller startup. Preserve tombstones until native cleanup is
acknowledged; an unavailable node must not resurrect a deleted chat. Pairing
revocation reports pending native cleanup rather than claiming disk erasure.

Controller backup covers the registry, ledgers using SQLite-safe backup,
settings, preambles, schedules, ownership journal, and other authoritative
controller artifacts. Search is rebuildable. Native resume also needs the
node's provider storage and configuration; worktree recovery needs node files.
A restored controller must establish a new boot/connection and supersede old
execution safely, not resume command receipts from backup.

Native drift checks cannot compare unsynchronized host wall clocks as a
correctness assumption. Keep the existing probe advisory and return unavailable
for remote timestamp comparisons that cannot meet V5's timestamp obligation.
Explicit native Reload remains available. No clock-offset heuristic should
gate resume or claim that two transcripts are synchronized.

## Implementation sequence and acceptance

Each stage is behavior-preserving locally before enabling its remote surface.
New filenames below are proposed; existing paths are the integration anchors.
Implement in the order below. Shared DTO changes always include parsers, sender,
receiver, and contract tests in the same change. Stages are internal rollout
gates, not a promise to expose a partially working distributed UI. Do not enable
remote execution to users until Files/Git/terminal targeting and failure UX work.

### Lock standalone parity first

Add `integration-tests/tests/server/standalone-defaults.test.ts` using the
ordinary startup path with no node configuration or role flags. Prove local
provider discovery and start/resume, files/Git/terminal access, CLI discovery,
and restart against existing native storage work without enrollment or an
execution-node daemon. Assert the local adapter establishes no remote transport
or heartbeat and that adding an offline remote node does not block local work
or change existing chat bindings. Keep existing lifecycle suites on this
default path rather than converting every fixture into a configured topology.

Add `integration-tests/tests/e2e/standalone-defaults.test.ts`: existing New Chat
and provider/project selection remain usable without new selections; composer,
sidebar, files/Git/terminal surfaces show no node picker, badge, or connection
prompt. Cover opt-in visibility after adding a node and retained identification
while that node is offline. These tests gate extraction and rollout before
remote-only tests can establish feature readiness.

Representative server assertion, using the proposed shared fixture:

```ts
test('standalone does not instantiate remote machinery', async () => {
  const fixture = await createStandaloneFixture();
  try {
    await fixture.startLocalChat();
    expect(fixture.remoteTransportFactoryCalls()).toBe(0);
    expect(fixture.replayCacheFactoryCalls()).toBe(0);
    expect(fixture.remoteHeartbeatCount()).toBe(0);
    expect(await fixture.nativeStorageLocation()).toBe(fixture.originalNativeHome);
  } finally {
    await fixture.dispose();
  }
});
```

Fixture counters are injected internal ports, not new production diagnostic APIs.
Validate this stage with the existing local lifecycle suites and the new server/
e2e standalone cases. Revert an extraction before enabling remote routing if it
changes local defaults, storage, render layout, or startup dependencies.

### Placement and instance identity

Add the shared location contracts above, node/instance configuration parsing,
and current placement to `server/chats/{store,registry-entry-codec}.ts`.
Split the provider-type registry from executable instances in
`server/agents/{integration-registry,integration-host,runtime-router}.ts`.
Use the same configured local instance through the new directory before
introducing remote transport.

```ts
export interface ConfiguredAgentInstance {
  readonly id: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly label: string;
  readonly storageNamespace: string;
}
```

Migrate old entries to a persistent local node and one configured local
instance per existing provider. Allocate project workspace records from stored
paths without requiring those directories to be available. Preserve chat IDs,
view IDs, native references, existing credentials/configuration, and physical
provider storage. Resolve these internal defaults without a migration wizard
or new required user configuration. New remote bindings must never default to
local execution when absent or unreadable.

Add `server/execution-nodes/__tests__/location-migration.test.js` and
`instance-directory.test.js`: deterministic default-local migration, missing
directories, duplicate provider types with distinct instances, duplicate
instance rejection, and native-session collision isolation.

Make migration restart-safe: persist the local node ID before referencing it,
deduplicate workspace registration by stored local target without requiring
filesystem availability, then atomically rewrite registry configuration. A
crash reruns the same mapping, not allocation of another local node. Multiple
new profiles receive isolated storage; the original default keeps its current
physical home. Existing preamble project rules gain the local node ID;
new-chat schedule targets and generation settings gain explicit/local defaults;
existing-chat schedule definitions remain chat-ID-only. Malformed remote
references fail visibly instead of invoking the local-default migration.

Add migration cases to `server/preambles/__tests__/store-v2.test.js`,
`server/scheduled-prompts/__tests__/store.test.js`, and settings-store tests.
No mixed-version wire compatibility layer is needed, but existing persisted
local workspaces must migrate correctly. Validate with focused migration/codec
tests, then `bun run check` and `bun run test` before service extraction proceeds.

### Service extraction and capability adaptation

Extract node-local workspace operations from routes and provider-instance
operations from the runtime router; preserve provider imports at the sole
composition point. Use explicit local/remote ports, not a fake remote
`AgentIntegration` whose synchronous methods secretly initiate I/O.

```ts
export interface NodeAvailability {
  readonly kind: ExecutionNodeStatus;
  readonly nodeId: string;
  readonly bootId: string | null;
}

export interface PreparedNodeExecution {
  readonly ticketId: string;
  readonly identity: NodeOperationIdentity;
  readonly location: ExecutionLocation;
  readonly runId: string;
}
```

Separate provider emission from V5 acceptance in
`server-agents/interface/src/contracts/{producer,execution-v5}.ts` and
`server-agents/common/src/execution/producer-adapter.ts`:

```ts
export interface AgentEmissionSink {
  emit(event: AgentProducerEvent): void;
}

export function localEmissionSink(sink: AgentProducerSink): AgentEmissionSink {
  return Object.freeze({ emit: (event: AgentProducerEvent) => sink.publish(event) });
}

export function remoteEmissionSink(
  output: Pick<NodeOutputStream, 'emit'>,
): AgentEmissionSink {
  return Object.freeze({ emit: (event: AgentProducerEvent) => output.emit(event) });
}
```

`NodeOutputStream` is the proposed node-owned serializer/cache/sender with an
immutable stream grant. Change provider execution contexts to carry the emission
port; preserve the distinct durable publisher type at controller ingress. The
local wrapper calls through inline; the remote wrapper promises only local
emission. Update the producer adapter's binding identity and session-emission
bookkeeping accordingly, retaining exact captured publishers and rejection
isolation. Every provider adapter and the conformance kit change together; do
not add a provider-ID branch in core or shim a socket into `publish()`.

Add `server/execution-node/__tests__/instance-isolation.test.js` and
`workspace-service.test.js`; extend existing file revision, Git mutation,
terminal manager, and provider conformance tests. Assert two same-provider
instances cannot share native homes or cross-route output. Cover every
advertised facet before enabling it remotely.

Extract workspace methods from the file/Git/terminal route families and their
domain services into node-local ports, retaining node-side validation and
canonical-resource locks. Implement local dispatch first, then wire adapters.
Catalog/settings/native facets are asynchronous controller clients over typed
DTOs; provider implementations remain local behind the interface. Nullable
manifests list each supported facet explicitly. Validate these adapters with
focused domain tests and SACS; withdraw a remote capability until its contracts
pass instead of emulating unsupported native behavior.

### Add TLS and explicit enrollment

Add `server/execution-nodes/{pairing-store,enrollment,trust}.ts`,
`server/execution-node/{config,controller-connection}.ts`,
`common/execution-node-config.ts`, and `cli/node-pairing.ts`. Extend
`server/{config,main,server}.ts`, `server/lib/server-runtime.ts`,
`cli/{args,main,discovery,garcon-client}.ts`, and `server/routes/index.ts`.
Keep execution-only role startup separate from the controller composition root;
it imports the same provider factory through the sole allowed import point but
does not create controller stores. `bun run server --execution-node` does not
build/serve the SPA or initialize transcript search Workers.

Implement the trust union and verified Bun TLS calls in the TLS section, strict
enrollment parsing, one-use token consumption, node-scoped credential checks,
and protected configuration writes. Pairing must resolve before capabilities or
workspaces become admissible; trust/auth failure cannot fall through into a
development no-auth handler. Wire format version is checked before registering
a logical session. Browser-management payloads never contain node credentials.

Extend the WebSocket connection-data union and router with a separate node
principal/channel. Node sockets never join the browser client broadcast registry;
they receive only their admitted work, not all chat history/settings events.
Browser cookies/JWTs cannot authorize `/ws/nodes`, and a node credential cannot
call administrator management routes. Test filter + router + handler together,
not only the credential validator.

Add `server/execution-nodes/__tests__/{pairing-store,trust,enrollment}.test.js`
and `cli/__tests__/node-pairing.test.ts`. Add
`integration-tests/tests/server/distributed-tls.test.ts` with generated synthetic
certificates: self-signed leaf success, private-CA success, system-CA mode through
an injected test trust store, wrong root, SAN mismatch, expiry, malformed PEM,
changed trust anchor, and explicit rotation. Assert a failed TLS handshake
receives no authenticated upgrade or enrollment request. Test token expiry,
concurrent double consumption, lost enrollment response, revoked credentials,
auth-disabled setup refusal, wrong namespace, and unsupported wire version.

Use isolated temporary certificate directories and a new `0.0.0.0` listener on
an ephemeral port. Close only that fixture's listener/process. Add CLI HTTPS
discovery coverage while retaining the existing default HTTP cases. Validate
the focused tests plus routine check/test gates before enabling remote transport.

### Transport, supervision, and ledger ingress

Implement strict wire parsers, enrollment, liveness, prepared tickets, bounded
streams and mutation outcomes in
`server/execution-node/{output-stream,replay-cache,supervisor,operation-table}.ts`
and `server/execution-nodes/{publication-ingress,reconnect,operation-client}.ts`.
Keep retry cursors out of V5 and out of persistent command state. Add historical
execution origin separately through ledger codecs, shared message/API round trips,
and the governing V5/CTS metadata documentation; do not describe transport ACKs
as new V5 acceptance semantics.

The controller ingress is deliberately small. Representative synchronous core
of `publication-ingress.ts`, after wire parsing and exact binding validation:

```ts
export class OrderedPublicationIngress {
  #accepted = 0;
  #retired = false;

  constructor(private readonly sink: AgentProducerSink) {}

  receive(sequence: number, event: AgentProducerEvent):
    | { readonly kind: 'ack'; readonly throughSequence: number }
    | { readonly kind: 'replay-needed'; readonly afterSequence: number }
    | { readonly kind: 'retired' } {
    if (this.#retired) return { kind: 'retired' };
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TypeError('Invalid producer sequence');
    }
    if (sequence <= this.#accepted) {
      return { kind: 'ack', throughSequence: this.#accepted };
    }
    if (sequence !== this.#accepted + 1) {
      return { kind: 'replay-needed', afterSequence: this.#accepted };
    }
    try {
      this.sink.publish(event);
    } catch (error) {
      this.#retired = true;
      throw error;
    }
    this.#accepted = sequence;
    return { kind: 'ack', throughSequence: this.#accepted };
  }

  retire(): void {
    this.#retired = true;
  }
}
```

The owner maps a controller-issued opaque stream grant to this exact object and
captured sink. It checks both boot IDs/logical session before calling `receive`,
reconstructs permission capabilities only for that binding, and sends an ACK only
from the returned result. `replay-needed` starts the bounded reconnect barrier,
not speculative publication of the out-of-order event. A closed/stale sink's
rejection must not fail a successor's run. Ordinary V5 commit failures retain
their existing fence; no cursor recovery is attempted from durable ordinals.

Node cache operations are append immutable bytes, evict oldest whole records by
age/aggregate bytes, drop acknowledged prefixes, and read one stream's retained
contiguous range. Retain each live stream's produced counter even when its last
cached record is pruned, so an empty cache can report a gap rather than a false
empty success. Bound live streams by admitted execution resources and retire
their metadata only when their publisher source is retired. Pruning cached
output must not evict a live provider route or implicitly close its V5 sink.

Cache defaults are explicit configuration, instantiated only remotely:

```ts
export const DEFAULT_NODE_REPLAY = Object.freeze({
  enabled: true,
  maxAgeMs: 5 * 60 * 1_000,
  maxBytes: 20 * 1024 * 1024,
});
```

Representative deterministic test shape in
`server/execution-node/__tests__/supervisor.test.js`:

```ts
test('expired controller cannot renew or admit work', async () => {
  const fixture = createNodeSupervisorFixture({ leaseMs: 15_000 });
  const connection = fixture.connectController();
  const execution = await fixture.startExecution(connection);
  fixture.clock.advance(15_001);
  await fixture.supervisor.checkDeadline();
  expect(fixture.processes.stopRequested(execution)).toBe(true);
  expect(fixture.replyToOldChallenge(connection)).toEqual({ accepted: false });
  await expect(fixture.startExecution(connection)).rejects.toMatchObject({
    code: 'NODE_SESSION_EXPIRED',
  });
});
```

The fixture is a new fake-clock/process/transport harness, not real sleeps.
Add `publication-ingress.test.js`, `operation-outcomes.test.js`, and strict
contract tests under the new owning directories. Cover close-versus-publish,
late session/output, stale terminals/permissions, frame order, oversized
payloads, output overflow, lost start/decision replies, partial bulk transfer,
node death, controller death, and an abort-ignoring provider. A one-second
physical disconnect must no longer be the same oracle as an expired lease.

Add exact deterministic recovery cases to
`server/execution-nodes/__tests__/publication-ingress.test.js` and
`server/execution-node/__tests__/replay-cache.test.js`:

- Lost ACK after a multi-row commit replays once at transport and publishes once
  at V5; extracted Garcon commands also dispatch once.
- A zero-row/stale advisory advances the transport cursor, not the V5 ordinal.
- Live arrivals during fixed-watermark replay remain ordered; stale socket close
  and stale replay completion do not retire/complete a newer attempt.
- Age eviction, byte eviction, one oversized cache record, all-records-evicted,
  disabled retention, and pruning during replay report exact missing ranges.
  Combined storage across many chats never scales to 20 MiB per chat.
- A gap stops only the affected active stream, preserves committed rows, pauses
  its queue, and offers Reload only when its actual native prerequisites hold.
- Provider object mutation after emission cannot alter retained/replayed bytes.
- Sink close, Reload failure with a fresh sink on the same view, handoff,
  deletion, controller restart, node restart, lease expiry, and revocation reject
  old stream grants. Restart never hydrates a cursor or durable execution queue.
- Permission decisions with lost replies reconcile the exact occurrence receipt;
  replayed historical permissions never become actionable for another run.
- A user Stop during reconnect remains interrupted after recovery; no new abort
  or queued start targets a successor. Suspend/clock-discontinuity fixtures
  invalidate old leases before buffered admissions can execute.
- Saturated bulk/PTY traffic cannot starve control replies, aborts, or liveness
  challenges. Bound transfer chunks and socket queues as well as retained output;
  measure aggregate bytes under many streams, including disabled retention.

Example integration oracle for the lost-ACK case:

```ts
test('transport redelivery cannot duplicate ledger output', async () => {
  const fixture = await createDistributedFixture();
  try {
    const chat = await fixture.startRemoteChat();
    fixture.link.dropNextOutputAck();
    await fixture.provider.emitTwoRows(chat, ['synthetic one', 'synthetic two']);
    const committed = await fixture.controller.transcript(chat);
    await fixture.link.disconnectAndReconnectWithinLease();
    await fixture.controller.waitUntilRecovered(chat);
    expect(await fixture.controller.transcript(chat)).toEqual(committed);
    expect(fixture.provider.startCount(chat)).toBe(1);
    expect(fixture.controller.failureRows(chat)).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
```

The proposed fixture controls the provider and link interleavings explicitly;
it does not sleep until a race happens. Validate focused transport tests and
`integration-tests/tests/server/{distributed-reconnect,reconnect-transcript}.test.ts`.
Run browser V5 replay tests unchanged to prove the two boundaries remain distinct.

### Destination-aware handoff, preambles, schedules, and generation

Extend `common/{chat-command-contracts,self-handoff-contracts}.ts`,
`server/agents/{agent-handoff-types,agent-handoff-service}.ts`, and
`server/chats/{agent-ownership-journal,carryover-compaction}.ts`. Use one shared
ownership comparison in core and the execution-draft domain:

```ts
export interface LocatedChatOwner {
  readonly agentId: string;
  readonly executionLocation: ExecutionLocation;
}

export function sameExecutionOwner(a: LocatedChatOwner, b: LocatedChatOwner): boolean {
  return a.agentId === b.agentId
    && a.executionLocation.nodeId === b.executionLocation.nodeId
    && a.executionLocation.instanceId === b.executionLocation.instanceId
    && a.executionLocation.workspaceId === b.executionLocation.workspaceId;
}
```

Extend journal target snapshots and hashes with the immutable destination. Keep
the existing checkpoint/decision/roll-forward protocol rather than adding a node
journal or distributed transaction. Extend boundary message codecs in
`common/chat-types.ts` and `server/ledger/{contracts,codec,service,presentation}.ts`
with location provenance; update the governing V5 metadata documentation and
tests in that implementation change. Old stream rejection and pending decisions
must stay correct when source and target have the same provider type.

Add `server/agents/__tests__/located-agent-handoff.test.js` and extend
`integration-tests/tests/server/{repeated-agent-handoff,self-handoff,native-transcript-reload}.test.ts`.
Cover different-node same-provider, different local profile, same-owner model
change, nonempty queue, offline source after authority retirement, destination
failure before/after decision, restart roll-forward without source-node I/O,
source-native preservation, target fresh session, and no cross-node native fork.
Assert current bindings and historical file origins separately.

Update `server/preambles/{matching,selection,project-path-service,service}.ts`
and `common/preambles.ts` for qualified scopes. Replace local path assumptions
with an owner-validated project scope result; retain ordered-ID composition,
agent/tag default filters, receipts, and boundary ownership on the controller.
Add `server/preambles/__tests__/node-scopes.test.js` and extend existing selection
tests. Assert Everywhere, node-wide, exact/nested project matches, identical
paths on different nodes, removed nodes, foreign path separators/case rules,
out-of-scope saved-ID retention, destination handoff preview, and receipt-safe
native Reload. Existing scope and receipt fixtures remain valid in local mode.

Update `common/scheduled-prompts.ts`,
`server/scheduled-prompts/{scheduler,dispatcher,store}.ts`, and
`server/chats/agent-schedule-controller.ts`. New-chat targets include a complete
`ExecutionLocation`; existing-chat targets remain only chat identity and busy
behavior. Reject an execution-location override on the latter instead of
silently ignoring it. Existing schedules must follow the committed binding
under the same admission lock that excludes handoff, not a stale editor snapshot.
Add `server/scheduled-prompts/__tests__/node-targets.test.js` and
`integration-tests/tests/server/distributed-schedules.test.ts` for offline
occurrence failure/no replay, existing-chat handoff following, changed catalog
defaults at dispatch, explicit empty/ordered preambles, and no node cron jobs.

Represent auxiliary generation placement independently of a project:

```ts
export type GenerationPlacement =
  | { readonly kind: 'controller' }
  | {
      readonly kind: 'node';
      readonly nodeId: string;
      readonly instanceId: string | null;
    };
```

Missing persisted placement normalizes to `controller`, using the existing
generation agent/model policy on the controller's local instances. `node`
with a null instance uses that same policy within the selected node; a non-null
instance explicitly selects a profile and must match its provider/settings.
An explicit controller-node instance can use the latter arm too. Persist no
project path in this generation placement and never resolve a missing remote
node as `controller`.

Update `common/settings.ts`, `server/settings/generation-config-source.ts`,
`server/chats/{title-generator,carryover-compaction}.ts`,
`server/git/commit-message.ts`, `server/prompt-refinement/refine-prompt.ts`,
`server/api-providers/{service,endpoint-resolver}.ts`, and integration facets.
The generation coordinator resolves a concrete node/instance/configuration
revision, captures bounded source text, then calls a local or remote execution
port. New cross-location work uses the tested `textGeneration` facet. Native
`compaction` bypasses this placement setting and uses its exact execution handle.

Add `server/settings/__tests__/generation-placement.test.js`,
`server/api-providers/__tests__/node-endpoint-delegation.test.js`, and
`integration-tests/tests/server/distributed-generation.test.ts`. Cover all four
defaults/overrides, a controller without local providers, unavailable or removed
targets without fallback, null tool-free facet rejection, malicious tool-seeking
input unable to execute tools, diff revision changes, generation timeout/abort,
and captured configuration surviving a settings edit. Provider-side tests must
prove actual tool denial before the facet is advertised.

Extend Direct fake-model/native-history tests through two nodes: shared endpoint
definitions work without duplicated setup; only the selected secret is delegated;
`localhost` tests/discovery run on the chosen node; session JSONL/checkpoints stay
on that node; controller restart does not turn V5 into native resume history;
cross-node handoff creates a fresh native session. Keep secrets out of snapshots,
errors, logs, fixtures, and public exports. Validate focused suites and routine
gates before enabling these selectors in the browser.

### Cross-boundary server coverage

Add `integration-tests/support/execution-node-fixture.ts`: one controller,
two isolated nodes, synthetic workspaces/native storage, and a transport proxy
with explicit hold/drop/close controls. No user credentials or real transcripts.

Add server suites:

- `distributed-execution.test.ts`: local/remote start and native resume;
  two instances of one provider; same native IDs isolated across instances;
  output-before-terminal and input-before-dispatch assertions.
- `distributed-failures.test.ts`: controller absent at node startup, lost
  dispatch reply without redispatch, partition expiry and process cleanup,
  empty execution state on controller restart, stale old connections, retained
  V5 reads/search, paused queue, and no schedule replay.
- `distributed-reconnect.test.ts`: one-second interruption preserves the run;
  lost ACK deduplicates before publication/agent commands; fixed-watermark
  replay/live interleaving; simultaneous browser and node reconnect; cache gap
  stops the affected turn; node/controller restart rejects prior stream epochs.
- `distributed-workspaces.test.ts`: identical paths on different nodes,
  file mentions and preamble scope, file-save conflict, stale Git snapshot,
  lost mutation reply, attachment transfer and historical origin.
- `distributed-lifecycle.test.ts`: cross-node child/reply/message delivery,
  CLI bridge scoping, capacity rejection without deadlock, exact-instance
  native Reload/fork, handoff decision recovery, and offline deletion cleanup.
- `distributed-terminals.test.ts`: principal isolation, attachment takeover,
  offsets/truncation, token expiry, no input replay, and controller-loss cleanup.

Extend the existing deterministic real-binary scripted tiers for Claude, Codex,
OpenCode, and Pi to run through the node transport. Retain Direct fake-model
coverage and Cursor's unit-only posture. Do not replace provider-behavior
regressions with a permissive transport fake or run live credential suites as
routine local validation.

### Browser and CLI integration

Keep one controller API/WebSocket root. Use qualified workspace targets
internally without exposing them as extra controls in the standalone UI.
Reveal node selection only after remote-node configuration and extra instance
selection only after explicit instance configuration; preserve existing local
defaults. Do not create a second application root per execution node.
Preserve root-owned typed Svelte context and domain-owned services; the
installed Svelte 5 `createContext` contract and
`web/src/lib/context/index.ts` are the reference. Update API/WS normalization,
file/Git/terminal registries, chat file links, preamble scope and scheduling
editors with typed contracts. Define cache pruning on node removal and socket
incarnation change. Do not remount composer/dock to implement placement.

Add `web/src/lib/execution-nodes/node-directory.svelte.ts` and a typed root
context; keep transport in `web/src/lib/{api,ws,events}`. Chat placement drafts
belong in `web/src/lib/chat/conversation`, file and terminal target lifetimes
in their existing session registries, and Git qualification in its existing
target/surface domains. Add a small placement renderer beside the chat tray,
not a second chat root. Example derived visibility in a Svelte 5 component:

```svelte
<script lang="ts">
  import { getExecutionNodes } from '$lib/context';
  import ExecutionLocationPicker from './ExecutionLocationPicker.svelte';
  import type { ExecutionLocation } from '$shared/execution-location';

  let { location, onSelect }: {
    location: ExecutionLocation;
    onSelect: (next: ExecutionLocation) => void;
  } = $props();
  const nodes = getExecutionNodes();
  const showPlacement = $derived(
    nodes.hasConfiguredRemoteNodes || nodes.isUnavailableRemoteOrigin(location.nodeId),
  );
</script>

{#if showPlacement}
  <ExecutionLocationPicker value={location} {onSelect} />
{/if}
```

The renderer delegates staging; it does not mutate the durable chat or fetch
native resources. Do not introduce effects to mirror derived placement or keyed
remounts to reset the composer. The shared dock reserves stable space using the
existing layout policy, with node content independent of Git/running visibility.

```ts
export function projectWorkspaceKey(ref: ProjectWorkspaceRef): string {
  return JSON.stringify([ref.nodeId, ref.workspaceId]);
}
```

Use qualified keys at domain boundaries, not provider-name conditions in
renderers. Extend project-resolution, terminal-registry and file-link tests;
add `integration-tests/tests/e2e/distributed-workspaces.test.ts` for node
selection, offline transcript browsing, permission delivery, and correct file
targeting. Manually verify rapid chat/node switching, focus/scroll stability,
background events, and identical click/Enter/shortcut admission behavior.

Extend component tests for `ConversationPanel`, `GitQuickStatusTray`,
`ModelSelectorPopover`, `RemoteGenerationSettingsCard`, `PreambleFormDialog`,
and `ScheduledNewChatComposer`. Add execution-draft logic tests for same-provider
location changes and the shared submit policy. Add
`integration-tests/tests/e2e/distributed-chat-placement.test.ts` and
`distributed-settings.test.ts` covering:

- Every standalone node selector/badge is absent; pairing reveals controls;
  offline status does not hide them; a removed remote-bound chat stays identified.
- Node selection works with Git tray disabled, a non-Git directory, during
  processing, and on narrow/touch layouts without focus or scroll jumps.
- Profile/source/model/effort choices are qualified and stale catalogs cannot
  enable submission; changing nodes never silently picks another native session.
- Handoff staging/cancel/Send, queue rejection, destination preamble preview,
  Files/Git retarget only after commit, and historical links keep source origin.
- Dirty editors cannot save to a newly selected node; terminals retain their
  original target; lost Git/file mutation replies do not cause duplicate writes.
- Offline history/search/export stay readable, permission controls go inert,
  reconnect recovery is nonfatal, cache gaps show actionable Reload prerequisites,
  and Stop never claims remote rollback or confirmed kill without evidence.
- Schedule editor preserves dispatch-time defaults and follows existing chats;
  generation and endpoint tests disclose their selected node and local URL meaning.

Regenerate Paraglide when adding message keys with
`bun run --cwd web i18n:compile`. All controls are keyboard reachable, use semantic
tokens, preserve 16px touch form sizing, and use in-app confirmations. Include
a rapid chat/node switching manual verification note in the implementation PR.

### Rollout and rollback

Ship unchanged standalone behavior through the extracted services first; the
default startup must remain the full local application throughout rollout.
Enable remote execution only after standalone-parity and failure suites pass,
with workspace/PTY, reverse CLI, placement UX, and TLS gates also complete before
public opt-in is exposed. Internal staged routing may precede that release gate.
Reject mismatched protocol versions; stage upgrades by draining work and reconnecting nodes, not by live
operation migration. Controller startup remains available with every node
offline.

Validation: `bun run check`, `bun run test`,
`bun run test:transcript-inventory`, `bun run test:integration:server`, and
`bun run test:integration:e2e` for browser changes. After production code
changes, validate a new server using a timeout and `bun run start --port 0`;
never disrupt the user's running server. Do not claim green integration gates
from unit results alone.

Use the VM's resource-constrained test settings and foreground test commands.
Documentation-only validation checks links, code-fence syntax, and consistency;
it is not evidence that the proposed distributed suites already exist or pass.
For implementation, add the API/WS behavior migration note to the PR and update
the governing V5/CTS only for actual metadata/interface boundary changes. Never
claim that writing this proposal shipped distributed execution.

Rollback disables new remote admissions, revokes connections, and stops
supervised work while leaving controller history readable. Never translate
remote bindings into local ones or discard placement metadata. Rolling back
to a binary that predates the storage schema requires restoring a matching
backup, not silently interpreting the new registry with defaults.

## Alternatives and remaining limitations

Frontend multi-server connections cannot provide one authoritative registry,
cross-node controller scheduling, or coherent delegation; they remain useful
only for browsing independent controllers. Calling another full server's chat
API would duplicate ownership and transcript state. Generic RPC over existing
facets hides impossible synchronous guarantees. Durable execution/command
journals would solve the excluded restart/offline-execution problem. A cheap
lossy RAM or temporary-file output cache solves brief transport interruption
without either a second V5 ledger or that durable recovery machinery.

Public-CA-only TLS would exclude ordinary self-hosted deployments. Disabling
certificate verification would make node credentials, prompts, filesystem/Git
access, and terminals vulnerable to interception. Scoped trust of a copied
self-signed certificate/private CA provides the intended deployability without
either constraint. Automatic trust-on-first-unverified-connect is not the
enrollment policy.

The first version deliberately accepts lost uncommitted transport output,
unknown mutation outcomes, termination-detection latency, and unrecoverable
already-executed external effects. Native backups, repository synchronization,
cross-node native migration, and multi-controller federation are outside scope;
none is an implicit prerequisite for explicit remote execution against an
already-provisioned workspace. Provider supervision and wire-facet conformance
are release gates, not risks deferred until after enabling remote execution.

No product choice is left open for the implementer: existing-chat schedules
follow their chat; required replay gaps stop the affected turn and offer native
Reload; auxiliary generation defaults to the controller with per-operation
overrides. The five-second heartbeat/15-second lease, five-minute/20 MiB replay
defaults, RAM-first implementation, trusted-PEM setup, and staged code extraction
are concrete engineering choices in this proposal, not claims about existing
behavior. Tests must enforce their boundaries before public rollout.
