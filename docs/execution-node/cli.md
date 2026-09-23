# CLI Access Through Execution Nodes

Status: architecture and design, 2026-09-23. The CLI gateway is not implemented. Source was inspected at [9f0020dc9d25f3f7d354df8d8e34baae8c477e26](https://github.com/cfal/garcon/tree/9f0020dc9d25f3f7d354df8d8e34baae8c477e26). New configuration, endpoint-context fields, and RPC names below are proposed contracts.

This extends [Execution Node Interfaces](./interface.md) and [Execution Nodes In The App](./app-integration.md), which deliberately excluded a spawned-CLI bridge. It retains the single-channel policy from [Files](./files.md), [Terminals](./terminal.md), and [Git](./git.md). Existing CLI behavior is documented in [Garcon CLI And Server](../cli.md).

## Decision

Reuse the existing controller-to-worker Noise WebSocket for CLI requests in the reverse direction. Put a small authenticated loopback HTTP gateway in the worker process. It exposes the same CLI-facing HTTP paths, methods, query parameters, JSON bodies, and application responses as the controller, then translates those exchanges into bounded reverse RPC calls.

The CLI continues to use HTTP. It does not open a WebSocket, implement Noise, understand transport ordinals, or participate in execution-node reconnects. It must learn the endpoint's execution context during discovery and use controller-instance fencing, but ordinary command code should not branch on whether the HTTP endpoint is a controller or a worker gateway.

This is transparent application transport, not an unchanged-binary compatibility claim. Today's CLI assumes that its HTTP endpoint and controller are the same process, and several node-sensitive calls omit node identity. Those assumptions must change for both endpoint types.

Recommended authority policy: explicit controller-side, per-node opt-in to workspace-level CLI access. This is broader than the existing controller-interpreted agent-command authority. Do not silently grant it merely because a worker connects. The policy is a proposal to confirm before implementation, not an existing permission.

## Scope

- Make the current CLI operation set usable from provider subprocesses and terminals on an authorized worker, subject to explicit transport bounds.
- Preserve CLI syntax, output formatting, application error contracts, existing command identities, and operation-specific retry rules.
- Work in both connection directions without requiring the worker to reach the controller's HTTP listener.
- Keep the controller as the only owner of chats, transcript ledgers, queues, permissions, application settings, and tickets.
- Keep argument parsing, stdin, cwd resolution, receipt polling, and output-file writes on the machine running the CLI.
- Keep retained remote terminals usable after controller restart without changing their process-lifetime guarantee.

No additional controller-worker channel, traffic scheduler, generic HTTP proxy, controller-side CLI subprocess, durable forwarding queue, new mutation ledger, or automatic agent recovery. Per-chat CLI capabilities, explicit cross-node CLI selection flags, remote directory-picker work, and remote ticket project inference are separate work. Controller-interpreted commands extracted from normalized provider output keep their existing path and authorization rules.

## Existing Behavior

| Boundary | Current behavior and implication |
| --- | --- |
| [CLI discovery](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/discovery.ts) | Reads a named workspace's private `server-runtime.json`, restricts the URL to loopback, and verifies an HMAC challenge before trusting the endpoint. The descriptor's instance is currently also the controller generation. |
| [CLI HTTP client](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/garcon-client.ts) | Centralizes authenticated JSON HTTP requests and response parsing. Selected idempotent submissions reuse their command IDs after verifying the same controller instance. There is no CLI WebSocket client. |
| [CLI orchestration](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/consultation.ts) | New starts send the CLI's cwd but no node ID. Catalog calls also omit node identity, including calls during resume and handoff. A proxy alone would route some remote work to Local. |
| [Receipt polling](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/cli/receipt-poller.ts) | Synchronous start/resume/wait uses separate bounded HTTP requests for receipts, with bounded transport recovery. It does not stream the entire agent turn through one request. |
| [Worker composition](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/execution-nodes/worker.ts) | Deliberately disables spawned-CLI controller discovery. `TerminalRuntime` is process-owned; provider-serving nodes and RPC objects are replaced inside `link.onSession`. |
| [Reverse RPC](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/execution-nodes/manager.ts) | The controller currently accepts only `credentials.resolve`. Adding CLI access extends this explicit reverse-service boundary; it must not expose every controller route. |
| [RPC implementation](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/execution-nodes/rpc.ts) | Already supports concurrent bidirectional calls, UUID correlation, cancellation, and bounded same-session delivery. A controller handler can call back into the worker without a new connection. |
| [HTTP route contracts](https://github.com/cfal/garcon/blob/9f0020dc9d25f3f7d354df8d8e34baae8c477e26/server/lib/http-route-types.ts) | Raw route handlers are callable with a request and explicit principal context. Reuse these handlers or their owning services instead of performing an authenticated HTTP request back into the controller. |

## Ownership

```text
CLI on the controller                  CLI on an execution node
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
           Selected execution node when an operation needs one
```

The worker gateway owns its local listener, descriptor, local capability, admission limits, and adaptation to one captured RPC session per request. It is not a second controller and does not load controller application stores.

The controller dispatcher owns the allowlist, delegated authority, controller-generation check, request validation, application dispatch, and bounded response transfers. It receives the originating node from the authenticated link, not an HTTP header or a caller-supplied principal.

The same shared socket carries agent, Files, Terminal, Git, credential-resolution, and CLI traffic. The loopback listener is local IPC, not an additional network connection between controller and worker. There is no new public worker API. Bind the gateway only to a numeric loopback address on a random port, never to `0.0.0.0`; the execution-node network listener remains a separate existing concern.

## HTTP Transparency

Both endpoints serve the same application request. For example:

```text
POST /api/v1/chats/start
Authorization: Bearer <capability for this local HTTP endpoint>
X-Garcon-Server-Instance: <captured controller serverInstanceId>
Content-Type: application/json

{ ...existing start fields, nodeId: <selected execution node> }
```

Against the controller, the existing HTTP boundary invokes the start handler. Against the gateway, local authentication is consumed at the gateway and the request is carried by `controllerCli.request`; the controller dispatcher invokes that same start handler with a derived delegated-node principal. The gateway returns the controller's application response to the CLI.

The HTTP capability is endpoint-local. A gateway capability is never forwarded as controller authentication, and the controller's local capability is never copied to the worker. The execution-node secret remains private to the connector.

Application status codes, JSON bodies, and applicable `Retry-After` information survive the relay. Do not wrap successful application responses in a gateway-specific JSON object or translate typed domain errors to generic success/failure strings. Gateway and relay failures use explicit shared error codes in the ordinary HTTP error shape.

Only a small header set is supported. Reconstruct JSON content headers, set `Cache-Control: no-store`, and propagate validated retry metadata where needed. Do not forward cookies, caller-supplied authorization, origin, host, proxy headers, redirects, compression negotiation, or arbitrary response headers. The CLI does not currently need conditional HTTP caching or an upgrade through this endpoint.

All gateway application requests require the captured controller-instance header. The direct controller boundary also validates this header when supplied, so the updated CLI uses one request path for both endpoints. Existing browser authentication remains independent; the header is an additional fence, never authentication. Neither gateway nor dispatcher may replace an old expected instance with the current one.

## Discovery And Endpoint Context

Separate proving the local HTTP endpoint from selecting the controller generation behind it.

### Local Descriptor

Keep the existing named-workspace discovery path for a controller-local CLI. Add an explicit runtime-file selection for worker contexts, proposed as `--runtime-file <path>` and inherited `GARCON_CLI_RUNTIME`.

The worker publishes a private gateway descriptor, for example `cli-runtime.json` under its private runtime directory. It contains the local endpoint URL, endpoint process identity, pid/start metadata, and an independently generated local capability. It does not pretend that the worker directory is a controller workspace or contain the controller's filesystem path, bearer token, or node secret.

Reuse secure descriptor reading/writing: atomic publication, owner-only permissions, regular-file and owner checks, and no symlink following. Use a tagged descriptor schema where local-directory semantics differ. The controller, worker, and CLI ship together; an old schema or mismatched build is a clear error, not a legacy fallback.

Runtime-file selection is explicit context. An invalid, missing, disabled, or disconnected gateway never falls back to named-workspace discovery. Conflicting explicit connection selectors are rejected; `--workspace` cannot retarget a gateway to another controller workspace. The authenticated context supplies the actual workspace name used in CLI output. Descriptor cleanup must check ownership/instance so an old process cannot remove a successor's descriptor.

### Two Discovery Requests

Use these paths on both controller and gateway:

1. `GET /api/v1/runtime?challenge=...` proves the local HTTP endpoint using its descriptor capability and endpoint instance. Reuse the existing challenge/HMAC protection; this response need not expose controller workspace information.
2. Authenticated `GET /api/v1/cli/context` returns the current controller context. The gateway obtains it through an authorized `controllerCli.describe` reverse RPC on its current ready connection. The controller-local endpoint returns its own context directly.

The second response is a small shared contract, illustratively:

```ts
interface CliContext {
  readonly serverInstanceId: string;
  readonly defaultNodeId: string;
  readonly workspaceName: string;
}
```

For direct controller HTTP, `defaultNodeId` is `local`. For a worker gateway, it is the authenticated originating node. This is an execution default, not a visibility or authorization filter. It does not constrain list/search to that node.

The gateway may prove its own identity while disconnected, but context discovery must return unavailable then. It must not present stale cached controller context as live verification. Reject discovery while the dispatcher is initializing, the node is not ready, CLI access is disabled, or the controller is quiescing.

After these steps, construct the same `GarconClient` from the HTTP URL, endpoint-local capability, captured controller `serverInstanceId`, default node, and workspace name. There is no command-level `if (isExecutionNodeGateway)` path.

`verifyRuntime()` must verify the endpoint and compare the live controller context with the invocation's captured instance. A stable gateway HMAC proof alone does not prove that the controller survived. A new invocation can discover a restarted controller; an existing invocation never updates its captured controller identity in place.

## CLI Changes

The CLI needs context awareness, not WebSocket awareness:

| Concern | Required change |
| --- | --- |
| Discovery | Accept the explicit gateway descriptor and resolve the shared live CLI context. |
| HTTP client | Add the expected-controller header to application calls; preserve existing response parsing and distinguish bridge delivery errors. |
| Runtime verification | Compare controller generation, not only the stable local HTTP endpoint identity. |
| New execution and catalogs | Pass explicit node identity derived from the operation's context. |
| Existing chat operations | Resolve catalogs and handoff defaults using the chat's owner/target node, even through direct controller HTTP. |
| Automation output | Report the actual controller workspace and controller instance, not worker storage or gateway identity. |
| CLI command logic | Retain parsing, formatting, receipt polling, command IDs, stdin handling, and local output files. |

An entirely unmodified CLI is not a safe target: it would interpret the gateway lifetime as controller lifetime and can send a remote cwd to Local. Do not hide these issues behind a body-rewriting proxy. The small shared context contract removes the need for two implementations of each CLI command.

## Delegated Authority

Propose `allowControllerCli: boolean` on controller-owned remote-node configuration, default false, exposed explicitly in the node editor. Enabling it grants the trusted worker OS account access to the allowlisted CLI operations across this controller workspace, including chats hosted on other nodes. Explain that scope in the permission UI; it is not just permission to inspect the worker's own jobs.

Every reverse call checks the current node entry, link/session ownership, readiness, CLI grant, and controller lifecycle before dispatch. Use `integrationId: ''` for this node-level reverse service; do not treat it as an individual provider facet. Install the dispatcher only after its application dependencies exist, without making remote connection readiness block startup.

Introduce an explicit delegated-node principal with stable node-based authority. Never authenticate a forwarded request using `LOCAL_SERVER_PRINCIPAL`, a fabricated human username, or caller-supplied identity. Node labels are mutable presentation, not authority keys. Shared principal/actor validation and consumers such as ticket attribution must represent this origin honestly and retain their existing author/edit rules. Supplied `--parent` and `--from-chat` values remain declared relations or attribution, not observed provider provenance.

Changing or revoking CLI access does not replace the main node connector or terminate PTYs and agents. It closes new bridge admissions, rejects further result retrieval, and cancels outstanding bridge waits best effort. Already accepted application work is not rolled back or implicitly stopped. Removal/disable/session retirement also fence the relevant dispatcher and results.

This is an OS-account trust boundary, not isolation between processes using that account. The private descriptor and local capability prevent unrelated users or unauthenticated local HTTP clients from gaining access; they do not identify which agent issued a shell command. No browser CORS access is enabled.

Per-chat restrictions would require authenticated run/session context and new delegation policy, especially for shared provider processes and surviving terminals. They are not implemented by trusting a `chatId` argument or inferring it from cwd. Keep that larger model out of this bridge.

## Reverse RPC Contract

Add an explicit typed reverse-service family to the existing protocol:

```text
controllerCli.describe() -> live CliContext
controllerCli.request({ expectedServerInstanceId, http })
  -> inline HTTP reply | HTTP reply metadata plus a bounded result reference
controllerCli.readResult({ reference, offset }) -> { offset, dataBase64, eof }
controllerCli.closeResult({ reference }) -> closed
```

`http` is an enumerated method/path request union, not an arbitrary URL. It carries query pairs and the existing operation's JSON request DTO. Preserve repeated query values and their order where the API uses them; do not collapse a query into a single-value object. Requests and responses retain their shared application types and runtime parsers. One RPC family does not imply an untyped public invocation API.

The normal `AgentRpc` envelope supplies the RPC UUID, request/result/error/cancel frames, and transport correlation. Existing `clientRequestId`, `clientMessageId`, turn IDs, and ticket operation identities stay inside the application body unchanged. They are not replaced by the RPC UUID or message ordinal.

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

Exclude node management and its credentials, provider credential administration, authentication/account routes, Files/Git/Terminal APIs, and any route not needed by the CLI. Restricting a broad endpoint requires validating nested payload fields, not only allowing its URL. In particular, forwarding an unrestricted settings patch would defeat the allowlist.

Keep remote ticket project inference's existing unsupported result; attaching the correct node to that request prevents controller-local inference but does not implement the deferred feature. Likewise, do not expand CLI commands merely because their underlying browser APIs exist.

## Execution Targeting

Origin and target are different identities. Origin is derived from the authenticated worker link and determines CLI authority. Target is a validated execution node or existing chat selected by the operation.

| Operation | Target rule |
| --- | --- |
| New `start` / `start-async` | Explicitly send `context.defaultNodeId`; resolve cwd on the CLI machine and validate it again through that node's project service. |
| Standalone agent/model catalog | Use the context default node. Provider endpoint definitions remain controller-owned; discovery still executes on the selected node. |
| Native-session lookup | Include the context default node to avoid same-native-ID ambiguity across hosts. |
| Existing-chat resume/settings selection | Read the chat's durable node and use that node's catalog. Do not use the HTTP endpoint's default indiscriminately. |
| Agent handoff without a node override | Preserve the existing chat node and use its destination-agent catalog. Do not move execution just because the CLI ran on another worker. |
| Fork/fork-run | Keep the source-chat node and existing fork/handoff semantics. |
| Read/search/status/wait/stop | Keep the explicit chat identity and existing ownership/control fences; no caller-node filter or retargeting. |
| Export/handoff output file | Write on the CLI machine, never on the controller by interpreting the requested output path remotely. |

Require explicit node fields for bridged node-sensitive requests where omission would otherwise mean Local. Do not repair them by blindly rewriting every node or path at the gateway. The context default is not an authorization ceiling: an existing chat may legitimately belong to another node. New cross-node selection flags are not required to make this bridge useful.

Preserve existing ownership epochs, transcript-view checks, permission occurrence/control IDs, and stale-result handling. After an awaited chat lookup, a changed owner may require fresh selection or typed rejection; a matching agent name or filesystem path does not identify the same node. Use portable node paths at the shared boundary without applying controller-native path resolution to worker paths.

## Process And Connection Lifetimes

Construct the gateway beside `TerminalRuntime` in the worker's process scope. Start it before provider or PTY children that need to inherit its descriptor location. Replace only the gateway's active session binding inside `link.onSession`; disposing a serving node must not stop the loopback listener or rotate its local capability.

Inherit a stable descriptor location, not a captured controller generation or controller bearer. A long-lived shell then discovers the current controller each time it starts a new CLI. Clear inherited controller discovery variables before installing worker context. Verify inheritance through each provider's environment construction and the PTY spawn path; do not introduce provider imports into core.

Bind the gateway to the authenticated stable node relationship. A changed node identity is not an ordinary controller restart: refuse to silently repoint retained shells at that different relationship. Explicit re-enrollment is separate from reconnect. Multiple worker processes on one host have separate private descriptors, local capabilities, and gateways.

| Event | Behavior |
| --- | --- |
| Worker starts before its controller | Gateway exists, context/application calls report unavailable, and process startup remains non-blocking. |
| Brief physical disconnect with continuity retained | Reject new forwarding while disconnected; already-sent requests can settle through ordinary same-session replay. |
| Logical session expires or is replaced | Retire pending calls/results on that backing. Keep the local gateway and PTYs; new invocations can use a fresh authorized session. |
| Controller restarts | Existing invocations retain the old `serverInstanceId` and fail their fence. Fresh invocations discover the new instance. No execution state is recovered by this gateway. |
| CLI process exits or aborts its HTTP request | Close the wait/result transfer and request best-effort cancellation. Keep unsettled handler work accounted for; do not infer an agent Stop or transaction rollback. |
| CLI permission revoked | Close CLI admissions and result access without stopping the node's other services. |
| Worker process exits | Stop the local gateway and retire its descriptor/capability. Ordinary worker shutdown still owns PTY cleanup. |

Distinguish endpoint process identity, controller `serverInstanceId`, configured node UUID, logical RPC session, and application command identity. Neither worker `runtimeId` nor provider-serving `instanceId` can substitute for the controller command-ledger generation.

## Delivery And Restart Fencing

The stable gateway credential removes a protection present in direct HTTP: controller restart currently rotates the direct endpoint's capability. Therefore every forwarded request, including reads and polling, must carry the invocation's expected controller `serverInstanceId`, checked at controller dispatch. A discovery probe before retry is not sufficient because restart can occur between probe and mutation.

Use explicit bridge outcomes in the standard error envelope, with names such as `CLI_CONTROLLER_UNAVAILABLE`, `CLI_CONTROLLER_CHANGED`, `CLI_ACCESS_DENIED`, `CLI_SERVICE_BUSY`, `CLI_REQUEST_TOO_LARGE`, `CLI_RESULT_TOO_LARGE`, and `CLI_OUTCOME_UNKNOWN`. Final names belong in the shared error-code contract. The CLI must recognize definite admission/restart rejections instead of treating every 5xx bridge error as an ambiguous mutation.

| Observation | Required handling |
| --- | --- |
| Rejected before forwarding or controller dispatch | Definitive no-dispatch error; no hidden queue or automatic relocation. |
| Complete validated application response | Preserve its status/body, including application-specific partial success or error semantics. |
| Link/cancellation/deadline loss after possible dispatch | Report uncertainty unless a definitive application result exists. Do not describe this as an operation that never ran. |
| Short reconnect of the same logical session | Reuse transport deduplication for the original RPC request/result; do not invent a replacement request. |
| CLI contract permits exact submission recovery | Keep the same application IDs/body and verify the same controller generation; perform the dispatch-time fence on every attempt. |
| Controller generation changes | Stop recovery for that invocation. Do not replay process-ephemeral commands into the new controller. |

The gateway has no application retry loop. Preserve current differences: correlated start/run/steer/control submissions have specific same-controller recovery, plain fork has an uncertain-outcome path, and ticket mutations have their own explicit durable retry contract without automatic CLI resubmission. Do not add a blanket ban or blanket retry that overrides these contracts.

Receipt polling remains in the CLI. Waiting for a turn does not reserve one reverse RPC for the turn's lifetime. Aborting a wait does not stop the agent; explicit Stop remains a separate command. Existing controller queues and command ledgers remain process-ephemeral, with the current durable ticket-operation exception unchanged.

## Bounds, Results, And Deadlines

The shared application frame limit is 16 MiB, not an acceptable size for routine CLI sends. JSON escaping and transport-envelope encoding add bytes; socket/replay budgets are smaller aggregate constraints in other dimensions. A large export must not retire the connection carrying chat and terminal traffic.

Keep small replies inline. For larger JSON responses, freeze one serialized response and return a scoped, pull-based result reference. Reuse the bounded transfer pattern from Files/Git without invoking the underlying application operation for each chunk. The gateway assembles and validates the complete response before returning ordinary HTTP JSON. The CLI does not see transfer handles or chunk RPCs.

Result references belong to the authenticated node, controller generation, exact RPC session, and delegated principal. They cannot be used as Files/Git handles or on a replacement backing. Close on completion, local HTTP abort, authorization loss, expiry, and session retirement. No durable transfer resume or result ledger is added.

Starting internal bounds, subject to resource-bounded tests:

- At most 1 MiB encoded CLI request, including its envelope; preserve any smaller operation limit such as ticket requests. Reject before mutation instead of introducing request-upload sessions.
- Approximately 256 KiB maximum inline response, with explicit envelope headroom; 256 KiB decoded result chunks.
- At most 32 MiB encoded result; no silent truncation or partial JSON success. Existing application truncation/limited-result contracts remain explicit and distinct.
- Four active relay requests and eight retained result handles per node; 64 MiB retained result bytes per node and a separate 128 MiB controller-wide retained-result cap. Admission rejects excess work instead of queueing it indefinitely.
- Two-minute idle result expiry, never beyond the original operation deadline when one exists. Bound simultaneous production/assembly separately from retained handles, including a controller-wide production admission cap.

Result reads and cleanup must not acquire an admission slot held by the request they are completing. Keep reverse credential resolution and controller-to-worker callbacks independent of CLI admission. A canceled HTTP/RPC wait does not release the reservation for a still-running controller handler or response producer; release that reservation only when the work settles, including across session replacement. Once a handler returns a confirmed acceptance, subsequent agent execution belongs to existing controller admission, not a bridge slot held for the whole turn.

Account bytes and reserve capacity before large production/assembly. The existing export implementation builds a complete document; checking its JSON length after construction only protects the wire, not generation memory. Large-response producers need an optional bounded collector/budget that fails the request without changing export contents, watermark semantics, or privacy rules. Do not introduce a second transcript export implementation. The [transcript-ledger design](../transcript-ledger-v5-design.md) remains authoritative.

Mutation replies must have a bounded confirmation/error representation. If an application operation may have committed but its response cannot be delivered or validated, return uncertainty, not a safely retryable size/admission rejection. Return known application receipts wherever their contract permits; do not truncate authored results to manufacture success.

Use operation-specific deadlines from the allowlist, not a caller-controlled arbitrary timeout or the generic RPC default everywhere. Today ordinary CLI HTTP requests use 30 seconds, export/handoff-document requests use 120 seconds, a run with agent handoff permits ten minutes, and some fork/maintenance calls explicitly have no deadline. Preserve those distinctions, propagating the HTTP abort signal through the captured RPC and existing handler. Explicit no-deadline support for the narrow existing operations must remain subject to admission limits, authorization, and session lifetime; do not simulate it with repeated requests or a new job scheduler.

The gateway owns its actual HTTP idle-timeout policy for long requests. Synthetic controller requests have no Bun socket to extend. Chunk reads inherit the remaining operation budget rather than restarting a fresh full deadline on every chunk. Cancellation is best effort; release temporary response storage promptly and unsettled-work reservations on settlement, without claiming accepted work was undone.

These bounds are not cross-service scheduling. One shared channel still permits head-of-line blocking and shared failure. Measure chat/terminal latency under CLI exports and polling; reconsider another channel only if demonstrated interference requires it.

## Implementation Boundaries

1. Extend shared runtime discovery/context and expected-controller fencing for direct HTTP first. Make `GarconClient` context-aware while preserving existing CLI behavior and tests.
2. Make CLI node selection explicit for starts, catalogs, native lookup, and existing-chat operations. Keep transport selection out of command semantics.
3. Define the typed CLI HTTP allowlist, controller dispatcher, delegated-node principal, and explicit node permission. Reuse existing handlers and error contracts; deny unregistered routes by default.
4. Add the process-owned loopback gateway and reverse RPC adapters, including result bounds, cancellation, session fencing, and private descriptor lifecycle.
5. Wire provider/PTY discovery, node-editor permission, public worker startup, and deterministic cross-boundary acceptance. Remove the deliberate CLI-unavailable setup only when the new fail-closed context is installed.

The implementation should not copy all controller routes into the worker, introduce a general process service, or add per-command remote implementations. Frontend work is limited to the explicit node permission; unrelated directory pickers and ticket project inference remain outside scope.

## Verification Criteria

Documentation is not implementation verification. Required coverage includes:

- Contract parity: the same CLI commands against direct controller HTTP and the gateway preserve paths, body DTOs, status, errors, relevant retry metadata, and output. A registry test accounts for every HTTP operation emitted by `GarconClient`.
- Discovery: descriptor permissions/owner/symlink checks, wrong endpoint proof, conflicting selectors, unavailable gateway, correct controller workspace output, multiple workers on one host, and no fallback to an unrelated local server.
- Authorization: opt-in disabled/enabled/revoked, stale node/session, forged origin/principal, unregistered route, arbitrary settings patch, invalid JSON/content type, and local capability rejected as a network/controller credential. Declared chat attribution never becomes observed authority.
- Generation fencing: controller restart between context discovery and dispatch, between retry verification and dispatch, and during polling. A surviving gateway must not authorize an old request against the new controller. New commands from a retained PTY can discover it afterward.
- Targeting: Local plus workers with identical cwd/native-session fixtures; worker-local start, same-node child creation, existing-chat operations on another node, node-correct resume/handoff catalogs, and controller-local CLI use with remote existing chats.
- Duplex behavior: a gateway request requiring a callback into the same worker, with credential resolution and producer traffic active; no connection-wide deadlock or starvation caused by CLI serialization.
- Delivery: held/disconnected transport before dispatch, after acceptance before reply, same-session replay, replacement session, exact-ID recovery, cancellation, uncertain fork/mutation outcomes, and existing ticket explicit-retry behavior. No gateway mutation replay.
- Bounds: escaped JSON near limits, oversized export, admission/retained-byte pressure, chunk offsets/EOF, stale/cross-session handles, expiry, aborted assembly, and both operation-specific and no-deadline cancellation paths. Repeated cancellation/session replacement cannot admit unbounded unsettled work; saturated admissions cannot deadlock result retrieval or cleanup.
- Public worker integration in both connection directions, with CLI processes actually spawned from a remote PTY and provider tool execution. Retain the shell across controller restart and long disconnects without retaining an old CLI request's authority.
- Provider sandbox reachability: verify that the inherited descriptor and loopback endpoint are usable under supported provider policies. Do not disable sandboxes or broadly enable networking to make a gateway test pass; any required narrow provider integration needs explicit review.
- Single-channel load: bounded CLI exports/polling together with Files, Git, noisy PTYs, and chat. Confirm explicit failures under pressure and measure latency without claiming isolation.

Use synthetic fixtures, isolated controller/worker roots, scripted provider coverage, and held-promise/transport interleavings. No paid/live-provider calls are needed. After implementation run the repository checks, unit suites, focused CLI/worker integration suites, and a timed fresh server startup. This documentation-only task requires document/link checks, not those implementation gates.

## Decision Boundaries

The recommended initial design is a same-path HTTP gateway, one shared Noise connection, explicit workspace-level node permission, and a context-aware but transport-agnostic CLI. A Unix-domain socket could replace only the local HTTP transport later; it is not required for controller reachability or privacy on the network hop.

Confirm the workspace-level permission before implementing it. Exact numeric admission/transfer tuning can change based on tests without changing the boundary. Full unbounded export parity, mutually untrusted per-chat workloads, explicit cross-node CLI targeting, and a second network channel require separate scope discussion rather than being prerequisites for ordinary remote CLI access.
