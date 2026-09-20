# Execution Nodes In The App

Status: proposed second stage, 2026-09-19. Researched against `agent-integration-remote` at `2bf52dafc`. The commands, configuration, APIs, and UI described below are proposed, not already available.

Predecessor: [Execution Node Interfaces](./interface.md), the implemented provider-remoting boundary. The [transcript-ledger-v5 design](../transcript-ledger-v5-design.md), revision 38, remains authoritative for transcript ownership, interruption, handoff, and manual Reload. This document extends execution selection to multiple nodes; it does not replace those lifecycle rules.

## Goal

Make execution nodes usable from a normal Garcon installation without editing controller configuration files or replacing all local execution with one remote worker.

A user can add a node in the app, connect it in either direction, choose it for a chat or a one-shot query, and keep using local chats while that node is offline. Existing chats remain local unless explicitly moved. Files, Git, and terminals on remote nodes are not needed to ship this stage.

The smallest useful result includes:

- One built-in Local node and multiple configured remote nodes, concurrently.
- An Execution Nodes dialog in the sidebar settings menu.
- Copy/paste connection URLs containing everything needed to authenticate a connection.
- A worker startup mode accepting the full connection URL as a CLI argument.
- Background connection/reconnection, without remote readiness blocking controller or worker startup.
- Node selection in the shared model selector, New Chat, the chat composer, and one-shot generation settings.
- Node-owned project validation and `@file` expansion, using the service already implemented.
- An optional chat `nodeId`; missing/null means `local`, without migration or backfilling.
- Cross-node handoff using the existing controller ledger and ownership journal, with a new native session on the destination.

## Scope And Complexity Budget

Keep the stage-1 WebSocket/RPC, bounded replay, scoped references, and fresh-session replacement. Do not introduce another reliability algorithm, durable RPC queue, native-process retirement protocol, or automatic history recovery.

The necessary new state is a controller node configuration store and a runtime manager of those configured nodes. Most remaining work is making existing single-node lookups explicit. An `AgentIntegration` remains provider-level, shared by that provider's chats on one node; there is no new chat-level integration object or universal disposal facade.

Out of scope:

- Remote file browsing/editing, Git/gh workbench, and terminals.
- File synchronization, project-path mapping, native-session transfer, or moving running tools.
- Automatic node selection, load balancing, fallback execution, and scheduling across nodes.
- Worker supervision, certificate provisioning, pairing services, multi-controller worker sharing, and rolling-version compatibility.
- Automatic Reload or reconciliation of native output after a restart.
- Reintroducing goal behavior or strengthening best-effort cleanup into proof of termination.
- A bridge for arbitrary `garcon-cli` processes spawned on the worker. Controller-interpreted commands from provider output continue to work; the existing worker-local CLI discovery restriction remains.

Manual remote project-path entry is the deliberate interim UX. A file picker can be added later without changing node identity, chat routing, or the project service.

## Current Implementation

The first stage already supports both dial directions, authenticated replay, independent runtime restarts, all shipped integration contracts, worker-owned project inspection, bounded file mentions, and single queries without a working-directory argument. The missing layer is normal app composition.

| Area | Current implementation | Change needed |
| --- | --- | --- |
| Composition | [controller-node.ts](../../server/execution-nodes/controller-node.ts) chooses one global node using `GARCON_AGENT_EXECUTION_NODE_CONFIG` and awaits discovery. | Always construct Local; load configured remote nodes without waiting for them. |
| Worker startup | [worker-main.ts](../../server/execution-nodes/worker-main.ts) takes a private JSON configuration path and awaits readiness before installing shutdown handlers. | Public CLI connection/listener modes; persistent listener secret; startup independent of connection. |
| Connection identity | [config.ts](../../server/execution-nodes/config.ts) requires both sides to configure the same node ID. | Controller owns the stable ID; worker receives it through authenticated hello. |
| Listener | [websocket-link.ts](../../server/execution-nodes/websocket-link.ts) owns a separate listener for each link. | Route inbound worker sockets through one controller HTTP listener. |
| Remote facade | [remote.ts](../../server/execution-nodes/remote.ts) waits for initial readiness; replacement facades are stable. | Construct with known ID while offline; first initialization and replacement both finish before ready. |
| Integrations | [integration-registry.ts](../../server/agents/integration-registry.ts) and [directory.ts](../../server/agents/directory.ts) index by agent ID. | One registry per node, with explicit node-qualified lookup. |
| Run loss | [runtime-router.ts](../../server/agents/runtime-router.ts) and [server-event-wiring.ts](../../server/server-event-wiring.ts) treat node loss globally. | Fail/close only the lost node's runs and bindings; wake only its queues. |
| Projects | [project-service.ts](../../server/execution-nodes/project-service.ts) implements remote inspection/mentions; composition injects one global service. | Select the service by draft target or current chat binding. |
| Chat selection | [store.ts](../../server/chats/store.ts), [session-types.ts](../../server/agents/session-types.ts), and [chat-list.ts](../../common/chat-list.ts) have no node identity. | Persist optional node ID and expose effective identity to clients. |
| Handoff | [agent-handoff-service.ts](../../server/agents/agent-handoff-service.ts) changes agent within the single node. | Compare `(nodeId, agentId)` and include destination project path in the same ownership decision. |
| Model UI | [model-selector-types.ts](../../web/src/lib/components/model-selector/model-selector-types.ts) and [model-catalog-store.svelte.ts](../../web/src/lib/agents/model-catalog-store.svelte.ts) are agent-keyed. | Add node to values, catalog keys, requests, and recents. |
| Generation | [generation-effective.ts](../../server/settings/generation-effective.ts) selects from one global catalog. | Explicit node selection; Auto considers only Local. |

The first-stage [project integration tests](../../integration-tests/tests/server/execution-node-projects.test.ts) already prove worker IO with disjoint controller/worker roots. This proposal routes that existing capability, rather than adding a generic filesystem service.

## Identity And Configuration

### Execution Selection

An execution selection contains four distinct concepts:

```text
node -> agent integration -> optional API provider/endpoint -> model
```

For example: `Build Machine -> Codex -> configured endpoint -> chosen model`. The node chooses the machine and provider instance. The integration chooses the adapter. The API provider/endpoint chooses credentials and network API where applicable. The model is not a replacement for any of those identities. Thinking effort, permission mode, and agent settings remain additional configuration.

Use explicit fields, not encoded agent IDs such as `node:codex`:

```ts
// common/execution-nodes.ts (new)
export const LOCAL_EXECUTION_NODE_ID = 'local';
export type ExecutionNodeId = string;

export function effectiveNodeId(value: string | null | undefined): ExecutionNodeId {
  return value ?? LOCAL_EXECUTION_NODE_ID;
}

export interface AgentExecutionTarget {
  readonly nodeId: ExecutionNodeId;
  readonly agentId: string;
}
```

