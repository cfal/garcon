# Custom Providers On Executors

Status: implemented architecture, 2026-09-24. One controller owns its configuration directory and workspace. Executor-specific assignments, legacy-seed migration, mutation invalidation, and explicit shared-deletion acknowledgement are implemented. Original design research used [9f0020dc9d25f3f7d354df8d8e34baae8c477e26](https://github.com/cfal/garcon/tree/9f0020dc9d25f3f7d354df8d8e34baae8c477e26); the decisions below describe the resulting implementation.

This extends [Executors In The App](./executor/app-integration.md) and the [executor interface](./executor/interface.md). It changes custom-provider availability policy, not where agents execute or how the controller connects to a worker.

## Objective

Allow each executor to use an explicit set of custom provider configurations while retaining controller-owned configuration and credential storage.

A custom provider profile is a concrete account and endpoint configuration, not a provider brand. Two profiles may use the same service with different accounts, addresses, or models. The same profile may also be deliberately shared by multiple executors when all of those settings should be identical.

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

`localhost`, DNS resolution, private IP reachability, TLS trust, and outbound IP belong to the executing executor. Assigning a profile does not rewrite its URL, change the executor's network, or make an unreachable endpoint reachable.

## Scope And Decisions

- Keep custom provider profiles and API keys on the controller.
- Add explicit workspace-local assignments from executors to provider profiles, including Local.
- Assign whole profiles. Their protocol endpoints inherit availability; endpoints are not executor-specific variants.
- Use different profiles when URL, account/key, headers, capabilities, defaults, or saved model inventory must differ.
- Do not add per-executor field overrides, inheritance, implicit cloud-provider sharing, or a new binding identifier.
- Apply the same policy to Local and remote execution, including one-shot generation.
- Preserve native managed-agent authentication and configuration on the executor. This does not centralize OAuth state or add custom-endpoint support to integrations that lack it.
- Reuse the existing shared Noise WebSocket, endpoint-selection DTO, and reverse credential RPC. No new channel, scheduler, worker configuration store, or whole-store replication is needed.

Provider assignments are configuration, not an execution queue. Nothing is replayed from them at startup. Cross-executor repository movement, CLI bridging, and stronger per-chat worker isolation remain separate work.

## Prior Behavior

Before executor assignments, remote custom-provider execution already forwarded configuration and credentials. The implementation retains this flow and adds executor-qualified admission:

1. The controller resolves the selected provider, endpoint, and model from its global store.
2. [Execution planning](../server/controller/agents/execution-planning.ts) constructs an `AgentEndpointSelection` containing provider/endpoint IDs, label, URL, protocol, selected model, local-model classification, capabilities, headers, and a credential reference.
3. [Runtime routing](../server/controller/agents/runtime-router.ts) includes that selection in execution requests. The remote integration forwards it to the chosen executor.
4. The worker resolves the reference through `credentials.resolve` on the same authenticated connection. The controller returns the stored key.
5. The executor's integration configures its runtime and contacts the endpoint from that executor.

The full stored provider object is not sent in the startup frame. Execution metadata is sent with the request; credentials are resolved separately. Management metadata, discovery preferences, and the complete saved model list stay controller-owned.

| Area | Pre-assignment behavior and implemented change |
| --- | --- |
| [Provider store](../server/controller/api-providers/store.ts) | `getConfigDir()/api-providers.json`, atomic `0600` writes, global provider and endpoint IDs, no executor scope. Retain profile ownership here. |
| [Executor configuration](../server/controller/executors/config-store.ts) | `workspaceDir/executors.json`. Executor IDs identify configured trust relationships within a workspace. Assignments must respect this ownership. |
| [Endpoint resolver](../server/controller/api-providers/endpoint-resolver.ts) | Resolves every profile without executor context. Add explicit executor-qualified availability checks. |
| [Agent catalog](../server/controller/agents/catalog-service.ts) | Native discovery is executor-qualified, but the same custom endpoint models are merged into every compatible executor catalog. Filter through assignments. |
| [Controller composition](../server/controller/server.ts) | Credential resolution looks up provider/endpoint IDs globally; protocol support for the resolver comes from Local's integration registry. Bind credentials to the actual caller executor and use the selected integration descriptor. |
| [Provider service](../server/controller/api-providers/service.ts) | Test and Fetch Models already run on a selected executor; saved-key lookup is global. Enforce scope before resolving or sending saved credentials. |
| [Provider settings](../web/src/lib/components/settings/Settings.svelte) | Executor selection exists, but profile mutations remain global and provider management is gated on executor readiness. Separate offline-editable configuration from live auth/testing. |
| Catalog caches | Server and browser caches are already executor-qualified. Assignment and shared-profile changes must invalidate them without making cache freshness an authorization mechanism. |

## Ownership And Data Model

Retain `StoredApiProvider` as the profile record. Keep stable provider and endpoint IDs so chats, schedules, generation settings, and recents do not need new routing identities.

Add a small controller-side workspace assignment store, for example `workspaceDir/api-provider-assignments.json`:

```ts
interface ApiProviderAssignmentSnapshot {
  version: 1;
  revision: number;
  assignments: Record<string, string[]>; // Validated executor IDs to provider IDs.
}
```

The file contains IDs only, not copied endpoint configuration or keys. `local` is an ordinary assignment key. Labels are never identity. Missing membership means unavailable, not inheritance from Local or all executors.

Validate the complete file before publication: version, revision, executor/provider ID syntax, object shape, duplicate entries, and bounded collection sizes. Missing, corrupt, or unreadable post-migration assignment state stops controller startup with a configuration error. It never triggers the legacy grant-all migration. An uncertain runtime write makes assignments unavailable until the controller is restarted after configuration repair.

Syntactically valid references to removed profiles or unknown executors do not grant anything. Preserve or report unresolved references without converting them to Local. Executor existence and profile existence are checked again when admitting use. Unknown-executor assignments can be pruned during explicit executor cleanup.

Use the existing atomic JSON helper and serialized mutation patterns. Publish the new in-memory snapshot only after durable write completion. Failed or uncertain mutations cannot be reported as successful. If a write outcome is uncertain, make the affected policy unavailable until reconciliation establishes the stored result; do not claim either a completed grant/revocation or definite no-change. Use `0600` for consistency with other private controller configuration.

### Management Versus Selection

Separate the global redacted management list from the selected executor's execution catalog:

- Management lists existing profiles, including unassigned profiles, so the user can assign one without recreating it. Raw keys remain write-only in browser APIs.
- Selection lists only profiles assigned to the selected executor and models supported by the selected integration.
- Historical display can retain an unavailable profile/model reference. Historical display is not permission to execute it.

Do not solve this by deleting unassigned profiles from a shared browser store or by hiding them only in the picker. All server selection paths must use the same policy.

### Explicit Configuration Revisions

Add a persisted monotonic configuration revision to each profile, incremented on mutation. Capture it when resolving endpoint metadata and include it in the credential reference. A timestamp or API-key display label is not a revision.

The profile/endpoint identity and revision are checked again before releasing a credential. A changed profile rejects the stale resolution; it must not combine an earlier URL with a newly changed key. Build an execution selection from one captured profile snapshot rather than performing unrelated metadata lookups around asynchronous work.

The revision is non-secret and may be included in redacted DTOs and catalog identity. It is not a new durable binding or per-run capability. Assignment availability remains a separate live check, even when the profile revision is unchanged.

## Admission And Credential Release

Introduce one narrow provider-access policy used by resolver, service, runtime, and credential boundaries. It accepts the effective executor, provider/endpoint identity, and relevant integration context. Avoid several independently implemented allow-list interpretations.

For custom endpoint use, enforce:

1. The executor exists and is the intended target. Live execution additionally requires readiness; editing assignments does not.
2. The profile exists and is assigned to that executor.
3. The endpoint belongs to that profile.
4. The selected executor's integration supports the endpoint protocol and capabilities.
5. The requested model and configuration are valid for that endpoint.
6. The captured profile revision remains valid where metadata and credentials are joined.

Omitted executor identity may mean Local only at an intentional API default. Internal custom-provider resolution should receive an explicit effective executor. An explicit invalid/offline remote never falls back to Local.

### Execution Entry Points

| Path | Required behavior |
| --- | --- |
| Start, resume, queued dequeue, steering that starts new execution | Validate the durable target and current assignment, not a browser catalog snapshot. Recheck after asynchronous preparation immediately before dispatch. |
| Fork and compaction | Validate custom endpoint use on the owning executor. Do not accidentally grant source credentials to a different executor. |
| Agent/model changes | Validate the replacement executor/profile. Invalid previous selections must remain repairable. |
| Cross-executor handoff | Validate the destination profile before the durable ownership decision and again at execution. Failure after ownership commits does not reverse ownership or select another account. |
| One-shot generation | Titles, commit messages, refinement, test calls, and other single queries obey the same assignment rules on the generation executor. Auto retains its existing Local semantics. The repository executor is not necessarily the generation executor. |
| Configuration validation | Run common provider-access checks before an optional integration-specific validation facet. A null facet must not bypass policy. |
| Catalog/readiness/image support | Use the selected executor throughout, including `hasEndpointModels`, endpoint model enumeration, and image capability checks. A provider-storage outage omits custom models from catalog/readiness listings without hiding native integrations; management reports the error, and selection, reference, image, and credential checks still fail closed. |

An explicit incomplete provider/endpoint selection is invalid; it must not become native execution merely because the model string is missing. Keep provider support behind existing nullable integration facets.

Do not authorize the previous selection while merely reading it to compare with a proposed replacement. [Session settings](../server/controller/agents/session-settings-service.ts) currently resolve the previous endpoint first. Separate historical lookup from replacement authorization so removal of an assignment does not prevent repairing that chat. Preserve existing local-model/cloud-model switching restrictions where they can be established; do not infer unknown historical classification as cloud or silently bypass those restrictions.

### Reverse Credential RPC

[The executor manager](../server/controller/executors/manager.ts) already knows which authenticated connection made `credentials.resolve`. Capture that executor identity in the credential resolver. Do not accept a worker-supplied executor ID as authorization. Apply the same check to Local through [integration-host composition](../server/runtime/agents/integration-host.ts).

Retain current connection/serving-session checks and abort fencing. Credential release requires the current profile assignment, matching provider/endpoint IDs, and matching profile revision. Existing integration identity checks remain in force.

Access denial, missing explicit profiles, and stale configuration must throw typed errors. [The shared endpoint resolver](../server-agents/common/src/execution/resolve-endpoint.ts) currently converts a null credential result to keyless execution; do not use that behavior for denied custom-provider access. A deliberately configured empty key, as with an unauthenticated local endpoint, remains valid and distinct from denial. Native execution with no endpoint remains valid as well.

Assignments grant a trusted worker access to a profile's credentials, not only to the credentials of one chat. The current reverse request has no chat/run authorization context. Per-run credential capabilities are not required for this scope and must not be implied by the UI.

### Testing And Model Discovery

Keep Test and Fetch Models on the selected executor. For a saved credential:

- Check assignment before retrieving the key or dispatching a discovery request.
- Require the endpoint to belong to the supplied profile; reject mismatched IDs rather than searching another profile.
- Retain the existing URL-origin check. An edited destination must not receive an unrelated saved key.
- Check revision/context again before sending the request after any awaited preparation.

Same-origin checks are insufficient across executors: two workers can both use `http://localhost:11434` while reaching different services.

Testing an unsaved configuration with an explicitly entered key is an intentional disclosure to the selected executor. It does not create a persistent assignment. Testing with a saved key requires assignment first. The dialog must make that distinction clear rather than silently borrowing credentials from an unassigned profile.

Discovery results remain draft data until Save. Saving a model list changes the shared profile for all assigned executors; if inventories should differ, use separate profiles. Fence responses by selected executor, profile/endpoint, request generation, and captured edit context so stale results cannot overwrite another executor's form or later user edits.

## Configuration Lifecycle

### Assign, Unassign, And Create

Expose specific assign/unassign commands, not browser-side replacement of the complete assignment map. Repeated assignment/removal is idempotent. Preserve changes to other executors and profiles under concurrent requests.

Assignments can be edited for configured offline or disabled executors. Use configuration existence, not remote discovery, as the write precondition. An enabled assignment does not imply the endpoint is reachable.

Serialize assignment changes and profile deletion through a shared controller-side mutation boundary. Retain executor references through assignment publication using the existing [reference-write mechanism](../server/controller/executors/reference-writes.ts), so an executor cannot be deleted between validation and durable publication. Do not introduce a second conflicting executor-lock scheme.

Create-and-assign touches the global profile file and the workspace assignment file. It need not become a new multi-file transaction journal. Persist the profile first, then assign it. If assignment fails before publication, retain an unassigned profile and return an explicit partial outcome with its redacted ID so the UI can retry assignment without creating another profile. Report an uncertain assignment outcome separately and reconcile it before retrying. Do not automatically delete a profile that another action may already have assigned. Never authorize optimistically before durable publication.

Unassignment is allowed even when saved selections reference the profile. Preserve those selections and show unavailable status; do not erase chats, schedules, generation configuration, or draft text. Queued work must revalidate and report configuration failure rather than running with another account. Reassignment restores eligibility, not automatic replay of previously failed or uncertain execution.

### Shared Edits And Deletion

Editing a shared profile affects every assignment. Key rotation can update the same profile. A different account or destination should normally be a separate profile, selected explicitly. Do not hot-swap admitted execution into a different account.

Before profile deletion, check current-workspace durable selections, including chats, scheduled new chats, saved generation/default selections, and relevant in-progress ownership decisions. Treat recents and historical transcript labels as soft references, not perpetual deletion blockers. Make replacement/unassignment and global deletion separate operations with explicit impact.

Deletion checks current-workspace chats, settings, schedules, ownership records, and pending reference writes. The API requires `acknowledgeSharedImpact=true` because profiles may serve several executors. Archived workspaces are not scanned; unresolved references remain repairable, never redirected to a same-label profile.

### Executor Removal And Restart

Saved chats, schedules, and settings do not block executor deletion; preserve their selections as unavailable without fallback. Keep temporary guards for active execution, unfinished ownership changes, and in-flight reference publication. Assignments likewise must not make an executor permanently undeletable: remove its assignments as part of cleanup, not the global profiles.

Unknown/deleted executors cannot authorize use even if a stale assignment survives a failed cleanup write. Make cleanup idempotent across restart. A new executor with the same label but a different UUID receives no assignments. Disable/reconnect retains assignments without granting execution while the executor is unavailable.

Persist assignment mutations and profile revisions, not credential-resolution results or execution admissions. Reconnect uses the current controller policy. Previously admitted runtime state may still retain credentials.

## API And UI Work

Keep profile CRUD under `/api/v1/api-providers`. Add a redacted management read separate from `/api/v1/models?executorId=...`. The latter exposes only that executor's selectable profiles and compatible model options.

Add typed assignment reads and narrow mutations, for example:

```text
GET    /api/v1/api-provider-assignments?executorId=<id>
PUT    /api/v1/api-provider-assignments?executorId=<id>&apiProviderId=<id>
DELETE /api/v1/api-provider-assignments?executorId=<id>&apiProviderId=<id>
```

Exact route naming is an implementation detail; the separation between profile mutation and assignment mutation is not. Validate all IDs and payloads at both HTTP and RPC boundaries. Return typed unavailable-on-executor, stale-configuration, and reference-conflict outcomes using the existing domain/agent error translation, not generic 500s or null credentials.

Provider settings should support:

- The existing executor selector and a list of profiles assigned to that executor.
- Add profile, defaulting assignment to the current executor only.
- Use existing profile, showing redacted global definitions.
- Explicit assignment controls labeled as availability within the current workspace.
- Duplicate profile for an independent configuration. Do not return the original key to the browser; either require a new key or copy it server-side only after explicit user intent.
- Test from the selected executor and clear offline/testing states.
- Remove from executor separately from Delete shared profile.
- Shared-edit impact and the fact that an assigned worker can receive the API key.

Configuration management must work while an executor is offline. Native login, live discovery, and test actions can remain readiness-gated. Do not wait for every executor at settings startup.

Keep reusable assignment state in a domain-owned store/service and HTTP/WS adaptation in the integration layer. Svelte components render that state; they do not merge whole persisted maps. Preserve existing request-version guards and no-remount chat behavior.

### Invalidation And Unavailable Selections

After an assignment mutation, invalidate the affected executor's server and browser catalogs. After a shared profile mutation, invalidate every potentially affected catalog; conservative all-executor invalidation is acceptable initially. Preserve existing request fencing so an older in-flight load cannot reinstall removed choices.

Notify other connected browser clients, not only the initiating dialog. A typed profile/assignment-change notification can carry affected executor IDs and non-secret revisions; it must never contain keys. Management state and selector catalogs refresh independently. On browser reconnect, reconcile current configuration even if the worker connection never changed.

Clear or stale persisted catalog snapshots as well as instantiated stores. Refresh visible consumers on demand. Preserve saved unavailable selections and user text; New Chat, scheduled submission, active-chat controls, keyboard shortcuts, and plan approval must share admission rules. Client cache validation improves UX but never grants server-side authority.

Malformed stored generation targets remain readable and repairable per setting: the snapshot preserves the explicit target in `ui` and omits that key from `uiEffective` when it cannot be resolved. The browser displays the saved target rather than substituting Local. Writes and execution still validate strictly; choosing Auto is an explicit repair, not load-time recovery. Non-string, non-null stored executor IDs normalize to an invalid empty ID, never to an absent Local default.

## Migration

Implemented policy: preserve legacy availability only through an explicit one-time migration. Global provider schema version 2 records the legacy seed and profile revisions; workspace migration version 9 materializes assignments.

1. When upgrading the global provider-store schema, capture the IDs of profiles that existed under the legacy global policy. Persist that seed atomically with initial profile revisions. Profiles created afterward must not enter the seed.
2. Add an ordered [workspace migration](../server/controller/migrations/README.md) for existing workspaces. Materialize assignments from that legacy seed to Local and the workspace's already-configured remote executors, including offline/disabled executors. Use persisted topology, not successful connections.
3. Persist the assignment file before marking migration complete. Reruns must preserve an already-written assignment snapshot, not re-grant membership after a later unassignment. Preserve provider/endpoint IDs and existing saved selections.
4. Fresh workspaces skip the legacy grant, using the existing migration runner's fresh-workspace distinction. New profiles and executors require explicit assignment.

The legacy seed matters because an old workspace may first be opened after new profiles have been created in the global store. Assigning all profiles present at that later startup would silently grant newly introduced accounts.

Install a fail-closed policy before remote credential requests can be served. Do not expose a permissive window while migrations run, and do not block startup on an offline executor. After migration, a missing or corrupt assignment file blocks startup until repaired; it is neither a usable empty authorization state nor grounds to repeat the legacy grant. Migration metadata is not a permanent wildcard.

No chat-registry routing rewrite is required. Existing executor/provider/endpoint IDs retain their meaning. Unknown profiles/executors remain explicit unavailable selections. Do not rewrite them to native auth or clear unrelated user settings.

## Trust And Operational Limits

Controller persistence is not exclusive controller possession. Workers receive keys over Noise and provider runtimes may retain them in memory or process environments. Do not log keys, credential-bearing headers, whole RPC payloads, or secret-dependent revision hashes.

Unassignment blocks subsequent admissions and credential releases. It cannot erase a previously disclosed key or guarantee that admitted native work stops. Strong revocation requires rotation at the upstream provider. This scope does not introduce a distributed cancellation/revocation protocol.

### Single Controller Ownership

The controller exclusively leases both its config directory and workspace at startup. Concurrent controllers sharing either directory are unsupported and refused. Profile mutations use one in-process lock; supplied revisions reject stale browser edits. Atomic private writes publish the in-memory snapshot before notifying catalogs and browsers, only after durability is confirmed.

Profiles are loaded at startup, not watched or re-read before each use. Edit configuration through the owning controller, or stop it before editing files manually and then restart. External edits made while it runs are ignored and may be overwritten by subsequent mutations.

Malformed storage blocks startup. Uncertain write durability makes the running store unavailable until restart rather than authorizing from a possibly stale snapshot. Committed changes immediately invalidate catalog caches and connected browsers; no cross-controller change propagation is needed.

These guarantees do not revoke credentials already disclosed to a worker or provider process.

## Implementation Boundaries

| Slice | Principal work |
| --- | --- |
| Contracts and persistence | Extend [shared provider contracts](../common/api-providers.ts) and [credential references](../common/agent-execution.ts); add profile revisions, workspace assignments, strict parsing, migration, and atomic writes. |
| Resolution and catalogs | Make [endpoint resolution](../server/controller/api-providers/endpoint-resolver.ts), [catalog service](../server/controller/agents/catalog-service.ts), [registry readiness](../server/controller/agents/registry.ts), [model routes](../server/controller/routes/models.ts), [agent routes](../server/controller/routes/agents.ts), [catalog cache](../server/controller/routes/model-catalog-cache.ts), and [delegated start selection](../server/controller/agents/agent-start-selection-service.ts) executor-aware for custom providers. |
| Admission and credentials | Update [runtime routing](../server/controller/agents/runtime-router.ts), [settings validation](../server/controller/agents/session-settings-service.ts), [handoff](../server/controller/agents/agent-handoff-service.ts), [endpoint planning](../server/controller/agents/execution-planning.ts), executor manager/host composition, and shared credential resolution. Keep provider-specific execution behind existing integration contracts. |
| Management and discovery | Extend [provider service](../server/controller/api-providers/service.ts), [HTTP routes](../server/controller/routes/api-providers.ts), typed notifications, executor-removal cleanup, and reference/deletion checks. |
| Browser | Extend [provider API](../web/src/lib/api/api-providers.ts), [catalog store](../web/src/lib/agents/model-catalog-store.svelte.ts), settings composition, and [endpoint dialog state](../web/src/lib/components/settings/api-provider-endpoint-dialog-state.svelte.ts). Add assignment management without duplicating the existing model selector. |

This is a cross-cutting configuration and admission change, not a transport rewrite. The configuration relation is small; consistent enforcement, repair paths, migration, and tests account for most of the work.

## Verification Criteria

Use synthetic endpoints and credentials, real public controller/worker startup, and both connection directions. No paid provider calls or real account credentials are needed.

- Store tests: assign/unassign idempotency, concurrent field-level changes, failed and uncertain writes, malformed schema, unresolved IDs, profile revisions, offline-executor editing, and executor deletion during assignment publication.
- Migration tests: existing/fresh workspaces, Local and offline executors, stable provider IDs, crash reruns, missing/corrupt post-migration state, later-created profiles excluded from an older workspace's migration, and newly created executors receiving no grants.
- Resolver/catalog tests: Local versus two remote executors; identical URLs/model names with different profiles; whole-profile endpoint inheritance; selected-executor protocol/capability differences; image support and readiness; global management visibility versus filtered selection visibility.
- Credential tests: a worker requesting an unassigned profile, forged executor identity, mismatched provider/endpoint IDs, stale session, profile revision change between metadata and key lookup, assignment removal during preparation, intentional empty keys, and denied lookup never becoming keyless/native execution.
- Discovery tests: both remote connection directions, saved-key assignment checks, unsaved explicit-key tests, URL-origin changes, same `localhost` on different executor contexts, and stale replies after executor/profile/form changes. Use isolated worker/network contexts or a deterministic executor-side probe when both fixtures run on one host.
- Execution tests: start/resume, queued dequeue, compaction, fork, handoff, every generation caller, optional configuration-validation facets, and explicit incomplete selections. Verify no request reaches an unassigned endpoint and no request falls back to Local/native/another account.
- Lifecycle tests: preserve invalid saved targets, repair a chat after unassignment, schedule/generation failure without data loss, unassignment versus admitted work, executor deletion cleanup, and profile deletion/reference-publication interleavings.
- Browser tests: add/use existing/duplicate/remove, offline configuration, shared edit impact, model selection, multiple connected clients, persisted catalog invalidation, deferred stale responses, all submit paths, and retained draft text. Rapidly switch executors/chats without remounting heavy chat UI or moving focus/scroll unexpectedly.
- Deployment tests: reject a second config/workspace owner, load external edits on restart, and exercise mutation notifications and revision checks.

Extend the existing suites under `server/controller/api-providers/__tests__`, `server/controller/executors/__tests__` and `server/remote/__tests__`, and provider-settings/catalog frontend tests. Add black-box coverage under `integration-tests/tests/server` and browser workflow coverage under `integration-tests/tests/e2e`. Test the common denial/selection logic independently as well as through HTTP, RPC, and persistence boundaries.

Implementation gates are `bun run check`, `bun run test` with applicable web coverage, focused integration/browser suites, and a timed fresh `bun run start --port 0` startup check. This document does not claim those implementation gates have run.

## Recorded Decisions

- Preserve legacy availability through a fixed seed and one-time workspace migration, not a permanent default grant.
- Trust assignments at executor level; unassignment blocks future admissions and credential release, not already-disclosed keys.
- Support one controller per config directory and workspace; serialize its mutations in-process and load manual edits on restart.

Field overrides, account selection by implicit executor fallback, per-run credential capabilities, worker-side configuration replication, and distributed revocation remain out of scope.
