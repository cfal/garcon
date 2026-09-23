# Custom Providers On Execution Nodes

Status: proposed architecture and implementation scope, 2026-09-23. Node-specific provider assignments are not implemented. Source inspection and Oracle consultation used [9f0020dc9d25f3f7d354df8d8e34baae8c477e26](https://github.com/cfal/garcon/tree/9f0020dc9d25f3f7d354df8d8e34baae8c477e26). Migration and multi-controller decisions are called out below rather than treated as already approved.

This extends [Execution Nodes In The App](./execution-node/app-integration.md) and the [node interface](./execution-node/interface.md). It changes custom-provider availability policy, not where agents execute or how the controller connects to a worker.

## Objective

Allow each execution node to use an explicit set of custom provider configurations while retaining controller-owned configuration and credential storage.

A custom provider profile is a concrete account and endpoint configuration, not a provider brand. Two profiles may use the same service with different accounts, addresses, or models. The same profile may also be deliberately shared by multiple nodes when all of those settings should be identical.

Examples:

```text
Controller-stored profiles:
  Work OpenRouter     -> work account, work key, selected model list
  Personal OpenRouter -> personal account, personal key, selected model list
  GPU Ollama          -> http://localhost:11434, GPU host's model list

Assignments in one workspace:
  Local    -> Personal OpenRouter
  Worker A -> Work OpenRouter
  GPU box  -> Work OpenRouter, GPU Ollama
```

`localhost`, DNS resolution, private IP reachability, TLS trust, and outbound IP belong to the executing node. Assigning a profile does not rewrite its URL, change the node's network, or make an unreachable endpoint reachable.

## Scope And Decisions

- Keep custom provider profiles and API keys on the controller.
- Add explicit workspace-local assignments from execution nodes to provider profiles, including Local.
- Assign whole profiles. Their protocol endpoints inherit availability; endpoints are not node-specific variants.
- Use different profiles when URL, account/key, headers, capabilities, defaults, or saved model inventory must differ.
- Do not add per-node field overrides, inheritance, implicit cloud-provider sharing, or a new binding identifier.
- Apply the same policy to Local and remote execution, including one-shot generation.
- Preserve native managed-agent authentication and configuration on the node. This does not centralize OAuth state or add custom-endpoint support to integrations that lack it.
- Reuse the existing shared Noise WebSocket, endpoint-selection DTO, and reverse credential RPC. No new channel, scheduler, worker configuration store, or whole-store replication is needed.

Provider assignments are configuration, not an execution queue. Nothing is replayed from them at startup. Cross-node repository movement, CLI bridging, and stronger per-chat worker isolation remain separate work.

## Current Behavior

Remote custom-provider execution already exists. The missing feature is scope, not configuration forwarding:

1. The controller resolves the selected provider, endpoint, and model from its global store.
2. [Execution planning](../server/agents/execution-planning.ts) constructs an `AgentEndpointSelection` containing provider/endpoint IDs, label, URL, protocol, selected model, local-model classification, capabilities, headers, and a credential reference.
3. [Runtime routing](../server/agents/runtime-router.ts) includes that selection in execution requests. The remote integration forwards it to the chosen node.
4. The worker resolves the reference through `credentials.resolve` on the same authenticated connection. The controller returns the stored key.
5. The node's integration configures its runtime and contacts the endpoint from that node.

The full stored provider object is not sent in the startup frame. Execution metadata is sent with the request; credentials are resolved separately. Management metadata, discovery preferences, and the complete saved model list stay controller-owned.

| Area | Existing behavior and required change |
| --- | --- |
| [Provider store](../server/api-providers/store.ts) | `getConfigDir()/api-providers.json`, atomic `0600` writes, global provider and endpoint IDs, no node scope. Retain profile ownership here. |
| [Node configuration](../server/execution-nodes/config-store.ts) | `workspaceDir/execution-nodes.json`. Node IDs identify configured trust relationships within a workspace. Assignments must respect this ownership. |
| [Endpoint resolver](../server/api-providers/endpoint-resolver.ts) | Resolves every profile without node context. Add explicit node-qualified availability checks. |
| [Agent catalog](../server/agents/catalog-service.ts) | Native discovery is node-qualified, but the same custom endpoint models are merged into every compatible node catalog. Filter through assignments. |
| [Controller composition](../server/server.ts) | Credential resolution looks up provider/endpoint IDs globally; protocol support for the resolver comes from Local's integration registry. Bind credentials to the actual caller node and use the selected integration descriptor. |
| [Provider service](../server/api-providers/service.ts) | Test and Fetch Models already run on a selected node; saved-key lookup is global. Enforce scope before resolving or sending saved credentials. |
| [Provider settings](../web/src/lib/components/settings/Settings.svelte) | Node selection exists, but profile mutations remain global and provider management is gated on node readiness. Separate offline-editable configuration from live auth/testing. |
| Catalog caches | Server and browser caches are already node-qualified. Assignment and shared-profile changes must invalidate them without making cache freshness an authorization mechanism. |

## Ownership And Data Model

Retain `StoredApiProvider` as the profile record. Keep stable provider and endpoint IDs so chats, schedules, generation settings, and recents do not need new routing identities.

Add a small controller-side workspace assignment store, for example `workspaceDir/api-provider-assignments.json`:

```ts
interface ApiProviderAssignmentSnapshot {
  version: 1;
  revision: number;
  assignments: Record<string, string[]>; // Validated node IDs to provider IDs.
}
```

The file contains IDs only, not copied endpoint configuration or keys. `local` is an ordinary assignment key. Labels are never identity. Missing membership means unavailable, not inheritance from Local or all nodes.

Validate the complete file before publication: version, revision, node/provider ID syntax, object shape, duplicate entries, and bounded collection sizes. Corrupt or unreadable assignment state must fail closed for custom-provider use and surface a configuration error. It must never trigger the legacy grant-all migration.

Syntactically valid references to removed profiles or unknown nodes do not grant anything. Preserve or report unresolved references without converting them to Local. Node existence and profile existence are checked again when admitting use. Unknown-node assignments can be pruned during explicit node cleanup.

Use the existing atomic JSON helper and serialized mutation patterns. Publish the new in-memory snapshot only after durable write completion. Failed or uncertain mutations cannot be reported as successful. If a write outcome is uncertain, make the affected policy unavailable until reconciliation establishes the stored result; do not claim either a completed grant/revocation or definite no-change. Use `0600` for consistency with other private controller configuration.

### Management Versus Selection

Separate the global redacted management list from the selected node's execution catalog:

- Management lists existing profiles, including unassigned profiles, so the user can assign one without recreating it. Raw keys remain write-only in browser APIs.
- Selection lists only profiles assigned to the selected node and models supported by the selected integration.
- Historical display can retain an unavailable profile/model reference. Historical display is not permission to execute it.

Do not solve this by deleting unassigned profiles from a shared browser store or by hiding them only in the picker. All server selection paths must use the same policy.

### Explicit Configuration Revisions

Add a persisted monotonic configuration revision to each profile, incremented on mutation. Capture it when resolving endpoint metadata and include it in the credential reference. A timestamp or API-key display label is not a revision.

The profile/endpoint identity and revision are checked again before releasing a credential. A changed profile rejects the stale resolution; it must not combine an earlier URL with a newly changed key. Build an execution selection from one captured profile snapshot rather than performing unrelated metadata lookups around asynchronous work.

The revision is non-secret and may be included in redacted DTOs and catalog identity. It is not a new durable binding or per-run capability. Assignment availability remains a separate live check, even when the profile revision is unchanged.

## Admission And Credential Release

Introduce one narrow provider-access policy used by resolver, service, runtime, and credential boundaries. It accepts the effective node, provider/endpoint identity, and relevant integration context. Avoid several independently implemented allow-list interpretations.

For custom endpoint use, enforce:

1. The node exists and is the intended target. Live execution additionally requires readiness; editing assignments does not.
2. The profile exists and is assigned to that node.
3. The endpoint belongs to that profile.
4. The selected node's integration supports the endpoint protocol and capabilities.
5. The requested model and configuration are valid for that endpoint.
6. The captured profile revision remains valid where metadata and credentials are joined.

Omitted node identity may mean Local only at an intentional API default. Internal custom-provider resolution should receive an explicit effective node. An explicit invalid/offline remote never falls back to Local.

### Execution Entry Points

| Path | Required behavior |
| --- | --- |
| Start, resume, queued dequeue, steering that starts new execution | Validate the durable target and current assignment, not a browser catalog snapshot. Recheck after asynchronous preparation immediately before dispatch. |
| Fork and compaction | Validate custom endpoint use on the owning node. Do not accidentally grant source credentials to a different node. |
| Agent/model changes | Validate the replacement node/profile. Invalid previous selections must remain repairable. |
| Cross-node handoff | Validate the destination profile before the durable ownership decision and again at execution. Failure after ownership commits does not reverse ownership or select another account. |
| One-shot generation | Titles, commit messages, refinement, test calls, and other single queries obey the same assignment rules on the generation node. Auto retains its existing Local semantics. The repository node is not necessarily the generation node. |
| Configuration validation | Run common provider-access checks before an optional integration-specific validation facet. A null facet must not bypass policy. |
| Catalog/readiness/image support | Use the selected node throughout, including `hasEndpointModels`, endpoint model enumeration, and image capability checks. |

An explicit incomplete provider/endpoint selection is invalid; it must not become native execution merely because the model string is missing. Keep provider support behind existing nullable integration facets.

Do not authorize the previous selection while merely reading it to compare with a proposed replacement. [Session settings](../server/agents/session-settings-service.ts) currently resolve the previous endpoint first. Separate historical lookup from replacement authorization so removal of an assignment does not prevent repairing that chat. Preserve existing local-model/cloud-model switching restrictions where they can be established; do not infer unknown historical classification as cloud or silently bypass those restrictions.

### Reverse Credential RPC

[The node manager](../server/execution-nodes/manager.ts) already knows which authenticated connection made `credentials.resolve`. Capture that node identity in the credential resolver. Do not accept a worker-supplied node ID as authorization. Apply the same check to Local through [integration-host composition](../server/agents/integration-host.ts).

Retain current connection/serving-session checks and abort fencing. Credential release requires the current profile assignment, matching provider/endpoint IDs, and matching profile revision. Existing integration identity checks remain in force.

Access denial, missing explicit profiles, and stale configuration must throw typed errors. [The shared endpoint resolver](../server-agents/common/src/execution/resolve-endpoint.ts) currently converts a null credential result to keyless execution; do not use that behavior for denied custom-provider access. A deliberately configured empty key, as with an unauthenticated local endpoint, remains valid and distinct from denial. Native execution with no endpoint remains valid as well.

Assignments grant a trusted worker access to a profile's credentials, not only to the credentials of one chat. The current reverse request has no chat/run authorization context. Per-run credential capabilities are not required for this scope and must not be implied by the UI.

### Testing And Model Discovery

Keep Test and Fetch Models on the selected node. For a saved credential:

- Check assignment before retrieving the key or dispatching a discovery request.
- Require the endpoint to belong to the supplied profile; reject mismatched IDs rather than searching another profile.
- Retain the existing URL-origin check. An edited destination must not receive an unrelated saved key.
- Check revision/context again before sending the request after any awaited preparation.

Same-origin checks are insufficient across nodes: two workers can both use `http://localhost:11434` while reaching different services.

Testing an unsaved configuration with an explicitly entered key is an intentional disclosure to the selected node. It does not create a persistent assignment. Testing with a saved key requires assignment first. The dialog must make that distinction clear rather than silently borrowing credentials from an unassigned profile.

Discovery results remain draft data until Save. Saving a model list changes the shared profile for all assigned nodes; if inventories should differ, use separate profiles. Fence responses by selected node, profile/endpoint, request generation, and captured edit context so stale results cannot overwrite another node's form or later user edits.

## Configuration Lifecycle

### Assign, Unassign, And Create

Expose specific assign/unassign commands, not browser-side replacement of the complete assignment map. Repeated assignment/removal is idempotent. Preserve changes to other nodes and profiles under concurrent requests.

Assignments can be edited for configured offline or disabled nodes. Use configuration existence, not remote discovery, as the write precondition. An enabled assignment does not imply the endpoint is reachable.

Serialize assignment changes and profile deletion through a shared controller-side mutation boundary. Retain node references through assignment publication using the existing [reference-write mechanism](../server/execution-nodes/reference-writes.ts), so a node cannot be deleted between validation and durable publication. Do not introduce a second conflicting node-lock scheme.

Create-and-assign touches the global profile file and the workspace assignment file. It need not become a new multi-file transaction journal. Persist the profile first, then assign it. If assignment fails before publication, retain an unassigned profile and return an explicit partial outcome with its redacted ID so the UI can retry assignment without creating another profile. Report an uncertain assignment outcome separately and reconcile it before retrying. Do not automatically delete a profile that another action may already have assigned. Never authorize optimistically before durable publication.

Unassignment is allowed even when saved selections reference the profile. Preserve those selections and show unavailable status; do not erase chats, schedules, generation configuration, or draft text. Queued work must revalidate and report configuration failure rather than running with another account. Reassignment restores eligibility, not automatic replay of previously failed or uncertain execution.

### Shared Edits And Deletion

Editing a shared profile affects every assignment. Key rotation can update the same profile. A different account or destination should normally be a separate profile, selected explicitly. Do not hot-swap admitted execution into a different account.

Before profile deletion, check current-workspace durable selections, including chats, scheduled new chats, saved generation/default selections, and relevant in-progress ownership decisions. Treat recents and historical transcript labels as soft references, not perpetual deletion blockers. Make replacement/unassignment and global deletion separate operations with explicit impact.

The current deletion callback checks only current-workspace chats. That is not global referential integrity: other workspaces can share the same profile store. Do not report "unused everywhere" from a local check. Global deletion semantics and concurrent-controller visibility must follow the explicit deployment decision below. References that can no longer resolve must fail closed and remain repairable, never be redirected to a same-label profile.

### Node Removal And Restart

Saved chats, schedules, and settings do not block node deletion; preserve their selections as unavailable without fallback. Keep temporary guards for active execution, unfinished ownership changes, and in-flight reference publication. Assignments likewise must not make a node permanently undeletable: remove its assignments as part of cleanup, not the global profiles.

Unknown/deleted nodes cannot authorize use even if a stale assignment survives a failed cleanup write. Make cleanup idempotent across restart. A new node with the same label but a different UUID receives no assignments. Disable/reconnect retains assignments without granting execution while the node is unavailable.

Persist assignment mutations and profile revisions, not credential-resolution results or execution admissions. Reconnect uses the current controller policy. Previously admitted runtime state may still retain credentials.

## API And UI Work

Keep profile CRUD under `/api/v1/api-providers`. Add a redacted management read separate from `/api/v1/models?nodeId=...`. The latter exposes only that node's selectable profiles and compatible model options.

Add typed assignment reads and narrow mutations, for example:

```text
GET    /api/v1/api-provider-assignments?nodeId=<id>
PUT    /api/v1/api-provider-assignments?nodeId=<id>&apiProviderId=<id>
DELETE /api/v1/api-provider-assignments?nodeId=<id>&apiProviderId=<id>
```

Exact route naming is an implementation detail; the separation between profile mutation and assignment mutation is not. Validate all IDs and payloads at both HTTP and RPC boundaries. Return typed unavailable-on-node, stale-configuration, and reference-conflict outcomes using the existing domain/agent error translation, not generic 500s or null credentials.

Provider settings should support:

- The existing node selector and a list of profiles assigned to that node.
- Add profile, defaulting assignment to the current node only.
- Use existing profile, showing redacted global definitions.
- Explicit assignment controls labeled as availability within the current workspace.
- Duplicate profile for an independent configuration. Do not return the original key to the browser; either require a new key or copy it server-side only after explicit user intent.
- Test from the selected node and clear offline/testing states.
- Remove from node separately from Delete shared profile.
- Shared-edit impact and the fact that an assigned worker can receive the API key.

Configuration management must work while a node is offline. Native login, live discovery, and test actions can remain readiness-gated. Do not wait for every node at settings startup.

Keep reusable assignment state in a domain-owned store/service and HTTP/WS adaptation in the integration layer. Svelte components render that state; they do not merge whole persisted maps. Preserve existing request-version guards and no-remount chat behavior.

### Invalidation And Unavailable Selections

After an assignment mutation, invalidate the affected node's server and browser catalogs. After a shared profile mutation, invalidate every potentially affected catalog; conservative all-node invalidation is acceptable initially. Preserve existing request fencing so an older in-flight load cannot reinstall removed choices.

Notify other connected browser clients, not only the initiating dialog. A typed profile/assignment-change notification can carry affected node IDs and non-secret revisions; it must never contain keys. Management state and selector catalogs refresh independently. On browser reconnect, reconcile current configuration even if the worker connection never changed.

Clear or stale persisted catalog snapshots as well as instantiated stores. Refresh visible consumers on demand. Preserve saved unavailable selections and user text; New Chat, scheduled submission, active-chat controls, keyboard shortcuts, and plan approval must share admission rules. Client cache validation improves UX but never grants server-side authority.

## Migration

Recommended default, pending product confirmation: preserve the availability that existing users already have, but only through an explicit one-time migration.

1. When upgrading the global provider-store schema, capture the IDs of profiles that existed under the legacy global policy. Persist that seed atomically with initial profile revisions. Profiles created afterward must not enter the seed.
2. Add an ordered [workspace migration](../server/migrations/README.md) for existing workspaces. Materialize assignments from that legacy seed to Local and the workspace's already-configured remote nodes, including offline/disabled nodes. Use persisted topology, not successful connections.
3. Persist the assignment file before marking migration complete. Reruns must preserve an already-written assignment snapshot, not re-grant membership after a later unassignment. Preserve provider/endpoint IDs and existing saved selections.
4. Fresh workspaces skip the legacy grant, using the existing migration runner's fresh-workspace distinction. New profiles and nodes require explicit assignment.

The legacy seed matters because an old workspace may first be opened after new profiles have been created in the global store. Assigning all profiles present at that later startup would silently grant newly introduced accounts.

Install a fail-closed policy before remote credential requests can be served. Do not expose a permissive window while migrations run, and do not block startup on an offline node. After migration, a missing or corrupt assignment file is an error/empty authorization state, not grounds to repeat the legacy grant. Migration metadata is not a permanent wildcard.

No chat-registry routing rewrite is required. Existing node/provider/endpoint IDs retain their meaning. Unknown profiles/nodes remain explicit unavailable selections. Do not rewrite them to native auth or clear unrelated user settings.

## Trust And Operational Limits

Controller persistence is not exclusive controller possession. Workers receive keys over Noise and provider runtimes may retain them in memory or process environments. Do not log keys, credential-bearing headers, whole RPC payloads, or secret-dependent revision hashes.

Unassignment blocks subsequent admissions and credential releases. It cannot erase a previously disclosed key or guarantee that admitted native work stops. Strong revocation requires rotation at the upstream provider. This scope does not introduce a distributed cancellation/revocation protocol.

### Concurrent Controllers: Open Decision

Different workspaces may point at the same global config directory. `ApiProviderStore` currently caches reads and uses a process-local write lock. Atomic rename does not serialize writers across controller processes, and invalidation broadcasts do not reach another controller.

Before implementation, choose and document one supported policy:

- A single writer owns shared profile configuration; other controllers reload/restart to observe external edits. This needs an enforceable writer restriction or explicit operational constraint, not an implication that the current lock is cross-process.
- Concurrent writers are supported with config-directory-wide mutation serialization, revision checks, and an explicit reload/invalidation policy. A filesystem watcher alone does not prevent lost writes. Immediate global revocation would require stronger freshness than periodic reload.

Do not promise immediate cross-controller edit, deletion, or rotation visibility without implementing it. Workspace-local assignments do not require a distributed store. The initial recommendation is to avoid adding a cross-controller coherence protocol unless concurrent editing is a required workflow, while clearly limiting the supported shared-store behavior.

Global deletion must likewise distinguish known current-workspace references from references in other workspaces. If exhaustive global protection is required, it needs an authoritative workspace/reference inventory; a best-effort scan of conventional directories cannot discover arbitrary `--workspace-dir` locations. Otherwise require explicit global impact acknowledgement and preserve unavailable-reference behavior in other workspaces.

## Implementation Boundaries

| Slice | Principal work |
| --- | --- |
| Contracts and persistence | Extend [shared provider contracts](../common/api-providers.ts) and [credential references](../common/agent-execution.ts); add profile revisions, workspace assignments, strict parsing, migration, and atomic writes. |
| Resolution and catalogs | Make [endpoint resolution](../server/api-providers/endpoint-resolver.ts), [catalog service](../server/agents/catalog-service.ts), [registry readiness](../server/agents/registry.ts), [model routes](../server/routes/models.ts), [agent routes](../server/routes/agents.ts), [catalog cache](../server/routes/model-catalog-cache.ts), and [delegated start selection](../server/agents/agent-start-selection-service.ts) node-aware for custom providers. |
| Admission and credentials | Update [runtime routing](../server/agents/runtime-router.ts), [settings validation](../server/agents/session-settings-service.ts), [handoff](../server/agents/agent-handoff-service.ts), [endpoint planning](../server/agents/execution-planning.ts), node manager/host composition, and shared credential resolution. Keep provider-specific execution behind existing integration contracts. |
| Management and discovery | Extend [provider service](../server/api-providers/service.ts), [HTTP routes](../server/routes/api-providers.ts), typed notifications, node-removal cleanup, and reference/deletion checks. |
| Browser | Extend [provider API](../web/src/lib/api/api-providers.ts), [catalog store](../web/src/lib/agents/model-catalog-store.svelte.ts), settings composition, and [endpoint dialog state](../web/src/lib/components/settings/api-provider-endpoint-dialog-state.svelte.ts). Add assignment management without duplicating the existing model selector. |

This is a bounded but cross-cutting change, not a transport rewrite. The configuration relation is small; consistent enforcement, repair paths, migration, and tests account for most of the work. The consultation estimate was roughly three to five focused engineering days, excluding any newly required cross-controller coherence system.

## Verification Criteria

Use synthetic endpoints and credentials, real public controller/worker startup, and both connection directions. No paid provider calls or real account credentials are needed.

- Store tests: assign/unassign idempotency, concurrent field-level changes, failed and uncertain writes, malformed schema, unresolved IDs, profile revisions, offline-node editing, and node deletion during assignment publication.
- Migration tests: existing/fresh workspaces, Local and offline nodes, stable provider IDs, crash reruns, missing/corrupt post-migration state, later-created profiles excluded from an older workspace's migration, and newly created nodes receiving no grants.
- Resolver/catalog tests: Local versus two remote nodes; identical URLs/model names with different profiles; whole-profile endpoint inheritance; selected-node protocol/capability differences; image support and readiness; global management visibility versus filtered selection visibility.
- Credential tests: a worker requesting an unassigned profile, forged node identity, mismatched provider/endpoint IDs, stale session, profile revision change between metadata and key lookup, assignment removal during preparation, intentional empty keys, and denied lookup never becoming keyless/native execution.
- Discovery tests: both remote connection directions, saved-key assignment checks, unsaved explicit-key tests, URL-origin changes, same `localhost` on different node contexts, and stale replies after node/profile/form changes. Use isolated worker/network contexts or a deterministic node-side probe when both fixtures run on one host.
- Execution tests: start/resume, queued dequeue, compaction, fork, handoff, every generation caller, optional configuration-validation facets, and explicit incomplete selections. Verify no request reaches an unassigned endpoint and no request falls back to Local/native/another account.
- Lifecycle tests: preserve invalid saved targets, repair a chat after unassignment, schedule/generation failure without data loss, unassignment versus admitted work, node deletion cleanup, and profile deletion/reference-publication interleavings.
- Browser tests: add/use existing/duplicate/remove, offline configuration, shared edit impact, model selection, multiple connected clients, persisted catalog invalidation, deferred stale responses, all submit paths, and retained draft text. Rapidly switch nodes/chats without remounting heavy chat UI or moving focus/scroll unexpectedly.
- Deployment tests: exercise whichever shared-config writer/reload policy is selected. Never infer multi-controller safety from single-process unit tests.

Extend the existing suites under `server/api-providers/__tests__`, `server/execution-nodes/__tests__`, and provider-settings/catalog frontend tests. Add black-box coverage under `integration-tests/tests/server` and browser workflow coverage under `integration-tests/tests/e2e`. Test the common denial/selection logic independently as well as through HTTP, RPC, and persistence boundaries.

Implementation gates are `bun run check`, `bun run test` with applicable web coverage, focused integration/browser suites, and a timed fresh `bun run start --port 0` startup check. This document does not claim those implementation gates have run.

## Decisions Before Implementation

- Confirm preserving legacy availability through explicit migration versus requiring all remote assignments to be made again. Preservation is the recommendation, not a permanent default grant.
- Confirm the node-level credential trust and prospective unassignment semantics; stronger per-run isolation/revocation would expand scope.
- Decide shared-config concurrent-writer, external-edit visibility, and global deletion guarantees before implementing persistence lifecycle around them.

Field overrides, account selection by implicit node fallback, per-run credential capabilities, worker-side configuration replication, and distributed revocation remain out of scope.
