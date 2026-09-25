# CLI Access Through Executors

Status: implemented and reviewed, 2026-09-24. Opus and Astra reviewed the design against `e9a9cfcf5` and the implementation through `3279b49e0`; `ce725e1d5` adds the final requested regression coverage. The [current transport contract](./transport.md) supersedes older replay and chunk-transfer proposals. Source links below identify the original investigation baseline; the corrections in this document govern implementation.

This extends [Executor Interfaces](./interface.md) and [Executors In The App](./app-integration.md), which deliberately excluded a spawned-CLI bridge. It retains the single-channel policy from [Files](./files.md), [Terminals](./terminal.md), and [Git](./git.md). Existing CLI behavior is documented in [Garcon CLI And Server](../cli.md).

## Decision

Reuse the existing controller-to-worker Noise WebSocket for CLI requests in the reverse direction. Put a small authenticated loopback HTTP gateway in the worker process. It exposes the same CLI-facing HTTP paths, methods, query parameters, JSON bodies, and application responses as the controller, then translates those exchanges into bounded reverse RPC calls.

The CLI continues to use HTTP. It does not open a WebSocket, implement Noise, understand transport ordinals, or participate in executor reconnects. It must learn the endpoint's execution context during discovery and use controller-instance fencing, but ordinary command code should not branch on whether the HTTP endpoint is a controller or a worker gateway.

This is transparent application transport, not an unchanged-binary compatibility claim. Today's CLI assumes that its HTTP endpoint and controller are the same process, and several executor-sensitive calls omit executor identity. Those assumptions must change for both endpoint types.

Authority policy: explicit controller-side, per-executor opt-in to workspace-level CLI access, default off. This is broader than controller-interpreted agent-command authority and includes authorizing execution on other hosts, including Local. Do not silently grant it merely because a worker connects.

## Scope

- Make the current CLI operation set usable from provider subprocesses and terminals on an authorized worker, subject to explicit transport bounds.
- Preserve CLI syntax, output formatting, application error contracts, existing command identities, and operation-specific retry rules.
- Work in both connection directions without requiring the worker to reach the controller's HTTP listener.
- Keep the controller as the only owner of chats, transcript ledgers, queues, permissions, application settings, and tickets.
- Keep argument parsing, stdin, cwd resolution, receipt polling, and output-file writes on the machine running the CLI.
- Keep retained remote terminals usable after controller restart without changing their process-lifetime guarantee.

No additional controller-worker channel, traffic scheduler, generic HTTP proxy, controller-side CLI subprocess, durable forwarding queue, new mutation ledger, result cache, or automatic agent recovery. Per-chat CLI capabilities and explicit cross-executor CLI selection flags are separate work. Existing executor-aware ticket project inference is reused. Controller-interpreted provider-output commands keep their existing path and authorization rules.

## Existing Behavior

| Boundary | Current behavior and implication |
| --- | --- |
| [CLI discovery](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/discovery.ts) | Reads a named workspace's private `server-runtime.json`, restricts the URL to loopback, and verifies an HMAC challenge before trusting the endpoint. The descriptor's instance is currently also the controller generation. |
| [CLI HTTP client](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/garcon-client.ts) | Centralizes authenticated JSON HTTP requests and response parsing. Selected idempotent submissions reuse their command IDs after verifying the same controller instance. There is no CLI WebSocket client. |
| [CLI orchestration](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/consultation.ts) | New starts send the CLI's cwd but no executor ID. Catalog calls also omit executor identity, including calls during resume and handoff. A proxy alone would route some remote work to Local. |
| [Receipt polling](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/receipt-poller.ts) | Synchronous start/resume/wait uses separate bounded HTTP requests for receipts, with bounded transport recovery. It does not stream the entire agent turn through one request. |
| [Worker composition](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/execution-nodes/worker.ts) | Deliberately disables spawned-CLI discovery. At current HEAD, the executor, providers, and PTYs survive reconnect; only serving/RPC bindings are replaced. Reuse the existing process-level `currentRpc` binding. |
| [Reverse RPC](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/execution-nodes/manager.ts) | The controller currently accepts only `credentials.resolve`. Adding CLI access extends this explicit reverse-service boundary; it must not expose every controller route. |
| [RPC implementation](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/execution-nodes/rpc.ts) | Supports concurrent bidirectional calls, UUID correlation, and cancellation. Current HEAD retires every disconnected session without replay. A handler can call back into the worker without another connection. |
| [HTTP route contracts](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/lib/http-route-types.ts) | Raw route handlers are callable with a request and explicit principal context. Reuse these handlers or their owning services instead of performing an authenticated HTTP request back into the controller. |

## Ownership