Validate stored/API IDs before calling this helper: `local` or a generated UUID, never an empty string. A valid but unconfigured remote ID is unavailable, not Local. API responses can expose explicit `local`; persistence must not backfill it.

Keep identity lifetimes separate:

| Identity | Owner and lifetime |
| --- | --- |
| `nodeId` | Controller-persisted UUID identifying a configured trust relationship. `local` is reserved. |
| Label | Controller display data; editable, not identity, never required by the worker. |
| Link `runtimeId` | One endpoint-process lifetime, used for reconnect continuity. |
| Serving `instanceId` | Fresh worker integration/resource generation, even when only the controller restarted. |
| Transport `sessionId` | One logical replay session. |

Resource scopes remain `{ nodeId, instanceId, integrationId }`. A stable node ID is not a native-session capability or proof that a particular machine still holds the same files.

### Controller Store

Add a private, workspace-scoped `execution-nodes.json`, owned by a new `ExecutionNodeConfigStore`. Local is implicit and never stored as a remote record. Keep credentials out of the normal settings snapshot and browser persistence.

```ts
// server/execution-nodes/config-store.ts (new)
interface RemoteNodeConfig {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly secret: string;
  readonly connection:
    | { readonly kind: 'node-connects'; readonly advertisedUrl: string }
    | { readonly kind: 'controller-connects'; readonly targetUrl: string };
  readonly allowInsecureDevelopment: boolean;
}

interface ExecutionNodeConfigFile {
  readonly version: 1;
  readonly nodes: readonly RemoteNodeConfig[];
}
```

Both stored URLs are network URLs without the secret fragment. `advertisedUrl` is the editable public endpoint shown to the user, not a controller bind address. Default it to `wss://example.com/execution-node/<id>` when no deployment URL is configured. Do not assume a reverse proxy's external hostname is discoverable from the local listener.

Generate UUIDs and independent 32-byte random secrets for app-created nodes. Pasted worker URLs supply the worker's existing secret. Reject duplicate secrets within the controller store: they allow a holder to authenticate as another configured node by selecting its path. Persist atomically with private POSIX permissions, using the repository's existing settings/storage conventions. No encryption-at-rest framework is added; the OS account is already trusted with provider credentials.

A label change has no execution effect. Connection, direction, or secret edits replace only that node's connector. Reject disruptive edits while affected chats own execution, with guidance to Stop or complete that work first. Retire any remaining in-flight non-chat RPCs as unknown; never move them to the replacement link. Disable retains the record and current chat targets. Delete is rejected while current chats, explicit generation selections, scheduled targets, project-scoped configuration, or pending ownership/deletion intents require the node. Historical transcript boundaries are not live references and do not block deletion. Cosmetic recents/catalog caches can be pruned.

This is one active controller relationship per worker state directory. Do not add a worker account list, tenant selection, or worker-side node registry.

## Connection UX And URL Format

### Node Connects To Controller

1. Open sidebar settings menu -> Execution Nodes -> Add Node.
2. Enter a label and choose **Node connects to controller** (default).
3. Save creates the UUID/secret and registers the inbound route immediately. The node appears offline, waiting for a connection.
4. The dialog displays an editable full connection URL, with a copy action. The user replaces `example.com` with the reachable controller address as needed.
5. Pass that full URL as one CLI argument when starting the worker:

```sh
# Proposed public CLI; SECRET denotes the generated value, not literal text.
garcon execution-node --connect 'wss://example.com/execution-node/22222222-2222-4222-8222-222222222222#secret=SECRET' \
  --workspace-dir "$HOME/.garcon/execution-node" \
  --project-base-dir /workspace
```

No second secret flag, controller JSON file, manually assigned node ID, or separate pairing request is required. The worker parses the URL, authenticates, and learns its assigned ID from the controller. Editing the advertised address does not change that ID; an already-running worker continues using its startup URL until restarted with the new one.

### Controller Connects To Node

1. Start the worker in listen mode. It loads its private listener secret from its state directory, or generates and persists one on first use.
2. The worker prints a full connection URL for onboarding.
3. Open Execution Nodes -> Add Node, choose **Controller connects to node**, enter a label, and paste that URL.
4. Saving creates a controller-owned UUID and starts a connection attempt immediately. The controller retries in the background if the node is unavailable.

```sh
# Proposed local-development example. The real listener binds 0.0.0.0.
garcon execution-node --listen 19781 --allow-insecure-development \
  --workspace-dir "$HOME/.garcon/execution-node" \
  --project-base-dir /workspace

# Printed onboarding URL, with the real generated secret in place of SECRET:
# ws://0.0.0.0:19781/execution-node#secret=SECRET
```

`0.0.0.0` is an editable placeholder, not a remotely reachable destination. The app prompts the user to replace an unspecified address before saving. An optional `--advertise-url wss://worker.example.com/execution-node` lets a deployment behind TLS print a usable address; it is not certificate automation. Restarting with the same worker state directory reuses the listener secret and provider state. A dialing worker gets its credential from `--connect`; it need not save a second copy of that secret.

Use one public worker mode in the existing Garcon executable, dispatched before normal controller initialization in [server/main.ts](../../server/main.ts). The equivalent source invocation is `bun server/main.ts execution-node ...`. Keep the existing provider build contributions in [build-exe.js](../../scripts/build-exe.js); do not invent a second distribution solely for this mode. `--connect` and `--listen` are mutually exclusive. Default worker storage to a dedicated `execution-node` directory under the Garcon config directory, not the controller's default workspace. Default its project base to the worker account's home directory, matching existing local path policy. Explicit worker flags override these defaults; do not accidentally inherit the controller's workspace environment. A worker state directory must not be shared with a running controller or another worker.

### Secret-Bearing Descriptor, Secret-Free Network URL

Use the URL fragment for the connection credential:

```text
wss://controller.example.com/execution-node/<node-uuid>#secret=<base64url-32-bytes>
wss://worker.example.com/execution-node#secret=<base64url-32-bytes>
```

This is a connection descriptor accepted by Garcon, not a URL to navigate to in a browser. Parse and remove the fragment before constructing a WebSocket. Continue authenticating with the existing nonce/HMAC handshake; the secret is not sent as an HTTP query parameter or WebSocket subprotocol.

