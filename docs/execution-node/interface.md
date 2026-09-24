# Execution Node Interfaces

Status: historical first-stage design, implemented through commit `2bf52dafc` on 2026-09-19 and superseded by subsequent multi-node and encrypted-transport work. Its single-node configuration, unencrypted transport, replay, per-session provider lifetime, retry timing, and module inventory are not current operational guidance. Current transport has no replay and keeps native turns alive across disconnects. See [Current Transport](./transport.md), [Files](./files.md), [Git](./git.md), and [Terminals](./terminal.md). The historical second-stage proposal is [Execution Nodes In The App](./app-integration.md).

The [transcript-ledger-v5 design](../transcript-ledger-v5-design.md), revision 38, governs transcript acceptance, execution state, interruption, and manual Reload. This design does not introduce a second transcript authority or durable execution recovery.

## Decision And Scope

The execution boundary is the complete provider-level `AgentIntegration`, not controller-side provider code over remote process primitives. The same provider implementation runs inside `InProcessExecutionNode` or in a separate Bun worker behind `RemoteExecutionNode`.

```text
Browser / Garcon CLI
        |
Controller: HTTP/WS, chat registry, queues, canonical ledgers
        |
ExecutionNode + provider-level AgentIntegration contracts
        |
        +-- InProcessExecutionNode -> provider implementations
        |
        +-- RemoteExecutionNode -> authenticated WebSocket/RPC
                                      |
                               Bun worker
                                      |
                               InProcessExecutionNode
                                      |
                               same provider implementations
```

The implemented stage supports one configured execution node per controller. Without remote configuration, existing in-process behavior remains the default. With remote configuration, the controller uses that worker's integrations and project filesystem. There is no per-chat node selector, multi-node scheduler, or fallback to local execution.

| Area | Current scope |
| --- | --- |
| Provider integrations | All ten shipped integrations use the common local/remote contract. Existing nullable capabilities remain provider-specific. |
| Connection | Authenticated bidirectional WebSocket, with either controller or worker dialing. |
| Brief disconnects | Bounded in-memory command/result/event replay within the same logical session. |
| Runtime restart or lost continuity | Retire the old logical session, attempt best-effort cleanup, and permit a fresh session without restarting the survivor. No execution recovery. |
| Project inputs | Node-owned project inspection, optional repository probe, and bounded `@file` expansion. |
| Native history | Provider-owned parsing and normalized import; controller-owned staging and manual Reload. |
| Single queries | No public working-directory argument. Each provider owns any temporary invocation directory. |
| Goal behavior | Removed, including native goal lifecycle and execution-authority transfer. |
| Generic process/file/Git/terminal services | Not implemented on `ExecutionNode`. Local application services remain available in local mode; remote machine routes explicitly reject. |

Ordinary steering, Stop, queueing, compaction, fork, cross-provider handoff, and existing transcripts are preserved. Former `/goal` syntax follows ordinary prompt and admission rules, including normal keyboard/button submission. Unrelated provider tool-message fields named `goal` are not the removed Garcon feature.

## Ownership

The controller owns chat identity and enumeration, canonical per-chat transcript ledgers, Garcon-command interpretation, queues, permissions authorization and durable permission history, scheduling, and application settings. Normalized assistant rows reach the controller before it extracts or acts on Garcon commands.

The execution node owns provider startup, binaries, native transport, JSONL/SSE parsing, event translation, native files, discovery, authentication, attachments, compaction, fork, and history import. Provider-specific code stays in `server-agents/<id>/`, behind `@garcon/server-agent-interface`. The worker is not a headless Garcon application: it has no second chat registry, canonical ledger, application queue, or scheduler.

An `AgentIntegration` is shared by that provider's chats on a node; it is not constructed per chat. Operations, producer bindings, permission responses, and other resources provide the narrower lifetimes. Core provider imports remain confined to [default-agent-integrations.ts](../../server/agents/default-agent-integrations.ts).

## ExecutionNode Contract

The authoritative types live in [execution-node.ts](../../server-agents/interface/src/contracts/execution-node.ts). The current service accessors deliberately do not advertise unimplemented interfaces:

```ts
type NodeAvailability = 'ready' | 'reconnecting' | 'offline' | 'disposed';

interface NodeCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface ExecutionNode {
  readonly id: string;
  readonly availability: NodeAvailability;
  getInfo(options?: NodeCallOptions): Promise<ExecutionNodeInfo>;
  getAgentIntegration(agentId: string, options?: NodeCallOptions): Promise<AgentIntegration>;
  getProjectService(options?: NodeCallOptions): Promise<ExecutionProjectService>;
  getProcessService(options?: NodeCallOptions): Promise<never>;
  getFilesService(options?: NodeCallOptions): Promise<never>;
  getGitService(options?: NodeCallOptions): Promise<never>;
  getTerminalService(options?: NodeCallOptions): Promise<never>;
  onAvailabilityChanged(listener: (value: NodeAvailability) => void): () => void;
  dispose(): Promise<void>;
}
```

`ExecutionNodeInfo` reports `nodeId`, `instanceId`, integration IDs, the portable `projectBasePath`, and services `{ agents: true, processes: false, files: false, git: false, terminals: false }`. Both node implementations reject the four unavailable accessors with `AgentCallError('not-dispatched', ..., 'OPERATION_UNSUPPORTED')`. Local file/Git/terminal routes still use their existing local services, not these accessors.

Each node returns a stable project service and a stable integration per provider ID. Acquisition does not guarantee a later operation succeeds. The remote facades consult the current authenticated session at dispatch; asynchronous methods reject as Promises when unavailable rather than throwing before a Promise exists. There is no hidden offline queue for newly requested mutations.

[InProcessExecutionNode](../../server/execution-nodes/in-process.ts) returns the actual integrations. These are borrowed for the node's lifetime; callers must stop using them after disposal. No universal lifetime-checking facade was added to local integrations. `dispose()` is idempotent best-effort cleanup, not proof of native process death or revocation of every previously returned local object. Remote session replacement fences transport access separately from native cleanup.

## Provider Contract And Resources

[integration.ts](../../server-agents/interface/src/contracts/integration.ts) remains the complete provider contract. [agent-protocol.ts](../../server/execution-nodes/agent-protocol.ts) maps concrete typed request/result pairs for execution, producers, permissions, catalog, lifecycle, migration, auth, commands, compaction, fork, steering, endpoints, single queries, history readers, native sessions/activity, configuration, and project-path updates. Nullable facets stay nullable; there is no public untyped `invoke()` escape hatch or provider-specific remote implementation.

Static manifests contain descriptors, attachment metadata, settings descriptors/defaults, scope, and capability flags. Pure settings helpers remain local; operations needing provider state cross the boundary. JSON messages are decoded with the shared message parser so normalized message classes do not lose their behavior at serialization.

### Scoped Authority

[resources.ts](../../server-agents/interface/src/contracts/resources.ts) defines references of the form:

```ts
interface AgentResourceRef<K extends string> {
  readonly kind: K;
  readonly nodeId: string;
  readonly instanceId: string;
  readonly integrationId: string;
  readonly id: string;
}
```

Resource kinds include execution handles, producer bindings, permission responses, steering targets, project-path preparations, and history readers. Scope and kind are checked at resolution. These are ephemeral capabilities, not transcript identities or durable execution records.

Stable node identity, transport process `runtimeId`, logical session identity, and node resource `instanceId` are distinct. A fresh worker serving session constructs a fresh `InProcessExecutionNode` and resource scope, even if the worker process survived. Same-session replay preserves references; fresh-session replacement makes old references stale. A reused native session ID does not make an old execution handle valid for a new run.

Execution handles belong to one operation and never transfer to a successor. The goal preparation/expiry/handoff state machine, successor slots, goal RPCs, endpoint, and UI capability have been deleted rather than retained behind a disabled flag.