```text
CLI on the controller                  CLI on an executor
        |                                        |
        | existing local HTTP                    | same HTTP API
        v                                        v
Controller HTTP boundary                 Worker CLI gateway
        |                                        |
        |                        existing shared Noise WebSocket
        |                                        |
        |                                        v
        +------------------------ Controller CLI dispatcher
        |                                        |
        +--------------------+-------------------+
                             |
                Existing application handlers/services
                             |
           Selected executor when an operation needs one
```

The worker gateway owns its local listener, descriptor, local capability, admission limits, and adaptation to one captured RPC session per request. It is not a second controller and does not load controller application stores.

The controller dispatcher owns the allowlist, delegated authority, controller-generation check, request validation, application dispatch, and bounded inline replies. It receives the originating executor from the authenticated link, not an HTTP header or a caller-supplied principal.

The same shared socket carries agent, Files, Terminal, Git, credential-resolution, and CLI traffic. The loopback listener is local IPC, not an additional network connection between controller and worker. There is no new public worker API. Bind the gateway only to a numeric loopback address on a random port, never to `0.0.0.0`; the executor network listener remains a separate existing concern.

## HTTP Transparency

Both endpoints serve the same application request. For example:

```text
POST /api/v1/chats/start
Authorization: Bearer <capability for this local HTTP endpoint>
X-Garcon-Server-Instance: <captured controller serverInstanceId>
Content-Type: application/json

{ ...existing start fields, executorId: <selected executor> }
```

Against the controller, the existing HTTP boundary invokes the start handler. Against the gateway, local authentication is consumed at the gateway and the request is carried by `controllerCli.request`; the controller dispatcher invokes that same start handler with a derived delegated-executor principal. The gateway returns the controller's application response to the CLI.

The HTTP capability is endpoint-local. A gateway capability is never forwarded as controller authentication, and the controller's local capability is never copied to the worker. The executor secret remains private to the connector.

Application status codes, JSON bodies, and applicable `Retry-After` information survive the relay. Do not wrap successful application responses in a gateway-specific JSON object or translate typed domain errors to generic success/failure strings. Gateway and relay failures use explicit shared error codes in the ordinary HTTP error shape.

Only a small header set is supported. Reconstruct JSON content headers, set `Cache-Control: no-store`, and propagate validated retry metadata where needed. Do not forward cookies, caller-supplied authorization, origin, host, proxy headers, redirects, compression negotiation, or arbitrary response headers. The CLI does not currently need conditional HTTP caching or an upgrade through this endpoint.

All gateway application requests require the captured controller-instance header. The direct controller boundary also validates this header when supplied, so the updated CLI uses one request path for both endpoints. Existing browser authentication remains independent; the header is an additional fence, never authentication. Neither gateway nor dispatcher may replace an old expected instance with the current one.

## Discovery And Endpoint Context

Separate proving the local HTTP endpoint from selecting the controller generation behind it.

### Local Descriptor

The controller, worker, and CLI share `--config-dir` / `GARCON_CONFIG_DIR`, defaulting to `~/.garcon`, with explicit flags overriding environment defaults. Workspace selectors configure only controller storage. The CLI learns the active workspace from authenticated context, including a null name for `--workspace-dir` controllers.

Publish at two fixed paths: `<config-dir>/runtime.json` for the controller and `<config-dir>/executor/runtime.json` for the worker. One controller and one worker may coexist under the root. The controller holds its existing config-root and workspace leases; the worker holds the same lease type on `<config-dir>/executor` before opening its listener credentials or provider data. Controllers reject workspaces in their root's reserved executor subtree, including aliases. Garcon-owned data and endpoint capabilities are separate; native provider account homes retain their existing semantics.