```ts
// server/execution-nodes/connection-url.ts (new)
export function parseConnectionUrl(value: string): {
  readonly socketUrl: string;
  readonly secret: string;
} {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search) {
    throw new Error('Invalid execution-node connection URL');
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const secret = fragment.get('secret');
  if ([...fragment.keys()].length !== 1 || !secret || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new Error('Invalid execution-node connection credential');
  }
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) {
    throw new Error('Invalid execution-node connection credential');
  }
  url.hash = '';
  return { socketUrl: url.href, secret };
}
```

The caller additionally validates the direction-specific pathname, UUID, and plaintext policy. Errors must never echo the original input. The app can share a browser-safe shape validator; authoritative secret decoding and persistence remain server-side.

The full descriptor is a credential. Reveal it only in the explicit onboarding/detail flow, mask it by default afterward, and copy it only through an explicit action. Do not place it in node-list payloads, status broadcasts, browser local storage, telemetry, provider child arguments/environment, or normal reconnect logs. The worker's requested one-time startup display is an intentional disclosure, distinct from routine diagnostics.

CLI arguments, shell history, clipboard contents, and captured startup output can expose the secret to the operator's OS account or log tooling. Accept that tradeoff for the requested one-argument UX; state it near copy/startup help. Fragment placement avoids ordinary HTTP request logging, not all credential exposure. Require `wss:` outside explicit insecure-development mode. HMAC authenticates; it does not encrypt prompts, outputs, or provider credentials.

A TLS-terminating proxy must keep its raw backend access-controlled, as in stage 1. Neither the editable hostname nor `--advertise-url` creates TLS or makes a public plaintext listener safe.

## Background Connection Ownership

### Authenticated Identity Assignment

Make hello role-specific rather than requiring worker configuration to match a controller ID:

```ts
type EndpointIdentity =
  | { readonly role: 'controller'; readonly nodeId: string; readonly runtimeId: string }
  | { readonly role: 'worker'; readonly runtimeId: string };
```

This is the identity portion of the existing hello, not a replacement wire protocol. Preserve version, nonce, and resume fields. The ordered HMAC transcript includes the controller's `nodeId`. The worker may use the assignment only after verifying the proof. Pass the authenticated ID into the session-specific transport and construct its fresh `InProcessExecutionNode` with it.

The controller knows `RemoteExecutionNode.id` immediately from configuration. It verifies that `node.describe.info.nodeId` and every integration scope match. No assignment RPC is needed. A resumed session must retain its authenticated assignment; a different assignment requires a fresh logical session and fresh resource scope.

### Shared Controller Listener

The controller owns upgrades at `/execution-node/<node-uuid>` on the normal HTTP/WS listener. Look up the UUID directly in the enabled configuration map, then hand the socket to that node's `WebSocketLink`. Unknown/disabled IDs are rejected. The path selects a secret; it is not authentication.

Split physical server ownership from per-link socket/authentication callbacks in [websocket-link.ts](../../server/execution-nodes/websocket-link.ts). Keep a single-node listener wrapper for workers. In [server.ts](../../server/server.ts), use a discriminated socket-data union to route chat `/ws` and execution-node callbacks. Do not send worker frames into `PrimaryWsHandler` or require a browser login cookie for the worker HMAC endpoint. Node-management HTTP routes still require normal app authentication.

Captured socket data must name the exact link object. A late close/message from an old link must not look up the latest node record and act on its replacement. Existing attached-session duplicate rejection remains; a second live worker does not silently take over a healthy node.

### Node Manager And Readiness

Add a controller-owned `ExecutionNodeManager` in `server/execution-nodes/manager.ts`. It owns configuration application, one Local node, remote links/facades, per-node integration registries, availability subscriptions, and cleanup. It is not an execution scheduler.

```ts
interface ExecutionNodeDirectory {
  requireNode(nodeId: ExecutionNodeId): ExecutionNode;
  requireIntegration(target: AgentExecutionTarget): AgentIntegration;
  projectService(nodeId: ExecutionNodeId): Promise<ExecutionProjectService>;
  isReady(nodeId: ExecutionNodeId): boolean;
}
```

These are proposed controller signatures using existing interface types. `requireIntegration` returns only initialized integrations and otherwise reports typed node unavailability. Keep `IntegrationRegistry` fixed within each node; do not mutate one global inventory whenever a worker connects.

Startup and connection ordering:

```text
load node config -> construct Local + offline remote objects -> install routes/subscriptions
-> start Local -> accept normal application requests

independently for each enabled remote:
wait for inbound connection OR dial immediately
-> authenticate -> finish replay fence -> describe/validate candidate
-> migrateOwnedStorage/start for that node's integrations
-> install candidate and publish ready
```

Remove the production ten-second first-connect deadline and the production factory's wait for `RemoteExecutionNode.connect()`. Keep a separate await-ready helper for bounded tests when useful. First connection and fresh-session replacement must initialize lifecycle before exposing ready; initial lifecycle cannot remain a later global startup step. Internal candidate-bound initialization must not require publishing the candidate as current first.

Also audit the existing startup record migrations, `chatRegistry.reconcileSessions()`, settings reconciliation, and transcript adoption. Loading/enumerating already-normalized remote chats must not require live discovery, discard saved settings/native refs, or validate them against a local instance. Skip provider-dependent reconciliation for unavailable nodes and perform it when that node is usable. An unavailable resolver is not a definitive `null` native session. Existing controller ledgers remain readable offline; legacy genesis adoption that genuinely needs a worker reports unavailability instead of inventing an empty transcript. Controller-local ownership-journal recovery likewise must finish without waiting for a remote producer to reopen.

Retain stage-1 per-socket authentication, heartbeat, replay inactivity, and resumption bounds. Change redial from 100 ms to one immediate attempt followed by fixed five-second retries. No overlapping attempts; cancel timers and sockets on disable/disposal. Authentication or initialization errors keep only that node offline and visible with a sanitized last error. A never-connected worker can remain offline indefinitely without blocking app startup or the worker's signal handlers.

After a node's first successful description, retain its static inventory for the controller process lifetime. Offline catalogs may display known selections as unavailable, but never invent manifests or permit new execution based on cached readiness. Fresh sessions must preserve the stage-1 inventory/capability/project-base checks. Changes require controller restart, not dynamic plugin compatibility.

Shutdown first quiesces admissions/dial loops, requests best-effort abort/cleanup, and then closes the shared listener. Cleanup has existing bounds and never requires proof of native process death. Mark deliberate shutdown so it does not synthesize connection-loss failures during controller disposal.

## App Contracts And Dialog

### Management API

Add typed contracts in `common/execution-nodes.ts` and authenticated routes in `server/routes/execution-nodes.ts`:

| API | Purpose |
| --- | --- |
| `GET /api/v1/execution-nodes` | Sanitized Local + configured remote snapshots. |
| `POST /api/v1/execution-nodes` | Create from `{ label, direction }` or `{ label, direction, connectionUrl }`; return ID and the explicit onboarding descriptor. |
| `PATCH /api/v1/execution-nodes/:id` | Validate/persist label, enabled state, or connection edit; apply only to that connector. |
| `GET /api/v1/execution-nodes/:id/connection` | Explicit authenticated reveal of the full descriptor; `Cache-Control: no-store`. |
| `DELETE /api/v1/execution-nodes/:id` | Remove an unreferenced remote node; conflict otherwise. |

Use discriminated create/update payloads so invalid direction/URL combinations cannot be accepted accidentally. Saving configuration succeeds while offline; it does not claim authentication or readiness. Return validation errors inline, unknown IDs as 404, in-use configuration edits as 409, and dispatch unavailability as 503. Local cannot be deleted or assigned a remote URL.

```ts
interface ExecutionNodeSnapshot {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'remote';
  readonly enabled: boolean;
  readonly direction: 'node-connects' | 'controller-connects' | null;
  readonly availability: 'ready' | 'reconnecting' | 'offline';
  readonly projectBasePath: string | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly machineServices: {
    readonly files: boolean;
    readonly git: boolean;
    readonly terminals: boolean;
  };
}

type ExecutionNodesChanged = {
  readonly type: 'execution-nodes-changed';
  readonly nodes: readonly ExecutionNodeSnapshot[];
};
```

Use one small full snapshot on configuration/availability transitions, not a node event log. HTTP bootstrapping and browser reconnection fetch the current snapshot. `machineServices` describes application route availability: true for existing local services, false remotely. It must not misrepresent the still-unimplemented generic `ExecutionNode` accessors as available on Local.

### Frontend Ownership

Add Execution Nodes to [SidebarControlsRow.svelte](../../web/src/lib/components/sidebar/SidebarControlsRow.svelte), using the existing shell dialog lifecycle. Keep reusable node state in `web/src/lib/execution-nodes/`, transport in `web/src/lib/api/` and the WS adapter, and renderers in `web/src/lib/components/execution-nodes/`.

The dialog is a compact list with label, Local/remote, direction, status, and edit controls. Add/edit shows a label, direction selector, connection URL input/copy action, development-transport option when applicable, and enabled toggle. Local is visible but non-removable. Show connection errors without replacing the saved configuration. Disabled, waiting, and reconnecting are presentation of configuration plus existing availability, not new execution states.