Garcon-managed Codex app-servers disable the upstream `goals` feature before loading
threads. Existing native goal records remain untouched but cannot expose goal tools
or start automatic turns through Garcon. Clearing a goal after resume would race
the [upstream idle continuation](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/ext/goal/src/runtime.rs#L401-L440).

### Producer Binding And Acceptance

[ProducerBindings](../../server/agents/producer-bindings.ts) installs the exact controller lease route before calling `producers.bind`, and dispatch waits for registration. Events may precede the execution start/resume reply. Every native operation captures its own publisher; an event never discovers the latest transcript sink by chat ID.

Worker emission snapshots normalized events and hands them to bounded transport. A transport receipt means transport acceptance, not provider completion or durable controller ledger acceptance. The controller sink remains synchronous: validate the lease, canonicalize the event, commit, then schedule broadcasts through the per-chat event queue. Transport ordinals never become ledger ordinals.

Closing a lease immediately removes the controller route, evicts its cached acquisition, and rejects late/replayed events even while worker close is pending. Every cached or concurrent acquisition checks lease closure. Old bindings cannot publish into a replacement transcript view.

On the execution node, closing a binding cancels admission and best-effort aborts its active native operation, including a session established after closure. A start still pending when its binding closes rejects with `STALE_RESOURCE`; completed operations are never aborted.

Run terminal does not close the producer binding. Late rows and session facts remain admissible while the binding is open; old terminals, notices, and actionable permissions cannot affect a newer run. Preserve session-before-dependent-output and row-before-terminal-derived-broadcast ordering. Do not import generic process drain-before-exit rules into this normalized transcript contract.

### Permission, Steering, And Path Operations

- Permission requests carry a live response reference distinct from the historical occurrence ID. The worker retains the native callback and consumes responses single-flight. Core records resolution only after confirmed success; definite non-dispatch may release the claim, while uncertainty or a stale resource retires actionability without a successful resolution row.
- Steering captures an async target against the expected run/binding. The controller commits raw input and revalidates ownership before delivery; the worker checks the exact native target immediately before native writes. No callback RPC or extra steering preparation transaction is introduced.
- Project-path updates use scoped `prepare`, `commit`, and `rollback` operations. Preparations expire after 30 seconds. Expiry retires the reference but does not undo artifacts that may already be authoritative. Explicit known-no-mutation failures unblock another preparation; ambiguous failure or expiry keeps the chat quarantined for this adapter lifetime. This is compensation, not a distributed transaction or automatic reconciliation service.
- Cancellation is best effort and is not rollback. Authorization already sent cannot be synchronously revoked across machines.

The common implementations are [producer-adapter.ts](../../server-agents/common/src/execution/producer-adapter.ts), [control-adapters.ts](../../server-agents/common/src/execution/control-adapters.ts), and [project-path-adapter.ts](../../server-agents/common/src/execution/project-path-adapter.ts).

## Transport And Replay

### Layers And Prior Art

The implementation is original Garcon code using published [XEP-0198 acknowledgement and resumption concepts](https://xmpp.org/extensions/xep-0198.html#resumption). It is not XMPP, does not use the XML wire format, and does not vendor or adapt VS Code source. No transport dependency was added.

- [MessageSession](../../server/execution-nodes/message-session.ts) owns message ordinals, cumulative receipts, retained frames, duplicate suppression, and terminal continuity failure. It is single-use, not resettable.
- [SessionTransport](../../server/execution-nodes/session-transport.ts) buffers inbound replay until the peer replay fence, drains it in order, and then exposes readiness.
- [WebSocketLink](../../server/execution-nodes/websocket-link.ts) owns physical dial/listen, authenticated attachment, heartbeats, and creation of replacement logical sessions.
- [AgentRpc](../../server/execution-nodes/rpc.ts) owns typed application calls, results/errors, cancellation, and producer notifications for one captured `SessionTransport`.

The application envelope is intentionally small:

```ts
type Packet =
  | { readonly kind: 'message'; readonly ordinal: number; readonly body: string }
  | { readonly kind: 'receipt'; readonly through: number };
```

Commands, results, cancellations, and normalized events use the same ordered mechanism in both directions. Duplicates are suppressed before RPC dispatch or controller publication. An unexplained ordinal gap on an ordered WebSocket terminates continuity; there is no out-of-order repair protocol and no automatic retry of an uncertain application mutation.

### Reconnect Readiness

Same-session attachment requires authenticated agreement on runtime/session identities and retained receive positions. Each attachment sends retained messages before a trailing receipt. The first received receipt fences the peer's replay. Inbound payloads accumulated before that fence drain before application readiness and availability are announced.

The inbound buffer survives another transient disconnect because some buffered payloads may already have been acknowledged. Consumer failure, an invalid frame, a gap, or exhausted bounds terminates the session instead of acknowledging and continuing with a suffix. Terminal failure clears retained state; nothing transfers into the replacement session.

The authentication timer ends after proof verification. Replay has a separate inactivity deadline refreshed only by advancing inbound message ordinals. Heartbeats alone do not extend it. Replay inactivity retires the logical session, not merely the physical socket, so automatic redial cannot perpetually reset a stalled replay.

### Current Bounds

These are implementation defaults, not new operator-facing configuration fields:

| Limit | Current value |
| --- | --- |
| Retained outbound messages, per side | 4,096 frames / 32 MiB |
| Inbound pre-readiness replay, per side | 4,096 payloads / 32 MiB |
| Production session frame | 16 MiB; the standalone `MessageSession` default is 1 MiB |
| Detached-session resumption grace | 30 seconds |
| Replay inactivity | 30 seconds, refreshed by ordinal progress |
| Socket backpressure threshold | 4 MiB |
| Authentication handshake | 5 seconds; handshake payload at most 8 KiB |
| Initial link readiness | 10 seconds |
| Heartbeat / silent-peer check | Every 5 seconds; close after more than 15 seconds without a received frame |
| Dial retry | Fixed 100 ms |
| Pending outgoing / incoming RPCs | 256 each |
| Default RPC timeout | 120 seconds |
| Single-query RPC timeout | Validated provider timeout plus 30 seconds; default 150 seconds |
| Worker serving-scope cleanup wait | 2 seconds, diagnostic failure only |

Count and byte limits are independent bounds, not a claim about total process memory. Normalized provider rows are never evicted to keep a later terminal. These limits do not provide bulk-stream fairness; generic machine streams are deferred.

## Session Replacement And Failure Semantics

[RemoteExecutionNode](../../server/execution-nodes/remote.ts) and its [RemoteAgentIntegration](../../server/execution-nodes/remote-agent-integration.ts) objects remain stable. The replacement unit is the logical backing: `MessageSession`/`SessionTransport`, `AgentRpc`, manifests/scopes, subscriptions/readers, and worker integration instances. Old RPCs capture old session send endpoints and cannot send into a newer backing.

`AgentRpc.retireUnknown()` rejects pending outgoing calls as unknown, aborts incoming controllers, unsubscribes receive, and drops late replies/publications. Async continuations verify their exact request entry before sending. Remote producer routes are associated with the owning backing, not just a reused UUID.

Terminal-loss ordering is:

```text
retire old transport and RPC
-> invalidate old facade bindings
-> publish offline
-> fail affected active runs, including starts without a returned handle
-> close controller producer leases
-> validate and initialize a candidate backing
-> install candidate and publish ready
```

Runs must fail before leases close: closing a producer removes its active run and would otherwise suppress the failure event and ownership release. The existing committed terminal path releases coordinator ownership; no new busy predicate or goal-specific owner is added. [server-event-wiring.ts](../../server/server-event-wiring.ts) connects node availability to [AgentRuntimeRouter.executionSessionLost](../../server/agents/runtime-router.ts).

Replacement requires the same node ID, integration inventory/static manifests, and configured project base. The previously successful `migrateOwnedStorage()` and `start()` lifecycle calls run against the candidate before promotion. These are lifecycle setup, never execution resume or redelivery. Capability/root changes require controller restart; hot plugin inventory and rolling-version negotiation are out of scope.

| Observation | Controller action |
| --- | --- |
| Preparation/binding fails before the execution facet is invoked | Treat execution as not dispatched, fail/release its run, and forget startup progress. An unknown setup RPC is not an unknown execution launch. |
| Execution is definitely not dispatched or explicitly rejected | Fail/release the run. |
| Execution outcome is unknown within a surviving logical session | Keep the active run/ownership; do not retry, synthesize completion, or permit replacement execution. |
| Provider terminal | Apply the normal provider-correlated terminal. |
| User Stop while a run is active | Immediately record core interruption and request native abort best effort. Abort acknowledgement is not exit proof. |
| Terminal continuity loss while the controller survives | Record core failure with `OUTCOME_UNKNOWN`, fence old bindings, and release affected execution ownership. |
| Controller restart | Start execution state and queues empty; synthesize no historical terminals and replay no pending work. |

`ready -> reconnecting -> ready` is a resumable disconnection, not the terminal `offline` edge. New remote calls fail as not dispatched while unavailable; already-sent calls and events can complete through replay. Controller-owned queued work waits for availability and remains process-ephemeral.

Either controller or worker restart permits a fresh session without restarting the survivor. [serveAgentNode](../../server/execution-nodes/agent-worker.ts) removes producer subscriptions, retires RPC, aborts history readers, and attempts bounded cleanup. Fresh service does not wait for proof of native death. Residual native work or missing final rows are accepted best-effort losses, as in local crashes and interruption.

`execution.resume` is a new provider mutation against an existing native session. Transport reconnection never calls it. Neither reconnect, restart, nor retention failure invokes native import or replaces a transcript. The existing transcript-may-have-changed warning remains advisory; consolidation is exclusively the user's manual Reload action.

A provider-native connection failure is separate from the controller/worker link. For example, an OpenCode SSE failure cannot be repaired by healthy node WebSocket replay. The provider integration retains responsibility for its native transport/lifecycle semantics.

## Project Inputs, Paths, And Single Queries

### Project Service

Every agent-serving node exposes the following narrow service, implemented once by [LocalExecutionProjectService](../../server/execution-nodes/project-service.ts) and proxied remotely:

```ts
interface ExecutionProjectService {
  inspect(request: {
    readonly projectPath: NodePath;
    readonly includeGitRepository?: boolean;
  }, options?: NodeCallOptions): Promise<{
    readonly resolution: ProjectResolution;
    readonly isGitRepository?: boolean;
  }>;
  resolveFileMentions(request: {
    readonly projectPath: NodePath;
    readonly command: string;
  }, options?: NodeCallOptions): Promise<string>;
}
```

The configured project base is node-owned and advertised through `ExecutionNodeInfo`. Inspection performs realpath, existence, and symlink/base checks there. The optional repository probe is read-only and bounded to five seconds; it is not a generic Git API. Transport/capability failures never trigger controller-local filesystem fallback.

Controller orchestration is intentionally retained:

- Validate before direct admission and before queued dequeue, not inside a provider's eventual start call.
- Expand authored prompts before private preamble prefixing and carryover planning. Private preamble text is not scanned for file mentions.
- Commit raw steering input and deliver separately expanded provider content. Do not move filesystem work into the delivery revalidation hook.
- Use the same inspector for new chats, path changes, schedules, snippets, preamble scope mutation/preview, and workspace project defaults. Preserve binding checks across awaited remote inspection.

Mention expansion revalidates the project root and preserves the existing limits of eight files, 128 KiB per file, and 384 KiB aggregate file content, with best-effort handling of missing/binary/escaped/oversized files. The [shared separator and sanitizer](../../common/file-mention-context.ts) preserve authored input in the ledger and strip expansion from imported native history. Existing steering timeout policy may deliver raw input, but never falls back to controller-local reads.

### Portable Paths And Unsupported Surfaces

`NodePath` is currently a string convention, not a branded type. Declared path fields use `/` separators: `/home/user/project`, `C:/Users/user/project`, and `//server/share/project`. Conversion happens at the node's native IO boundary. The controller must not apply host `path.resolve()` to worker paths. POSIX literal backslashes, spaces, Unicode, drive roots, and UNC roots retain their meaning; prompt text, argv, environment values, and opaque native-session references are not globally rewritten.

Persisted preamble scopes are checked lexically as portable paths during loading, without querying the controller filesystem. Mutation-time admission checks the node. Existing chats whose paths do not resolve there remain unavailable; there is no path mapping or automatic migration.

[Remote machine routes](../../server/routes/unavailable-machine-services.ts) return `501 OPERATION_UNSUPPORTED` for files, Git, gh, and terminals. Terminal WebSocket requests return typed `terminal-unsupported` errors while chat remains usable. Manual project-path entry remains available. Remote ticket auto-default resolution returns `TICKET_PROJECT_UNAVAILABLE`; explicit projects work in both HTTP and agent-command paths.

### Single Queries And History

`AgentSingleQueryRequest` takes no cwd, project, or temporary-directory intent. Callers provide the required context in the prompt. CLI adapters can use the node-local [single-query directory helper](../../server-agents/common/src/shared/single-query-control.ts); Direct providers need no directory. Cleanup runs in `finally`. Temporary directories are invocation setup, not security sandboxes or a change to tool-permission policy.

Native reload and native-fidelity fork call the owning integration, which parses native evidence and yields normalized rows. Remote history uses scoped `history.open/next/close` readers bound to one RPC session, with cancellation and bounded lifetime. Core retains staging, sanitation, and view cutover. Missing/unreadable/interrupted native import fails without replacing the current view; a valid empty import remains distinct. Imported history never dispatches Garcon commands.

## Host And Trust Boundary

[AgentHost](../../server-agents/interface/src/contracts/host.ts) is node-local composition, not a serialized controller object. Provider binaries, native configuration/login, environment, and provider-owned storage belong to the worker account. Controller API-provider credential resolution is the narrow reverse `credentials.resolve` RPC; it does not replicate the whole settings store. The worker is trusted with resolved credentials, prompts, attachments, and provider output.

The connector uses preconfigured matching node IDs and a shared secret of at least 32 characters. HMAC proofs bind roles, version, identities, receive positions, and fresh nonces. The handshake checks the Garcon package version; deployments must still use matching builds because there is no rolling compatibility negotiation or pairing flow. Config files must be accessible only to their OS account on POSIX (normally mode `0600`). The shared secret belongs to the connector, not provider child environments or logs.

The worker deliberately clears inherited controller discovery settings and points spawned `garcon-cli` discovery at an unavailable workspace/config location. A general worker-to-controller CLI bridge is not implemented; it must not accidentally find a different Garcon instance on the worker. Controller-handled commands extracted from normalized provider output remain controller-owned.

### Configuration And Topology

[config.ts](../../server/execution-nodes/config.ts) currently uses the same loader for controller and worker:

```ts
interface ExecutionNodeWorkerConfig {
  readonly nodeId: string;
  readonly secret: string;
  readonly connection:
    | { readonly kind: 'dial'; readonly url: string }
    | { readonly kind: 'listen'; readonly port: number };
  readonly allowInsecureDevelopment: boolean;
  readonly workspaceDir: string;
  readonly projectBasePath: string;
}
```

The controller selects remote mode through `GARCON_AGENT_EXECUTION_NODE_CONFIG`; [controller-node.ts](../../server/execution-nodes/controller-node.ts) composes the node and stable integration registry. [worker-main.ts](../../server/execution-nodes/worker-main.ts) takes its config path as a positional argument and owns the serving-session lifetime.

Both config files need all fields. Worker `workspaceDir` and `projectBasePath` determine worker storage and project access; the controller's normal Garcon configuration still determines its application workspace. The controller reads the authoritative project base from the worker manifest, not from a local interpretation of a worker path.

In controller-dials mode the worker listens; in worker-dials mode the controller listens. Direction changes which endpoint must be reachable, not which side owns the ledger, credentials, or provider code. The execution link has its own `/execution-node` listener, distinct from the browser-facing Garcon server. Workers emit `execution-node-listening` and `execution-node-ready` diagnostics.

Raw listeners bind `0.0.0.0` and require `allowInsecureDevelopment: true`. This flag permits plaintext; authentication alone does not encrypt data. A non-development network deployment needs a TLS terminator, an access-controlled raw backend, and a `wss:` dial URL. The dialer can disallow plaintext independently. There is no built-in certificate provisioning, firewall management, or daemon supervision. This is a trusted-OS-account boundary, not isolation from other processes running as that account.

## Compatibility And Accepted Limits

Controller and worker ship together. Replacement does not support changed inventory/capabilities or changed project base until the controller restarts. The browser goal-control capability and endpoint are removed along with the provider facet; `/goal` is ordinary input, not a supported built-in command. Existing transcript rows are not migrated or deleted by goal removal.

Local mode remains the default when `GARCON_AGENT_EXECUTION_NODE_CONFIG` is absent. Switching node configuration is not a native-session migration: provider state and stored paths must already exist on the selected node. No state transfer, path remapping, or recovery against another machine's files is implied by changing the connection.

Accepted limitations are deliberate:

- Runtime/session loss can omit native output that never reached the ledger. Manual Reload is the repair path where supported; no exactly-once durable delivery is claimed.
- Stop and cleanup may leave native work running. Fresh-session service does not wait for retirement proof.
- An unknown launch in a surviving logical session can remain busy until provider terminal, explicit Stop, or terminal continuity loss.
- Ambiguous project-path updates can leave a preparation quarantine; there is no automatic rollback/reconciliation protocol.
- Initial startup expects the peer promptly. Fixed redial, transport diagnostics, and manual private configuration are implemented, not a polished connection-management UI or production deployment system.
- Multi-node routing, hot inventories, worker supervision, durable process attachment, bulk-stream fairness, metrics/soak hardening, and a remote spawned-CLI bridge require separate scope discussion.

## Verification And Source Map

All shipped integrations are wired through [defaultAgentIntegrations](../../server/agents/default-agent-integrations.ts): Claude, Codex, OpenCode, Pi, Amp, Cursor, Factory, Direct OpenAI-compatible, Direct OpenAI Responses-compatible, and Direct Anthropic-compatible. Interface conformance is not proof of full provider behavioral parity.

| Coverage | Evidence |
| --- | --- |
| All ten integration contracts through local and both remote dial modes | [integration-conformance.test.ts](../../server/execution-nodes/__tests__/integration-conformance.test.ts) |
| Bounded send queues, backpressure, connection loss, consumer failure | [message-session.test.ts](../../server/execution-nodes/__tests__/message-session.test.ts), [session-transport.test.ts](../../server/execution-nodes/__tests__/session-transport.test.ts) |
| Real WebSocket authentication, fresh-session replacement, no mutation retry | [websocket-link.test.js](../../server/execution-nodes/__tests__/websocket-link.test.js), [rpc-disconnect.test.ts](../../server/execution-nodes/__tests__/rpc-disconnect.test.ts) |
| Async offline rejection and provider query deadlines after setup | [remote-deadlines.test.ts](../../server/execution-nodes/__tests__/remote-deadlines.test.ts) |
| Stable facades, stale replies/events, independent restart, bounded cleanup | [session-replacement.test.ts](../../server/execution-nodes/__tests__/session-replacement.test.ts), [execution-node-restart.test.ts](../../integration-tests/tests/server/execution-node-restart.test.ts) |
| Immutable operation handles, native session-ID reuse, late rows, closed bindings | [execution-lifecycle.test.ts](../../server/execution-nodes/__tests__/execution-lifecycle.test.ts), [producer-bindings.test.js](../../server/agents/__tests__/producer-bindings.test.js) |
| Permission single-flight, history cancellation, immutable event snapshots | [resource-lifecycle.test.ts](../../server/execution-nodes/__tests__/resource-lifecycle.test.ts) |
| Node project ownership, portable paths, symlink/size limits, no fallback, disjoint real-process roots | [project-service.test.ts](../../server/execution-nodes/__tests__/project-service.test.ts), [execution-node-projects.test.ts](../../integration-tests/tests/server/execution-node-projects.test.ts) |
| Goal-shaped input becomes ordinary turns and empty slash completion permits Enter | [codex-producer-routing.test.ts](../../integration-tests/tests/server/codex-producer-routing.test.ts), [chat-slash-ordering.test.ts](../../integration-tests/tests/e2e/chat-slash-ordering.test.ts) |
| Shared provider behavior against separate Bun workers and scripted models | [SACS](../../integration-tests/tests/sacs/README.md), [execution-backend.ts](../../integration-tests/support/execution-backend.ts) |

The scripted SACS roster is Claude, Codex, OpenCode (Linux), Pi, and all three Direct integrations. Amp and Factory retain their provider-owned test tiers; Cursor remains best-effort/unit-only. They do not gain equivalent remote end-to-end evidence merely by passing conformance.

The [CI matrix](../../.github/workflows/integration-tests.yml) runs SACS as `in-process`, `remote-controller-dials`, and `remote-node-dials`, with the same assertions and serialized fixtures. Controller/worker roots, credentials, and ports are isolated; teardown retains unexpected worker-exit failures. Provider-specific protocol/scripted tests remain with their owning providers rather than being replaced by transport tests.

At the documented implementation baseline, all three SACS lanes passed 93/93. This is bounded scripted evidence, not a claim of paid/live-provider, production-network soak, or real Windows deployment validation. Portable-path codec cases likewise do not imply cross-OS deployment validation.

## Deferred Machine Services

The original process/file/Git/terminal inventory remains design context, not implemented API or required follow-up for this provider-remoting stage. These services would serve independent machine operations, not replace the provider-integration boundary. Their motivating distinctions are:

- **ProcessService:** opaque scoped identity; PID diagnostic only; explicit executable/argv/cwd/environment without an implicit shell; raw stdout/stderr bytes with per-stream ordering; ordered stdin and explicit EOF; termination request distinct from observed exit; exit distinct from output EOF; bounded `exec` that waits for the required output drain. Attach only when a caller needs processes to outlive a handle.
- **FileService:** typed path/stat/list/read/write operations justified by callers; owner-side path boundaries and complete revision-checked save transactions. Do not expose provider-native/config directories through browser file routes or implement safe-save as controller-side stat followed by unrelated remote write.
- **GitService:** owner-side repository locks and multi-command mutations, concrete DTOs, bounded subprocess output, and scoped review tokens. Agent-generated commit text remains controller orchestration, not a function sent to the worker. Uncertain mutations are not automatically retried.
- **TerminalService:** distinct process and attachment lifecycles; principal/browser ownership and takeover; ordered input/resize; detach does not terminate the PTY; bounded replay with visible truncation. Terminal replay policy must never truncate normalized provider rows.

Raw-byte/partial-UTF-8 behavior, stdin EOF, trailing output after exit, process-tree cleanup, slow consumers/fairness, revision conflicts, lost Git replies, and multi-principal PTY ownership are separate concerns. None is implemented or proven by passing agent SACS.

## Alternatives And References

- **Provider code in the controller over generic process RPC:** rejected. Native parsing, files, authentication, transport, and lifecycle belong together with each provider on the node; OpenCode's loopback HTTP/SSE remains an internal example, not a reason for generic HTTP tunneling.
- **Reconnect-only WebSocket wrappers:** insufficient for retained command and event delivery. Prior package evaluation found RSocket JS closest in semantics but alpha with unverified Bun support; Socket.IO does not remove the need for symmetric application reliability. These are selection-time findings, not claims that the packages can never work.
- **VS Code source adaptation:** explicitly rejected. The earlier attributed prototype was removed. Published protocol concepts inform the original bounded implementation; specifications/papers are not blanket permission to copy implementation code or tests.
- **Abandon on every disconnect:** a valid simpler product alternative, but bounded same-session replay was retained. It is kept separate from mutation completion and ledger durability, with manual Reload after continuity is lost.
- **Coordinated restart or authoritative native-retirement protocol:** rejected for this stage. Independent fresh-session replacement and best-effort cleanup match ledger v5's accepted losses without an orphan journal or distributed transaction.
- **Goal transfer machinery and universal local disposal facade:** removed/deferred by explicit product decisions. Neither is required to preserve ordinary turns and remote session fencing.

[Distant's pinned process protocol](https://github.com/chipsenkbeil/distant/blob/ba58064593ecb9e1b046c7e0d4626f39aa5c2633/distant-core/src/protocol/request.rs#L216-L257) and [host implementation](https://github.com/chipsenkbeil/distant/blob/ba58064593ecb9e1b046c7e0d4626f39aa5c2633/distant-host/src/api/state/process/instance.rs#L125-L246) illustrate distinct spawn, signal, input, output, and done operations, including bounded output drain. Its PID-derived identity is not adopted.

[E2B's pinned process schema](https://github.com/e2b-dev/E2B/blob/3e5a48b00eb133ac1e98697d549574301c605e81/spec/envd/process/process.proto#L5) separates Start from Connect, typed byte-stream events, input, signal, and stdin close. The inspected schema is not proof of server replay or durability behavior. These references inform lifecycle separation, not drop-in Bun dependencies or an additional agent stream framework.

If a future dependency or availability requirement demands substantial extraction, a new reliability framework, or stronger recovery guarantees, stop and discuss the supported smaller alternative or explicit loss policy before expanding this design.