The CLI accepts `--runtime auto|controller|executor` / `GARCON_RUNTIME`, defaulting to `auto`. Explicit flags win. `auto` reads only these two files, chooses the newer numeric `startedAt` when both exist, and warns on stderr; equal timestamps select the controller. Only missing files are absent. Invalid or insecure metadata blocks automatic selection. An explicit role reads only its own file. There is no workspace scan, process UUID selector, PID check, registry, or `--runtime-file` option. See [Connection Rules](../cli.md#connection-rules) for the complete user-facing contract.

Selection uses a securely read descriptor snapshot. Verify the chosen endpoint without rereading or switching roles, then obtain authenticated controller context. A newer stale, disconnected, busy, or denied runtime fails rather than falling back to the older role. `--server` remains an exact URL assertion, never a selection filter. The start timestamp indicates preference, not liveness. A new CLI invocation may select a different process or workspace; an existing invocation retains endpoint and controller identity through recovery.

Each descriptor contains the actual bound URL (including an OS-assigned port), endpoint identity, pid, `startedAt`, and a fresh endpoint-local bearer capability. A gateway descriptor never contains a controller workspace path, controller capability, or Noise secret. Publish both kinds through an exclusive 0600 temporary file and atomic rename. Existing data directories need not be 0700; do not chmod them. Retain private-file, regular-file, owner, leaf-symlink, loopback, and role/path checks. These checks assume trusted storage parents, as controller storage already does.

After acquiring a role's lease, remove its predecessor's runtime file before initialization; failure to clear it is fatal. Gateway startup itself remains optional once stale metadata is absent. Shutdown closes the listener and removes only the matching instance before releasing storage ownership, even if other cleanup fails. Independent workers need separate roots.

Both roles export their resolved `GARCON_CONFIG_DIR` and their own `GARCON_RUNTIME` to children, clearing obsolete runtime pins and inherited controller workspace variables. Flags can override these defaults. Generated hints and ticket retry prefixes retain the resolved root and explicit role, not `auto`; do not put selectors or capabilities into automation envelopes. A root plus role selects the current holder, not a permanent workspace or process. Existing ticket-store and permission-instance fences remain necessary.

### Two Discovery Requests

Use these paths on both controller and gateway:

1. `GET /api/v1/runtime?challenge=...` proves the local HTTP endpoint using its descriptor capability and endpoint instance. Reuse the existing challenge/HMAC protection; this response need not expose controller workspace information.
2. Authenticated `GET /api/v1/cli/context` returns the current controller context. The gateway obtains it through an authorized `controllerCli.describe` reverse RPC on its current ready connection. The controller-local endpoint returns its own context directly.

The second response is a small shared contract, illustratively:

```ts
interface CliContext {
  readonly serverInstanceId: string;
  readonly defaultExecutorId: string;
  readonly workspaceName: string | null;
}
```

For direct controller HTTP, `defaultExecutorId` is `local`. For a worker gateway, it is the authenticated originating executor. This is an execution default, not a visibility or authorization filter. It does not constrain list/search to that executor.

Controllers started with `--workspace-dir` have no workspace name. Report null in context and automation metadata, never their private path or an invented `default`. Preserve existing named-workspace output.

The gateway may prove its own identity while disconnected, but context discovery must return unavailable then. It must not present stale cached controller context as live verification. Reject discovery while the dispatcher is initializing, the executor is not ready, CLI access is disabled, or the controller is quiescing.

After these steps, construct the same `GarconClient` from the HTTP URL, endpoint-local capability, captured controller `serverInstanceId`, default executor, and workspace name. There is no command-level `if (isExecutorGateway)` path.

`verifyRuntime()` must verify the endpoint and compare the live controller context with the invocation's captured instance. A stable gateway HMAC proof alone does not prove that the controller survived. A new invocation can discover a restarted controller; an existing invocation never updates its captured controller identity in place.

## CLI Changes

The CLI needs context awareness, not WebSocket awareness:

| Concern | Required change |
| --- | --- |
| Discovery | Accept the explicit gateway descriptor and resolve the shared live CLI context. |
| HTTP client | Add the expected-controller header to application calls; preserve existing response parsing and distinguish bridge delivery errors. |
| Runtime verification | Compare controller generation, not only the stable local HTTP endpoint identity. |
| New execution and catalogs | Pass explicit executor identity derived from the operation's context. |
| Existing chat operations | Resolve catalogs and handoff defaults using the chat's owner/target executor, even through direct controller HTTP. |
| Automation output | Report the actual controller workspace and controller instance, not worker storage or gateway identity. |
| CLI command logic | Retain parsing, formatting, receipt polling, command IDs, stdin handling, and local output files. |

An entirely unmodified CLI is not a safe target: it would interpret the gateway lifetime as controller lifetime and can send a remote cwd to Local. Do not hide these issues behind a body-rewriting proxy. The small shared context contract removes the need for two implementations of each CLI command.

## Delegated Authority

Add `allowControllerCli: boolean` on controller-owned remote-executor configuration, default false, exposed explicitly in the executor editor. Enabling it grants the trusted worker OS account allowlisted workspace-wide authority, including agent execution and permission responses on Local and other hosts. State that command-execution authority plainly in the permission UI. Missing saved values default false; grant-only updates neither require idleness nor replace the connector.

Every reverse call checks the current executor entry, link/session ownership, readiness, CLI grant, and controller lifecycle before dispatch. Use `integrationId: ''` for this executor-level reverse service; do not treat it as an individual provider facet. Install the dispatcher only after its application dependencies exist, without making remote connection readiness block startup.

Introduce an explicit delegated-executor principal with stable executor-based authority. Never authenticate a forwarded request using `LOCAL_SERVER_PRINCIPAL`, a fabricated human username, or caller-supplied identity. Executor labels are mutable presentation, not authority keys. Shared principal/actor validation and consumers such as ticket attribution must represent this origin honestly and retain their existing author/edit rules. Supplied `--parent` and `--from-chat` values remain declared relations or attribution, not observed provider provenance.

Tickets gain explicit UUID-based executor actor and executor owner variants. A claim without `--from-chat` belongs to the executor; declared chat ownership remains supported. Update validation, owner keys/filters, CLI formatting, and UI presentation. Labels do not enter fingerprints or comment-edit authority. Durable retries deduplicate only from the same origin; retry hints must preserve the runtime selector and warn against switching to Local or another executor. Older builds cannot read executor-attributed tickets; no dual format is required.

Changing or revoking CLI access does not replace the connector or terminate PTYs/agents. It invalidates an executor/session authorization lease and cancels bridge waits best effort. Revoke/re-enable cannot authorize late completion under the old lease. Already accepted work is not rolled back. Check current entry configuration, verified readiness, exact RPC backing, and quiescence on each call, not captured connector configuration. Capture these checks with the original lease and cancellation signal in a per-call RPC reply guard, including context discovery. Run that guard synchronously immediately before enqueue; validation at handler completion alone leaves a promise-continuation race.

This is an OS-account trust boundary, not isolation between processes using that account. The private descriptor and local capability prevent unrelated users or unauthenticated local HTTP clients from gaining access; they do not identify which agent issued a shell command. No browser CORS access is enabled.

Per-chat restrictions would require authenticated run/session context and new delegation policy, especially for shared provider processes and surviving terminals. They are not implemented by trusting a `chatId` argument or inferring it from cwd. Keep that larger model out of this bridge.

## Reverse RPC Contract

Add an explicit typed reverse-service family to the existing protocol:

```text
controllerCli.describe() -> live CliContext
controllerCli.request({ expectedServerInstanceId, http })
  -> { status, body, retryAfter? }
```

`http` carries an enumerated method/path operation, ordered query pairs, and a JSON body, not an arbitrary URL or executable operation. The CLI and raw application handlers retain the existing typed DTOs and runtime parsers; the relay independently validates its narrower authority envelope, including explicit executor targets and the restricted settings patch. Do not duplicate all application parsers inside the gateway. Preserve repeated query values and their order rather than collapsing them into a single-value object.

The normal `ExecutorRpc` envelope supplies the RPC UUID, request/result/error/cancel frames, and transport correlation. Existing `clientRequestId`, `clientMessageId`, turn IDs, and ticket operation identities stay inside the application body unchanged. They are not replaced by the RPC UUID or message ordinal.

The gateway authenticates and bounds the local request, validates its allowed method/path and envelope, then captures one RPC backing. The controller independently validates the envelope and operation, checks the expected controller generation, creates the principal, and invokes the existing raw handler with a cancellation-linked `Request` and `HttpRouteContext`. A fixed internal URL can supply normal query parsing; no request-selected host is fetched.

Reuse the existing route/domain implementation and shared error translation. Extract only the narrow invocation/error-handling helper needed to avoid duplicating middleware behavior. Do not call the controller's listener with a privileged bearer token. HTTP compression and socket idle-timeout handling belong to the real outer HTTP boundary, not the synthetic internal request.

Return finite JSON application responses, including confirmed domain failures. Normalize malformed JSON and uncaught errors consistently with direct HTTP. Unknown paths/methods, unsupported content types, unexpected envelopes, and oversized inputs fail before application dispatch. Do not forward upgrades, arbitrary streams, static assets, or raw filesystem responses.

Dispatch is concurrent and asynchronous. A start or catalog request can require a controller-to-worker RPC while its worker-to-controller request is pending. Do not hold a connection-wide mutex across either call, block the event loop waiting for a response, or serialize all CLI traffic behind a long-running command.

## Initial Allowlist

The following is the current CLI surface, not permission to expose every route under these prefixes. All paths have the `/api/v1/` prefix. Register each exact method/path pair, with operation-specific validation; additions require explicit contract and authorization tests.

| Family | Exact operations |
| --- | --- |
| Discovery | `GET runtime`, `GET cli/context` are local endpoint operations; only context requires reverse description. |
| Selection | `GET models`, `GET app/settings`, `GET preambles`. |
| Chat reads | `GET chats`, `GET chats/messages`, `GET chats/snapshot`, `GET chats/turn-receipt`, `GET chats/export`, `GET chats/handoff-artifact`; `POST chats/lookup-native-session`. |
| Search | `POST chats/search`, `GET chats/search/status`, `POST chats/search/rebuild`. |
| Search setting | `PUT app/settings`, restricted to the exact transcript-search-enabled boolean patch used by the CLI. No other settings fields. |
| Execution | `POST chats/start`, `POST chats/run`, `POST chats/fork`, `POST chats/fork-run`, `POST chats/steer`, `POST chats/stop`, `POST chats/permissions/decision`. |
| Rows and organization | `GET chats/rows`, `POST chats/rows`, `PUT app/session-name`, `PUT chats/pin`, `PUT chats/archive`, `GET chats/tags`, `PATCH chats/tags`. |
| Tickets | `GET tickets/bootstrap`, `GET tickets`, `GET tickets/detail`, `GET tickets/history`, `POST tickets/project-default`, `POST tickets/mutate`. |

Exclude executor management and its credentials, provider credential administration, authentication/account routes, Files/Git/Terminal APIs, and any route not needed by the CLI. Restricting a broad endpoint requires validating nested payload fields, not only allowing its URL. In particular, forwarding an unrestricted settings patch would defeat the allowlist.

Ticket project inference is implemented on the selected executor at current HEAD. Send the context default executor with the CLI directory and reuse that resolver. Do not expand commands merely because their browser APIs exist.

## Execution Targeting

Origin and target are different identities. Origin is derived from the authenticated worker link and determines CLI authority. Target is a validated executor or existing chat selected by the operation.

| Operation | Target rule |
| --- | --- |
| New `start` / `start-async` | Explicitly send `context.defaultExecutorId`; resolve cwd on the CLI machine and validate it again through that executor's project service. |
| Standalone agent/model catalog | Use the context default executor. Provider endpoint definitions remain controller-owned; discovery still executes on the selected executor. |
| Native-session lookup | Include the context default executor to avoid same-native-ID ambiguity across hosts. |
| Existing-chat resume/settings selection | Use the already-fetched snapshot's durable executor/agent/epoch and that executor's catalog. Do not fetch the full chat list or use the HTTP endpoint's default. |
| Agent handoff without an executor override | Preserve the existing chat executor and use its destination-agent catalog. Do not move execution just because the CLI ran on another worker. |
| Fork/fork-run | Keep the source-chat executor and existing fork/handoff semantics. |
| Read/search/status/wait/stop | Keep the explicit chat identity and existing ownership/control fences; no caller-executor filter or retargeting. |
| Export/handoff output file | Write on the CLI machine, never on the controller by interpreting the requested output path remotely. |
| Ticket project inference | Send the context default executor and CLI directory to the existing resolver. |

Require explicit executor fields for bridged executor-sensitive requests where omission would otherwise mean Local. Do not repair them by blindly rewriting every executor or path at the gateway. The context default is not an authorization ceiling: an existing chat may legitimately belong to another executor. New cross-executor selection flags are not required to make this bridge useful.

Preserve existing ownership epochs, transcript-view checks, permission occurrence/control IDs, and stale-result handling. After an awaited chat lookup, a changed owner may require fresh selection or typed rejection; a matching agent name or filesystem path does not identify the same executor. Use portable executor paths at the shared boundary without applying controller-native path resolution to worker paths.

Catalog-dependent ordinary runs need an optional expected ownership epoch. Include it in the command fingerprint and check it under the existing chat mutation lock, after exact-command replay lookup. This prevents same-agent cross-executor handoffs from applying settings selected from the previous executor. Minimal resumes still use atomic server-side selection; handoffs retain their existing epoch fence.

## Process And Connection Lifetimes

Construct the gateway beside `TerminalRuntime` in the worker's process scope. Start it before provider or PTY children that need to inherit its descriptor location. Replace only the gateway's active session binding inside `link.onSession`; disposing a serving executor must not stop the loopback listener or rotate its local capability.

Inherit the config root and explicit role, not a captured controller generation or controller bearer. A long-lived shell then discovers its role's current process each time it starts a new CLI. Clear inherited workspace variables before installing worker context. Verify inheritance through each provider's environment construction and the PTY spawn path; do not introduce provider imports into core.

Bind the gateway to the authenticated stable executor relationship. A changed executor identity is not an ordinary controller restart: refuse to silently repoint retained shells at that different relationship. Explicit re-enrollment is separate from reconnect. Multiple worker processes on one host have separate private descriptors, local capabilities, and gateways.

| Event | Behavior |
| --- | --- |
| Worker starts before its controller | Gateway exists, context/application calls report unavailable, and process startup remains non-blocking. |
| Private gateway startup fails | Warn and continue serving the executor after clearing stale metadata. Inherited `GARCON_RUNTIME=executor` makes provider/PTY CLI calls fail closed rather than select the controller. |
| Any physical disconnect | Retire the RPC session and reject sent calls without confirmed replies as uncertain. Unsent calls fail definitively. No replay or resumption. |
| Fresh connection | New requests can use its authorized backing; old calls never migrate. Keep process-owned providers, local gateway, and PTYs. |
| Controller restarts | Existing invocations retain the old `serverInstanceId` and fail their fence. Fresh invocations discover the new instance. No execution state is recovered by this gateway. |
| CLI process exits or aborts its HTTP request | Close the wait and request best-effort cancellation. Keep unsettled handler work accounted for; do not infer Stop or rollback. |
| CLI permission revoked | Invalidate its authorization lease and close admissions without stopping other services. |
| Worker process exits | Stop the local gateway and retire its descriptor/capability. Ordinary worker shutdown still owns PTY cleanup. |

Distinguish endpoint process identity, controller `serverInstanceId`, configured executor UUID, logical RPC session, and application command identity. Neither worker `runtimeId` nor provider-serving `instanceId` can substitute for the controller command-ledger generation.

## Delivery And Restart Fencing

The stable gateway credential removes a protection present in direct HTTP: controller restart currently rotates the direct endpoint's capability. Therefore every forwarded request, including reads and polling, must carry the invocation's expected controller `serverInstanceId`, checked at controller dispatch. A discovery probe before retry is not sufficient because restart can occur between probe and mutation.

Use explicit bridge outcomes in the standard error envelope, with names such as `CLI_CONTROLLER_UNAVAILABLE`, `CLI_CONTROLLER_CHANGED`, `CLI_ACCESS_DENIED`, `CLI_SERVICE_BUSY`, `CLI_REQUEST_TOO_LARGE`, `CLI_RESULT_TOO_LARGE`, and `CLI_OUTCOME_UNKNOWN`. Final names belong in the shared error-code contract. The CLI must recognize definite admission/restart rejections instead of treating every 5xx bridge error as an ambiguous mutation.

Status/classification: CHANGED is 409, ACCESS_DENIED 403, size failures 413, UNAVAILABLE/BUSY 503 retryable without mutation dispatch, and OUTCOME_UNKNOWN 503 with possible dispatch. Classify unknown outcomes like transport loss before operation-specific rules, including steer. A later definitive rejection must not erase uncertainty from an earlier attempt. Controller changes and access loss stop recovery; ticket retries remain explicit. The five-second redial may outlast existing CLI retries, which must fail honestly rather than silently expand.

| Observation | Required handling |
| --- | --- |
| Rejected before forwarding or controller dispatch | Definitive no-dispatch error; no hidden queue or automatic relocation. |
| Complete validated application response | Preserve its status/body, including application-specific partial success or error semantics. |
| Link/cancellation/deadline loss after possible dispatch | Report uncertainty unless a definitive application result exists. Do not describe this as an operation that never ran. |
| Reconnect | Old requests remain uncertain; there is no gateway resend. Only existing application-ID recovery can submit a new RPC after generation verification. |
| CLI contract permits exact submission recovery | Keep the same application IDs/body and verify the same controller generation; perform the dispatch-time fence on every attempt. |
| Controller generation changes | Stop recovery for that invocation. Do not replay process-ephemeral commands into the new controller. |

The gateway has no application retry loop. Preserve current differences: correlated start/run/steer/control submissions have specific same-controller recovery, plain fork has an uncertain-outcome path, and ticket mutations have their own explicit durable retry contract without automatic CLI resubmission. Do not add a blanket ban or blanket retry that overrides these contracts.

Receipt polling remains in the CLI. Waiting for a turn does not reserve one reverse RPC for the turn's lifetime. Aborting a wait does not stop the agent; explicit Stop remains a separate command. Existing controller queues and command ledgers remain process-ephemeral, with the current durable ticket-operation exception unchanged.

## Bounds, Results, And Deadlines

Use one bounded inline reply, matching the current transport. Do not restore deleted Files/Git transfers or introduce CLI result handles. Starting limits, subject to resource-bounded tests:

- One MiB encoded request including envelope; retain smaller domain limits.
- Eight MiB encoded reply including envelope, below the 16 MiB application-frame ceiling.
- Refuse bulk CLI replies when queued bytes plus reply exceed eight MiB, leaving capacity for other traffic. Replies at or below 64 KiB use the ordinary shared queue budget so small mutation acknowledgments are not needlessly replaced with uncertainty. Return a small busy error for rejected bulk reads or unknown outcome for potentially committed mutations. Generic RPC reply admission also falls back to a small uncertain error instead of blindly overflowing the queue.
- Separate per-executor admission pools: two long operations and six short operations, including discovery and polling, with controller-wide caps. Long forks must not occupy every polling slot. This is fail-fast admission, not priority scheduling.
- Bound gateway HTTP concurrency and response-drain lifetimes, including slow readers.

Keep reverse credential resolution and controller-to-worker callbacks independent of CLI admission. A canceled wait does not release the reservation for an unsettled handler/producer, including across session replacement. After confirmed acceptance, agent execution belongs to existing controller admission, not a bridge slot held for the whole turn.

Full chat lists and exports can exceed the cap. Fail explicitly, never truncate JSON or change export contents, watermark semantics, or privacy rules. Existing handlers may materialize complete results before encoding; limit concurrent producers. This stage does not claim a hard bound on every transient allocation or introduce a second bounded export pipeline. The [transcript-ledger design](../transcript-ledger-v5-design.md) remains authoritative.

If a mutation may have committed but its reply cannot be delivered or validated, report uncertainty, not a safely retryable size/admission rejection. Return known receipts where their contracts permit.

The trusted operation registry supplies deadlines: ordinary calls 30 seconds; export/handoff artifacts 120 seconds; a run with agent handoff ten minutes; existing fork/fork-run/search-maintenance calls no deadline. Add explicit `timeoutMs: null` RPC support with no timer, not Infinity or an overflowing timer. Propagate HTTP abort best effort. No-deadline calls still obey authorization, admission, and session lifetime.

The gateway owns real HTTP idle-timeout policy; synthetic controller requests have no socket to extend. Cancellation never implies rollback or agent Stop. Release unsettled-work reservations on settlement.

Use explicit HTTP response-drain accounting, not Bun's `pendingRequests` counter: that counter can fall before a slow client has consumed a buffered response. The gateway uses Executor-compatible HTTP response close events, bounded writes with backpressure, a 16-response budget, a 32-connection ceiling, and a 30-second idle drain timeout. Bulk reply admission runs synchronously at RPC publication so simultaneous completions cannot each consume the same available queue capacity.

One shared channel still permits head-of-line delay and shared failure. Noise fragments large replies; that is not traffic isolation. Measure chat/terminal latency under exports and polling; reconsider a second channel only for demonstrated interference.

## Implementation Boundaries

1. Extend shared runtime discovery/context and expected-controller fencing for direct HTTP first. Make `GarconClient` context-aware while preserving existing CLI behavior and tests.
2. Make CLI executor selection explicit for starts, catalogs, native lookup, and existing-chat operations. Keep transport selection out of command semantics.
3. Define the typed CLI HTTP allowlist, controller dispatcher, delegated-executor principal, and explicit executor permission. Reuse existing handlers and error contracts; deny unregistered routes by default.
4. Add the process-owned loopback gateway and reverse RPC adapters, including inline bounds, cancellation, session fencing, and lease-owned private descriptors.
5. Wire provider/PTY discovery, executor-editor permission, public worker startup, and deterministic cross-boundary acceptance. Remove the deliberate CLI-unavailable setup only when the new fail-closed context is installed.

The implementation must not copy all routes into the worker, introduce a general process service, or add per-command remote implementations. Frontend work covers the executor permission and honest ticket actor/owner presentation. Existing ticket project inference is reused.

## Verification Criteria

Documentation is not implementation verification. Required coverage includes:

- Contract parity: the same CLI commands against direct controller HTTP and the gateway preserve paths, body DTOs, status, errors, relevant retry metadata, and output. A registry test accounts for every HTTP operation emitted by `GarconClient`.
- Discovery: descriptor permissions/owner/symlink checks, wrong endpoint proof, conflicting selectors, unavailable gateway, correct controller workspace output, multiple workers on one host, and no fallback to an unrelated local server.
- Authorization: opt-in disabled/enabled/revoked, stale executor/session, forged origin/principal, unregistered route, arbitrary settings patch, invalid JSON/content type, and local capability rejected as a network/controller credential. Declared chat attribution never becomes observed authority.
- Generation fencing: controller restart between context discovery and dispatch, between retry verification and dispatch, and during polling. A surviving gateway must not authorize an old request against the new controller. New commands from a retained PTY can discover it afterward.
- Targeting: Local plus workers with identical cwd/native-session fixtures; worker-local start, same-executor child creation, existing-chat operations on another executor, executor-correct resume/handoff catalogs, and controller-local CLI use with remote existing chats.
- Duplex behavior: a gateway request requiring a callback into the same worker, with credential resolution and producer traffic active; no connection-wide deadlock or starvation caused by CLI serialization.
- Delivery: disconnect before dispatch and after acceptance, fresh sessions, exact-ID recovery, cancellation, and uncertain fork/mutation outcomes. A later definite rejection cannot erase earlier uncertainty. Test ticket explicit retries with the same versus different executor authority; no gateway replay.
- Bounds: escaped JSON, oversized export/list, queue pressure, slow HTTP readers, separate long/short admission, and finite/no-deadline cancellation. Repeated cancellation/session replacement cannot admit unbounded unsettled work.
- Public worker integration in both connection directions, with CLI processes actually spawned from a remote PTY and provider tool execution. Retain the shell across controller restart and long disconnects without retaining an old CLI request's authority.
- Provider sandbox reachability: verify that the inherited descriptor and loopback endpoint are usable under supported provider policies. Do not disable sandboxes or broadly enable networking to make a gateway test pass; any required narrow provider integration needs explicit review.
- Single-channel load: bounded CLI exports/polling together with Files, Git, noisy PTYs, and chat. Confirm explicit failures under pressure and measure latency without claiming isolation.

Use synthetic fixtures, isolated roots, scripted providers, and held-promise/transport interleavings. No paid/live-provider calls. Run repository checks/tests, relevant real-process/browser gates, and a timed fresh server startup. Design documents must not be committed.

## Decision Boundaries

The recommended initial design is a same-path HTTP gateway, one shared Noise connection, explicit workspace-level executor permission, and a context-aware but transport-agnostic CLI. A Unix-domain socket could replace only the local HTTP transport later; it is not required for controller reachability or privacy on the network hop.

Workspace-wide permission is accepted as explicit opt-in. Inline caps and no replay follow the current transport design. Exact admission tuning can change with tests. Full unbounded exports, mutually untrusted per-chat workloads, cross-executor CLI flags, and a second channel require separate scope discussion. Network-restricted provider sandboxes may deny loopback just as they do for controller-local CLI; do not weaken their policies. Verify the support matrix before claiming sandboxed-provider parity.

## Provider Reachability

Environment inheritance is necessary but does not grant sandbox access. The CLI gateway does not alter provider permissions or sandbox settings.

| Caller policy | Gateway support |
| --- | --- |
| Worker PTY under the worker OS account | Supported through the inherited private descriptor and loopback capability. |
| Claude Bash with a user-approved command and no network sandbox restriction | Supported; acceptance uses the real pinned CLI and a scripted model, without live credentials. |
| Codex `workspace-write`, `networkAccess: false` on Linux | Unsupported for direct loopback HTTP. The sandbox network namespace and seccomp policy block host-loopback connections. |
| Codex with an independently selected network-capable policy | Potentially reachable; this bridge never selects or broadens that policy. No parity claim without a policy-specific test. |
| Other provider sandboxes or externally managed network proxies | Environment inheritance only; reachability depends on that policy and is not guaranteed by this feature. |

Upstream evidence is pinned to Codex `rust-v0.156.0`, commit `fe74a774532af67b5a4a3dec03ce9469e17f89af`: the [workspace sandbox contract](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/protocol/src/protocol.rs#L1095-L1111) has a broad network boolean, not a host/port exception; [Linux isolation](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/linux-sandbox/README.md#L81-L89) and [seccomp restrictions](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/linux-sandbox/src/landlock.rs#L201-L231) prevent direct loopback access. The [managed proxy](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/network-proxy/README.md#L20-L65) is a separate configured route, not a narrow exception to that boolean. Supporting it or Unix-domain IPC requires separate policy and filesystem-access verification.

## Verification Record

- `bun run check` passed, including zero Svelte errors or warnings. Server and integration type checks passed again after the final test-only follow-up.
- The full root `bun run test` passed, including all server/provider tests, 594 CLI tests, and 6,713 web tests across 588 files. The final test-only follow-up also passed its focused 23-test worker/gateway/dispatcher run.
- `bun run build` passed. The built-SPA Lightpanda grant/revoke test passed without replacing the worker instance.
- Public-worker acceptance passed in both connection directions, including retained PTYs across controller restart, executor-scoped ticket retries, owning-executor model selection, permission-approved scripted Claude execution, and gateway failure without Local fallback. The direct-controller CLI/ticket subset passed all 25 tests using the repository's 30-second integration timeout.
- A fresh isolated `bun run start --port 0` listened on `0.0.0.0` and shut down under the test timeout. Existing servers were left untouched.
- Both reviewers confirmed the publication, small-reply admission, and optional-gateway startup fixes. Their final coverage request is included in `ce725e1d5`.
- No paid/live-provider tests or simultaneous Files/Git/PTY/CLI latency benchmark were run. Deterministic shared-channel pressure and real duplex workflows are covered; they do not establish traffic isolation.

Implementation commits exclude this document and all other design documents.