Use root-owned typed context, Svelte 5 callback props/runes, semantic tokens, standard dialogs, keyboard focus restoration, and inline errors. The [official Svelte context guidance](https://svelte.dev/docs/svelte/context) recommends `createContext` and instance-owned shared state. Do not create a global singleton or remount the composer when node status changes. Secret detail is short-lived dialog state, cleared on close, not part of the global node store.

## Node-Qualified Routing

### Chats And Persistence

Add `nodeId?: string | null` to `ChatRegistryEntry`, new-chat input, registry codec, execution session config, and chat projections. The existing `chats.json` format remains version 5; no migration sweep is needed for an optional field.

```json
{
  "local-chat-example": { "agentId": "codex", "projectPath": "/workspace/app" },
  "remote-chat-example": {
    "nodeId": "22222222-2222-4222-8222-222222222222",
    "agentId": "codex",
    "projectPath": "/workspace/app"
  }
}
```

This is a field excerpt, not a complete registry fixture. Missing/null stays a valid representation of Local. New local writes omit the field; an unrelated save must not materialize `"local"` on existing entries. Explicit movement back to Local clears the remote field. Unknown explicit remote IDs remain unavailable, never silently defaulted.

`nodeId` is ownership, not an ordinary mutable chat preference. Exclude it from the generic chat patch allowlist. New-chat creation or the existing ownership-transfer path is the only way to assign/change it. A direct patch must not leave an old native session attached to a new node.

Make `AgentDirectory` resolve a target, not a bare agent ID. For chat operations, derive that target from the registry, not client-supplied overrides:

```ts
const target = {
  nodeId: effectiveNodeId(entry.nodeId),
  agentId: entry.agentId,
};
const integration = directory.require(target);
```

Apply this to start/resume, Stop, steering, permission responses, compaction, fork, native history/activity, project-path preparations, slash-command discovery, configuration, and native-reference release. Permission/execution resource refs already carry node scope; reject a supplied ref for another node rather than resolving it by agent ID.

Native-session lookup/indexing must include node plus agent plus native identity. Two workers can legitimately return the same native session ID. Keep provider-native references opaque and node-local; controller-owned cleanup records can wrap them as `{ nodeId, reference: AgentChatReference }` rather than adding routing policy inside provider adapters.

### Loss, Queues, And Admission

Replace global `canDispatch()` with chat-qualified availability, for example `canDispatch(chatId)`, resolving the current stored node. This is an availability check, not another chat busy predicate. Keep existing `ownsExecution` and processing projections unchanged.

Direct work must validate target readiness/project before admission. Existing queued entries wait during disconnection and are dequeued only after their current node is ready and project inspection succeeds. Do not silently retarget or clear them. A reconnect can wake that node's existing queue; it cannot retry an execution already dispatched with unknown outcome.

Change `executionSessionLost()` to accept the affected node and snapshot exact active `{ chatId, runId }` and leases at the offline edge, including starts without a returned handle. Fail those runs before closing their leases, as today. Clear only matching progress callbacks, pending abort markers, and handles. Use captured run/binding identities so delayed cleanup cannot fail a newly installed generation. Local and other remote runs continue untouched. Terminal-derived broadcasts still go through the existing per-chat event queue.

### Catalogs, Authentication, And Settings

Scope agent/model/auth APIs and every related cache by node. Existing `/agents` and `/models` route families can accept a validated `nodeId` query field for reads and a typed field for mutations; omit only for the deliberate Local default. Avoid parallel copies of all endpoints under a second API tree.

Use nested maps or typed tuple keys such as `JSON.stringify([nodeId, agentId])`, including server model caches, browser persisted catalogs, selector recents, auth status, configuration status, and asynchronous request results. Node deletion prunes its caches; fresh serving generations invalidate dynamic model/auth readiness. An old request completing after selection change cannot replace the new node's options.

Fetch dynamic catalogs/auth for the selected node, not by awaiting every configured node for a global settings response. Node-list snapshots use manager-owned data and never wait on worker RPC. Existing replay budgets apply per link, so aggregate retained memory grows with the number of active nodes; this stage targets a small configured set, not fleet-scale discovery or buffering.

Provider environment, CLI binaries, login, and native storage remain on the selected node. API provider/endpoint definitions and credential resolution remain controller-owned, using the existing reverse credential RPC. An endpoint such as `localhost` is reached from the selected node; do not rewrite it to the controller. Node selection is a trust decision because prompts, attachments, resolved credentials, and output cross that boundary.

### Other Entry Points

Audit creation and dispatch outside the main composer:

| Entry point | Node rule |
| --- | --- |
| Ordinary new-chat HTTP/CLI request without node | Local. |
| Existing-chat send/resume/Stop/history | Stored current node, regardless of a stale UI default. |
| Delegated child created from a chat | Inherit source node unless explicitly overridden; validate any destination project path there. |
| Continuation/new-chat handoff | Explicit target or source-node default; ledger-seeded, not native migration. |
| Native-fidelity fork | Same node as the source integration. A cross-node continuation uses the existing explicit ledger/handoff path, never a silently degraded native fork. |
| Scheduled existing-chat prompt | Resolve current stored node at dispatch. |
| Scheduled new chat | Persist optional node ID with its target; missing/null remains Local. |
| Agent-emitted creation commands | Include node in the typed controller command contract and request fingerprint. |
| Deletion/ownership recovery | Preserve the node in references and comparisons; never release a same-ID native session on another node. |

Do not change all provider settings to node-scoped preferences merely because routing is now explicit. Schema-owned per-agent chat settings can remain reusable by agent where they are already portable. Machine-sensitive discovery/auth caches and project paths cannot.

## Projects Without Remote Files

### Validation And Path Identity

Route `ExecutionProjectService.inspect()` and `resolveFileMentions()` by selected node. A project identity is `(nodeId, portablePath)`, not the path alone. The same `/workspace/app` on two nodes denotes two different projects.

Extend [ProjectTarget](../../common/project-resolution.ts), response validation, and project-resolution cache keys:

```ts
type ProjectTarget =
  | {
      readonly kind: 'chat';
      readonly chatId: string;
      readonly nodeId: string;
      readonly projectPath: string;
    }
  | { readonly kind: 'path'; readonly nodeId: string; readonly projectPath: string };
```

For a chat target, the server checks node/path against the registry both before and after the awaited inspection. The response describes that same target. The browser discards stale results after a node/path/chat change. Continue using node-side realpath/base/symlink validation; never call controller `path.resolve()` on remote paths.

Known missing, inaccessible, outside-base, and non-directory paths keep the existing unavailable-directory experience. A transport error is node unavailability/503, not `not-found`. A failed inspection prevents chat admission or queued dequeue. The project disappearing after inspection remains an ordinary provider launch failure, not grounds for a filesystem transaction protocol.

### New Chat And Composer

The New Chat path input already supports manual editing. Add node selection to its model selector, then select defaults and inspect against that node. Show the advertised node project base when known. With no successful node description, do not guess the controller's base.

For remote nodes, disable directory browsing, focus-triggered browse requests, Tab directory completion, Git worktree selection, and file-mention autocomplete. Hiding a browse button alone is insufficient: [new-chat-form-state.svelte.ts](../../web/src/lib/chat/new-chat/new-chat-form-state.svelte.ts) has automatic fetch paths. Typed/pasted project paths and typed `@file` mentions remain supported. Input errors refer to the selected node and do not trigger local fallback.

Changing a draft node invalidates path validation and shows that node's default/last path; do not silently reuse a canonical result from another node. Existing-chat node changes use the handoff flow below and allow an explicit destination path. Preserve draft prompt text while resolving the target.

Keep existing local paths/preferences where they are; add remote paths keyed by node rather than migrating Local:

```ts
interface NodeProjectPreferences {
  readonly defaultPath?: string;
  readonly recentPaths: readonly string[];
  readonly pinnedPaths: readonly string[];
}

// Add beside the current Local path preferences in workspace settings.
interface RemoteNodePathPreferences {
  readonly byNode: Readonly<Record<string, NodeProjectPreferences>>;
}
```

Never write a `local` entry into this remote map. Node/path keys also apply to sidebar project grouping and project-resolution caches. Labels distinguish otherwise identical paths across nodes.

### Remaining Project Consumers

Select the same node in `ProjectAdmission`, start/path-update resolvers, `/chats/validate-start`, slash-command discovery, snippets, preamble selection/preview, schedules, and ticket default resolution. Ticket auto-defaults remain local-only; explicit ticket projects remain available. Apply routing before invoking an existing helper, rather than allowing any helper to fall back to local IO.

Add optional `nodeId` to project-scoped preamble rules and their matching context. Missing/null rules mean Local, not every node with the same path. Global preambles remain global. Mutation/preview inspection happens on the selected node; persisted path loading remains lexical, without contacting offline nodes. Existing receipts and historical preamble application rows are not rewritten.

File mention ordering is unchanged: inspect and expand authored text through that node before private provider-prefix composition; commit raw authored input; use the existing separator/sanitizer; preserve steering's existing bounded timeout behavior. Single queries still have no public cwd/project argument.

### Machine Surface Gating

Remove the server-wide `localMachineServices` switch. Keep current local file/Git/gh/terminal routes and local PTY services alive alongside remotes. Qualify machine requests with their target node, or derive it from the selected chat; reject remote targets with `501 OPERATION_UNSUPPORTED` before any filesystem lookup or spawn. Keep terminal socket ownership local and reject remote terminal creation explicitly.

Remote file links and project actions must show unavailable/disabled behavior, never open a controller file having the same path. Local actions remain usable even if every configured remote node is offline. This is target gating of existing local services, not implementation of the deferred generic node service APIs.

## Shared Model Selector And One-Shot Queries

Add `nodeId` to `ModelSelectorValue`, `ModelSelectorChange`, and recent selections. Add node selection alongside agent/source/model in the existing selector, with Local first and labels/status for remotes. Preserve the integration/model choice across node changes only if it is valid on the destination; otherwise require a supported choice. Never silently execute on the old node because discovery failed.

Never-connected/offline nodes remain visible in management and on existing selections. Disable new model selection until their first live catalog is available. An existing chat keeps its saved target while offline, with explicit unavailability rather than auto-selecting Local. Ordinary same-node model changes use the existing configuration flow. Changing node or integration on an existing chat uses ownership handoff, not a selector-only registry patch.

Extend [GenerationSelectionUiSettings](../../common/settings.ts) and effective generation config with the node:

```ts
interface GenerationSelectionUiSettings {
  nodeId?: string | null;
  agentId?: string;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  // Existing protocol and thinking-mode fields remain.
}
```

Apply to chat title, handoff compaction, commit-message generation, prompt refinement, and their test actions. `runSingleQuery()` resolves `(nodeId, agentId)` before invoking the same existing provider request. The request itself needs no working directory or node-routing field because it is already sent to the selected integration.

**Auto always resolves using Local integrations, authentication, readiness, and models.** It does not follow the current chat or search remote nodes. Choosing Auto clears explicit selection fields, including `nodeId`, but preserves unrelated enable/custom-prompt/size preferences. Legacy manual selections without a node remain local.

An explicit remote selection does not fall back to Local or another worker on failure. Preserve the caller's existing non-AI failure behavior, such as a fallback title, or surface an actionable error. The one-shot model-test action must test the selected node, including its authentication and timeout behavior. Local Git diff collection can feed an explicitly selected remote commit-message generator; that does not imply remote Git support.

## Cross-Node Handoff

### What Moves

The controller already owns the persistent conversation. A node change moves the current execution binding, not the transcript or provider-native state. The destination receives the same ordinary fresh-start request and ledger-derived carryover used for a new native session.

Preserve Garcon chat ID, ledger, transcript view/cursors, attachments available to the controller, and conversational carryover. Do not transfer files, tools, provider memory outside the ledger, native session IDs, or a live execution handle. Embedded old paths/tool results remain historical context, not proof the files exist on the destination. Existing carryover limits/compaction apply, with Auto compaction local.

### Selection And Preconditions

The composer treats `(nodeId, agentId)` as the owning integration identity. Same agent on a different node is a handoff; same node/agent with another model remains the existing model-change flow.

Use the existing per-chat reservation and idle, empty, unpaused queue requirement. Do not stop a turn or discard queued input implicitly. The destination must be ready and its integration/model/configuration valid. The dialog shows the current path as a proposed destination value, allows editing it, and validates it on the destination. Same path text is not assumed valid or equivalent across nodes.

Source connectivity is not required once the chat is idle and its ledger is available. Source cleanup remains best effort; no native retirement acknowledgement is required. If loss may have omitted native rows, keep the existing Reload advisory. The user can Reload before moving while the source is available; handoff freezes the currently accepted ledger prefix and does not import source history automatically.

### One Durable Ownership Decision

Extend the existing request/target/journal, rather than adding a remote handoff RPC:

```ts
// Additions to the existing resolved target, not a second execution config.
interface ResolvedAgentHandoffTarget {
  readonly nodeId: string;
  readonly projectPath: string;
  readonly agentId: string;
  readonly model: string;
  // Existing endpoint, protocol, modes, and agentSettings fields remain.
}

// Extend the existing journal source fence.
interface HandoffSourceIdentity {
  readonly nodeId: string;
  readonly agentId: string;
  readonly agentOwnershipEpoch: string;
}
```

The destination project path and node must be installed atomically with the execution config. Do not first call the old owner's project-path mutation and then switch nodes: that mutates the wrong machine and creates an unnecessary compensation problem.

Preserve ledger-v5 ordering:

1. Acquire the existing reservation, validate the ownership epoch and idle/queue requirements, and close the outgoing controller producer lease.
2. Resolve the destination and inspect its project. Capture the ledger watermark and plan carryover. Failure before a durable decision keeps the source authoritative and reissues its producer binding when it is usable.
3. Verify the ledger checkpoint, then write the existing durable ownership decision with source node, destination node/config/path, and watermark.
4. Roll forward the registry and `agent-switch` boundary idempotently. Clear current native refs and rotate the ownership epoch; keep the same chat and transcript view. Complete the existing pending-ownership fence before opening the destination producer.
5. Dispatch the admitted prompt, or the next normal turn, through destination `execution.start()`. Never call destination `resume()` with a source-native reference.

If destination connectivity disappears after the decision, the target remains authoritative but unavailable. Controller-local roll-forward must not require a reachable worker to install that ownership. Producer binding can be reacquired on a later explicit execution. Do not reverse the committed handoff or automatically redispatch an uncertain prompt. Existing pre-dispatch versus unknown-dispatch rules still govern the admitted run.

Extend journal parsers, comparisons, request hashes, roll-forward, deletion reference routing, and prepared-carryover keys. Include destination node and ownership generation in any prepared context whose reuse could otherwise select a same-agent result for the wrong node. Existing records lacking node mean Local, without a migration rewrite. Journal recovery restores ownership only; it never replays user execution.

Extend the existing `agent-switch` row detail and renderer with optional `fromNodeId`/`toNodeId` so a same-agent cross-node boundary is intelligible. These are controller-authored metadata, not provider transcript semantics. Existing rows imply Local; no historical rewrite or SQLite schema migration is needed for optional JSON detail. Resolve labels for display, falling back to stable IDs if a former node was removed. Frozen projection, Reload, share/export, and carryover must preserve the boundary as they already do for agent changes.

Switching back is another new native session with ledger carryover. Reusing an older source session would require tracking and reconciling multiple native histories; that is deliberately not part of this stage.

## Failure And Operational Policy

| Condition | Behavior |
| --- | --- |
| Configured node has never connected | App and Local start; node stays offline; no invented catalog. |
| Authentication fails or URL is unreachable | Sanitized node-local error and bounded retry; other nodes unaffected. |
| Brief disconnect with retained continuity | Existing same-session replay; new calls unavailable; queued work waits. |
| Runtime restart, gap, replay exhaustion, or grace expiry | Existing fresh-session replacement; fail only affected active runs and fence their old producers. |
| Unknown dispatched call in a surviving logical session | No automatic retry, fallback, or replacement execution. Retain existing uncertainty semantics. |
| Node disappears during project inspection | No admission/dequeue and no local IO; report node unavailable. |
| Destination fails before handoff decision | Source remains owner. |
| Destination fails after handoff decision | Roll forward target ownership; remain unavailable or fail definite dispatch; never silently move back. |
| Controller restarts | Read config/chats/ledgers; start queues and execution state empty; no synthetic historical terminal or recovered work. |
| Remote native history is unavailable | Manual Reload fails without replacing the current view; readable controller transcript remains. |
| Unknown stored node ID | Show unavailable target; no Local fallback or deletion of the chat. |

Log node ID, connection direction, availability transitions, sanitized failure code, and serving generation where helpful. Do not add metrics infrastructure or log every retry/frame. Do not include secrets, full descriptors, prompts, or credentials in diagnostics. The existing manual transcript warning remains advisory; reconnect never invokes native Reload.

## Implementation Slices

Each slice should be a scoped commit with its own focused tests. Do not combine transport changes, ownership recovery, and frontend wiring into one review-sized diff.

### 1. Identity And Private Configuration

Add `common/execution-nodes.ts`, `server/execution-nodes/config-store.ts`, and `connection-url.ts` using the types/parser above. Add optional chat/settings/schedule node fields and serialization rules. Reject direct chat-node patching. Wire private CRUD independently of successful connection so the API can represent offline nodes.

Primary files: [registry-entry-codec.ts](../../server/chats/registry-entry-codec.ts), [store.ts](../../server/chats/store.ts), [settings.ts](../../common/settings.ts), [chat-list.ts](../../common/chat-list.ts), and new node routes. Test missing/null Local, remote round-trip, invalid IDs, duplicate secrets, permission checks, URL fragment stripping, credential redaction, and no local-field backfill. Add settings/node contracts on both server and client boundaries, not unchecked JSON casts.

### 2. Connection Lifecycle And Public Worker Mode

Refactor link listener ownership, role-specific hello, known-ID remote construction, candidate lifecycle initialization, fixed retries, and worker startup as described above. Add manager/config subscriptions and integrate the execution socket union in `server.ts`. A connected remote becomes ready only after describe and lifecycle; the controller process can serve Local before that.

Primary files: [websocket-link.ts](../../server/execution-nodes/websocket-link.ts), [session-transport.ts](../../server/execution-nodes/session-transport.ts), [remote.ts](../../server/execution-nodes/remote.ts), [worker-main.ts](../../server/execution-nodes/worker-main.ts), [main.ts](../../server/main.ts), and [controller-node.ts](../../server/execution-nodes/controller-node.ts). Test both directions, late first connection, authenticated ID assignment, two simultaneous inbound nodes, stale socket callbacks, initialization failure isolation, and worker shutdown before any connection. Preserve all replay/session-replacement regressions.

### 3. Runtime, Catalog, And Project Routing

Replace bare integration lookups with `AgentExecutionTarget`, single inspector injection with node-aware resolution, and global queue/loss gates with chat/node-qualified ones. Update model/auth/configuration routes, native-reference indexes, snippets/preambles, schedules, ticket defaults, and all ordinary command entry points. Local machine routes remain available with remote-target rejection.

Primary files: [registry.ts](../../server/agents/registry.ts), [runtime-router.ts](../../server/agents/runtime-router.ts), [catalog-service.ts](../../server/agents/catalog-service.ts), [project-admission.ts](../../server/projects/project-admission.ts), [project-resolution.ts](../../server/routes/project-resolution.ts), [queue-drainer.ts](../../server/chat-execution/queue-drainer.ts), and [server-event-wiring.ts](../../server/server-event-wiring.ts). Test Local plus two workers with colliding agent/native IDs, disjoint roots, separate credentials/catalogs, one-node loss, scoped queue wake-up, and restart with every remote offline while their saved chats/ledgers remain intact. Never use global map clear operations for one remote failure.

### 4. Dialog, Selector, And Manual Project UX

Add the node domain/API/dialog and shared selector field. Route node snapshots through the existing typed WS integration layer. Update New Chat, settings, sidebar labels/project grouping, recents, disabled remote file affordances, and node/path stale-response checks. Keep source-of-truth state in domain owners and callbacks in components.

Test adding/editing both connection types, URL copy/reveal/redaction, reconnect status, untouched Local usability, node-aware catalogs, path errors, and keyboard/button parity. For an existing chat, wire selection to the handoff request from slice 6; do not ship a temporary direct `nodeId` patch. Keep that affordance disabled until handoff is implemented.

### 5. One-Shot Selection

Update [generation-config-source.ts](../../server/settings/generation-config-source.ts), [generation-effective.ts](../../server/settings/generation-effective.ts), [generation-model-test.ts](../../server/settings/generation-model-test.ts), runtime single-query lookup, and the settings selector. Auto feeds only Local maps into existing choice logic; manual selection resolves the named node without requiring other nodes to be discoverable.

Test all four generation settings, explicit remote invocation, offline failure without remote-to-local fallback, Auto staying Local for a remote chat, and no working-directory argument. A remote generation test must include the existing provider-timeout-plus-transport-grace contract.

### 6. Cross-Node Ownership Handoff

Extend [agent-handoff-types.ts](../../server/agents/agent-handoff-types.ts), [agent-handoff-service.ts](../../server/agents/agent-handoff-service.ts), [agent-ownership-journal.ts](../../server/chats/agent-ownership-journal.ts), [agent-ownership-journal-format.ts](../../server/chats/agent-ownership-journal-format.ts), [prepared-carryover.ts](../../server/chats/prepared-carryover.ts), command contracts, and agent-switch row/projection/rendering. Add destination-path input to the existing handoff confirmation and enable composer node changes only when this path is complete.

Keep the existing checkpoint/journal decision boundary. Test same-agent cross-node transfer, destination-path installation, both crash sides of the decision, unavailable source, late old rows, uncertain destination start, switching back, and Reload preserving node-aware boundaries. Update the governing ledger design with this explicit ownership extension when implementing, without changing accepted restart losses.

### 7. Normal-Installation Acceptance And Legacy Cleanup

Adapt [execution-backend.ts](../../integration-tests/support/execution-backend.ts) to configure nodes through the management API and public worker mode. Remote fixtures must explicitly choose their node; otherwise omitted `nodeId` would accidentally test Local. Preserve unexpected-worker-exit assertions and isolated storage/ports. Exercise a compiled worker and normal browser onboarding, not only direct construction of test facades.

Remove the stage-1 all-or-nothing production configuration path once app routing is complete. If `GARCON_AGENT_EXECUTION_NODE_CONFIG` is still present, fail with an actionable setup message rather than silently interpreting a previously remote-only workspace as Local. There is no automatic import/migration of experimental unqualified remote chats. Use a fresh validation workspace; adopting old remote-native bindings would require an explicit separate operation, not guessing ownership from a path.

## Test Plan

Proposed files below are additions unless an existing file is linked. Use synthetic content/identities and isolated worker roots. Keep test concurrency bounded; no paid providers are required for this plan.

| Test file | Required cases |
| --- | --- |
| `common/__tests__/execution-nodes.test.js` | ID parsing, null/absent Local, unknown explicit node not falling back, node-qualified target/cache keys, public DTO excludes secrets. |
| `server/execution-nodes/__tests__/connection-url.test.ts` | Both descriptor paths, round-trip secret, duplicate/extra fragments, canonical 32-byte decoding, invalid protocol/userinfo/query, ws opt-in, no fragment in WebSocket URL or errors. |
| `server/execution-nodes/__tests__/config-store.test.ts` | Atomic persistence/private permissions, generated IDs/secrets, listener-secret reuse, duplicates, CRUD/reference conflicts, no Local record. |
| `server/execution-nodes/__tests__/manager.test.ts` | Local plus two late/offline nodes, independent initialization/lifecycle, candidate not ready early, disabled connector cleanup, no overlapping retry loops, stale callbacks ignored. |
| [websocket-link.test.js](../../server/execution-nodes/__tests__/websocket-link.test.js) and [session-replacement.test.ts](../../server/execution-nodes/__tests__/session-replacement.test.ts) | Authenticated controller ID assignment, wrong scope rejection, both directions, unchanged replay/fresh-session fencing, no re-dispatched mutation. |
| `server/chats/__tests__/execution-node-persistence.test.ts` | Old/missing/null field stays local without backfill; remote save/load; native ID collision by node; generic patch cannot move ownership. |
| `server/agents/__tests__/execution-node-routing.test.ts` | All operation facets resolve stored node; wrong-node refs reject; loss snapshots isolate runs, handles, permissions, producer leases, and queues. |
| `server/agents/__tests__/cross-node-handoff.test.ts` | Idle/queue guards, pre-decision failure, committed roll-forward with destination offline, node/path atomic config, prepared context identity, no native resume/transfer. |
| `server/settings/__tests__/generation-node-selection.test.ts` | Auto Local, explicit remote, no silent fallback, all four settings/test endpoints, provider owns invocation directory. |
| `integration-tests/tests/server/execution-node-app.test.ts` | Normal HTTP CRUD, Local + two real worker processes, both dial directions, late startup, restart/secret reuse, node-scoped loss, authenticated shared upgrades, saved remote chats/refs/ledgers surviving controller startup with all workers offline. |
| [execution-node-projects.test.ts](../../integration-tests/tests/server/execution-node-projects.test.ts) | Explicit node selection; same path text with different contents; invalid/symlink-escaped root; mentions from only selected worker; stale inspection; remote machine request rejected before local IO. |
| `integration-tests/tests/server/cross-node-handoff.test.ts` | Same-agent Local->remote->Local, fresh native sessions, source-offline ledger handoff, crash recovery, preserved rows/boundaries, no duplicate dispatch, no file copy. |
| `web/src/lib/execution-nodes/__tests__/execution-nodes-store.logic.test.ts` | Sanitized snapshots, remove/prune behavior, offline selection preservation, no secret-bearing fields stored. |
| `web/src/lib/components/execution-nodes/__tests__/ExecutionNodesDialog.test.ts` | Both onboarding forms, validation/loading/error/disabled states, copy/reveal, secret cleared on close, keyboard navigation, focus restoration. |
| `web/src/lib/components/model-selector/__tests__/node-selection.test.ts` | Node/agent/source/model keys, stale catalog results, same model on distinct nodes, Auto behavior, recents. |
| `integration-tests/tests/e2e/execution-nodes.test.ts` | Browser onboarding with isolated worker, manual remote path, chat/send/Stop/Reload, one-shot test, remote browse disabled, Local file/terminal still work. |

A representative routing assertion for the real-process fixture is:

```ts
// Fixture helpers are added in execution-node-app.test.ts/support.
const { controller, workerA, workerB } = await fixture.startLocalAndTwoWorkers();
const chatA = await controller.createChat({ nodeId: workerA.nodeId, projectPath: workerA.projectPath });
const chatB = await controller.createChat({ nodeId: workerB.nodeId, projectPath: workerB.projectPath });
await fixture.startHeldTurns(chatA.id, chatB.id);
await workerA.crashExpected();
await fixture.waitForFailedRun(chatA.id, 'OUTCOME_UNKNOWN');
expect(await controller.isProcessing(chatB.id)).toBe(true);
expect(workerB.observedStartCount(chatB.id)).toBe(1);
await fixture.releaseTurn(chatB.id);
```

This sketch specifies the required observation, not an existing helper API. Implement it using the current Garcon process/client and scripted-model harness rather than provider calls mocked entirely inside core. Update contract tests for every changed HTTP/WS payload and both parser/sender paths.

### Validation Commands

Run focused suites per slice, then the full repository gates. Commands below are for implementation, not a requirement to rerun application suites for this documentation-only change:

```sh
bun scripts/run-test-files.js 'server/execution-nodes/__tests__/*.{test.js,test.ts}'
bun run --cwd web i18n:compile
bun run check
bun run test
bun run test:integration:server
bun run test:integration:e2e
GARCON_TEST_EXECUTION_BACKEND=in-process bun run --cwd integration-tests test:sacs
GARCON_TEST_EXECUTION_BACKEND=remote-controller-dials bun run --cwd integration-tests test:sacs
GARCON_TEST_EXECUTION_BACKEND=remote-node-dials bun run --cwd integration-tests test:sacs
bun run build
bun run build-exe:compile
bun run build-exe:smoke:linux-x64
timeout 30s bun run start --port 0 --bind-address 0.0.0.0
```

Verify the final bounded startup reaches readiness; a timeout after healthy startup is expected, a compile/startup failure is not. Use a separate workspace/port, never the user's running server. Extend executable smoke coverage to worker mode and its full-URL argument. The existing scripted roster remains Claude, Codex, OpenCode on Linux, Pi, and the three Direct integrations; conformance covers all shipped integrations, not equal live behavioral evidence. Cursor remains unit-only. No paid/live gate is claimed by passing these checks.

Manual acceptance: add one inbound and one outbound node through the dialog, restart each side independently, use Local while both are offline, create a remote chat with a typed path, verify `@file` contents, choose a remote one-shot model, move an idle chat to the other node, and Reload explicitly. Rapidly switch Local/remote chats while queues/status change; check composer stability, focus, scroll, mobile layout, and identical click/Enter submission gates.

## Rollout And Deferred Decisions

No Local chat migration and no provider-native data migration. New fields are optional in persisted data, but controller, browser, and workers are upgraded together. The changed handshake is not compatible with older running peers; retire/restart them rather than negotiate multiple wire generations. Back up the validation workspace before switching from experimental stage-1 remote-only composition. Downgrade is not a safe way to interpret remote chat fields; use the matching build or restore the pre-test workspace backup.

No new third-party runtime dependency is needed. The work reuses existing node/RPC/project/handoff contracts and Svelte components. The stage-1 [prior-art and replay rationale](./interface.md#transport-and-replay) still applies; this stage changes listener ownership and routing, not receipt semantics.

No blocking product question remains for this proposal. The choices deliberately made to keep it bounded are manual remote paths, fixed background retries, one controller relationship per worker, same-build peers, explicit node selection, local Auto, fresh-session handoff, and best-effort cleanup. Public hostname/TLS deployment is operator configuration: editable advertised URLs and a clear placeholder work for this stage; automatic discovery and certificate management wait for a separate need.

Revisit only when a real workflow requires remote browsing, file transfer, sharing one worker across controllers, stronger orphan fencing, or an agent-spawned remote CLI bridge. None should be smuggled into this implementation as a prerequisite for using remote chat execution.
