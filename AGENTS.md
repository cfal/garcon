# Modus Operandi

This is the operating model for how engineers design, implement, review, and evolve code in this repository.

## Key Directives

- If there was a design doc, ALWAYS re-read it after compaction.
- `docs/transcript-ledger-v5-design.md` is the governing transcript design; re-read it before changing transcript, ledger, history migration, provider publication, paging, replay, or transcript UX behavior.
- Before changing execution, machine services, provider configuration, or their UI, read `docs/executor/transport.md`, `docs/file-structure.md`, and the relevant contract under `docs/executor/` or `docs/providers.md`. Current contracts supersede historical executor proposals.
- Before changing `garcon-cli`, runtime discovery, or HTTP APIs used by the CLI, read `docs/cli.md` and `docs/executor/cli.md`. Executor CLI forwarding is part of the CLI contract, not optional follow-up work.
- Always git clone dependencies into /tmp to inspect if necessary
- ALWAYS refer to Svelte 5, either docs or by cloning the repo, to make sure we're following best practices and canonical patterns
- DO NOT add to tech debt. It is CRITICAL that we keep the architecture clean and rational, even if that means taking longer to fix or refactor what we're working on.
- Use `bun` instead of `npm` or `npx`.
- Use `bun run start --port 0` and a timeout to validate that the server can compile and startup iff there have been code changes.
- DO NOT kill or pkill any running server processes. When testing, always start a NEW server on a different port (e.g. `--port 0` for random or a specific unused port). The user's primary server must never be disrupted.
- Run `bun run test` to validate your changes
- DO NOT use `sed`, remove items using tools if needed.
- DO NOT stop until the goal has been achieved
- DO NOT run git commands that modify the git tree, treat it as read-only unless instructed.
- DO NOT run tests in the background and sleep for variable amounts of time to wait for them to complete, simply run them in the foreground instead.
- DO NOT run the same tests again and again to grep for different output. Instead, forward 2>&1 and `tee` the cargo test to a /tmp file, and grep from it after.
- DO NOT consider backwards compatibility, as the server and client are always distributed together.
- DO NOT use emojis
- Never commit real transcripts or excerpts; durable transcript fixtures must replace all content and identifying values with deterministic generic content and synthetic identities while preserving only the required structure.
- Keep Garcon core lean and agent agnostic. All agent-specific runtime, dependencies, storage, native-history parsing, and translation code must stay behind `@garcon/server-agent-interface` in `server-agents/<id>/`; `server/runtime/agents/default-agent-integrations.ts` is the only core provider import point. The authoritative provider-neutral transcript ledger lives in `server/controller/ledger/` as one SQLite database per chat. Provider-neutral transcript search, its separate derived workspace database, and its fixed Worker pair live in `server-agents/common`.
- `chats.json` owns chat existence, enumeration-required configuration and current bindings, and fixed-size cross-chat relations. Each per-chat ledger owns only that chat's ordered transcript. `chat-metadata.json` is derived preview/list cache; cold or growing per-chat detail may use separate metadata only when workspace enumeration does not require it.
- New provider capabilities are expressed as nullable facets on `AgentIntegration` (like `forking`), not as optional methods on an existing facet; optional methods force per-call guards in core and hide capability differences from the conformance kit.
- cursor is a best-effort provider: unit coverage only, no scripted-model tier. Do not assume scripted or live parity when changing it; Claude and Codex are the reference integrations.
- opencode has pinned real-binary scripted-model coverage (the exact `opencode-ai` binary behind the shared fake Chat Completions model, fully isolated from user config, auth, and sessions; Linux-only) plus a credential-backed DeepSeek restart smoke. Its transport is one spawned `opencode serve` with a process-wide `/global/event` stream; readiness, retry ownership, and prompt-part correlation are locked by the scripted event-stream suite. The runtime watches the spawned process for its whole lifetime (`OpenCodeInstance.server.termination`): a post-readiness death retires the cached instance immediately, fails active turns exactly once, disarms the unavailability cooldown, and respawns lazily on the next demand. In-flight start/resume admissions are fenced by instance identity (`#assertInstanceCurrent`) so a retired instance can never register sessions, publish activation, or receive prompts.
- Pi is a first-class provider with a scripted-model integration tier (deterministic fake-model coverage through the real pinned Pi CLI), same class as Claude and Codex. Its transport is the long-lived Pi RPC process; steering lands at the tool-call boundary.
- Keep execution state ephemeral. Queue entries, pending user inputs, and the command ledger live only for the server process lifetime; restart intentionally starts them empty and must not replay or recover them from disk. `server/controller/chats/agent-ownership-journal.ts` is the durable exception for cross-provider ownership transfers/deletions, not queue recovery. The per-chat SQLite transcript ledger is durable conversation state; the workspace-wide SQLite search index in `server-agents/common` is separate, derived, and rebuildable.
- Keep the controller and worker event loops responsive. Work proportional to a whole transcript or native history (ledger staging, seeding, copying, and deletion; native-history parsing; JSONL forks; token estimation and fitting) runs in bounded steps separated by event-loop turns or on a Worker; one synchronous pass over a long chat stalls every browser socket, heartbeat, and executor link. `integration-tests/tests/server/long-chat-responsiveness.test.ts` guards this in every execution lane, and both processes log event-loop stalls of 250 ms or more with the activities that were running (`trackActivity` in `server/common/event-loop-stalls.ts`). Run a pure whole-transcript transform, such as rendering an export, a share, or a handoff artifact from stored rows, on a `TaskWorker` (`server/controller/lib/task-worker.ts`): feed it rows as the ledger stores them and take its output as bytes, so the controller neither decodes nor serializes the transcript. Split work that must touch main-thread state or arrives incrementally from I/O with a named `EventLoopSteps` (`server-agents/common/src/shared/event-loop.ts`), one instance per operation shared by its consecutive passes, so a step that holds the loop for 50 ms or more is logged with its operation.
- Chat busy-ness has exactly two public questions: `ownsExecution` for exclusive access to a chat's transcript or view, and the processing projection for whether the user should see a turn running. Consume one of them. Do not compose `ExecutionOwnership` fields, provider running state, and reservation state into a new predicate: four features once did exactly that with four different non-nested subsets, and the fork and reload guards ended up contradicting each other. Adding or widening a predicate means updating the `ExecutionOwnership` module documentation and `server/controller/chat-execution/__tests__/execution-api-contract.test.js` in the same change. In review, treat a new boolean on `ExecutionOwnership`, a new predicate on the coordinator's public facets, or an `isChatRunning || ...` composition outside the coordinator as recreating this debt.
- Use the official Claude Agent SDK as the primary reference when changing the Claude integration. It is not a complete source of truth because Garcon adds lifecycle requirements such as provider-neutral queue ownership, but its protocol, process, control, and cleanup behavior should guide the implementation.
- When a provider's stream behavior is ambiguous, check whether the reference implementation already fought the same battle before inventing local semantics. The Python Agent SDK's inline comments and issue references document CLI protocol rationale (turn versus run boundaries, task lifecycle frames versus `background_tasks_changed` snapshots), and its CHANGELOG maps each release to the bundled CLI version whose behavior it describes - compare that against the CLI version Garcon runs.
- Clone references into /tmp pinned to a commit, and cite file plus line as permalinks at that commit in comments and design docs, so the citation survives upstream drift:
  - https://github.com/anthropics/claude-agent-sdk-python - the readable mirror of the closed-source TypeScript SDK; its comments state where they mirror the TypeScript implementation, so treat it as authoritative for both.
  - https://github.com/openai/codex - codex-rs holds core, rollout, and app-server behavior; verify fake-server and scripted-model assumptions against the pinned clone, not memory.
  - [https://github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) - SDK contained inside

## Comment Style

- Always be concise
- Use third-person declarative form, eg. "Executes the provided command."
- Include comments that would be helpful for future changes and where the rationale isn't clear from the code.
- DO NOT use separator lines or emojis, eg === or ---
- DO NOT enumerate steps, eg "N.", "Step N." or "Part N" - simply mention what is happening
- DO NOT include comments that are already clear from the code

## WebSocket and API Contract Discipline

- Protocol payloads must be typed on both sender and receiver paths.
- Message type names and fields must be stable and explicit.
- Add contract tests when introducing/changing payload shape.

Required for every WS/API contract change:

- Update type definitions.
- Update sender and receiver logic.
- Add or update tests.
- Add migration note in PR description if behavior changed.
- Within a chat, `chat-messages` precede the emitting turn's terminal-driven `chat-processing-updated`, `chat-session-stopped`, and `agent-run-finished`/`agent-run-failed`; the server-event-wiring task queue enforces this, and new per-chat lifecycle broadcasts must be scheduled through it, not emitted synchronously.

## Tool Use Contract Discipline

- Normalize tool-use messages on the server side before they cross the shared boundary.
- Keep the client provider agnostic at the registry and renderer layers.
- Map generic cross-provider tools to shared canonical message types such as `bash-tool-use`, `read-tool-use`, `edit-tool-use`, `write-tool-use`, `web-search-tool-use`, and `web-fetch-tool-use`.
- When a provider emits a tool that cannot be represented cleanly as an existing generic tool-use message, add an explicit provider-specific shared message type instead of leaking the raw provider tool name into the client.
- Name provider-specific tool-use messages with an explicit provider prefix, for example `amp-oracle-tool-use`.
- Do not ship known tool behavior through `UnknownToolUseMessage`.
- Do not add or preserve client parsing or rendering paths that depend on `unknown-tool-use` for known tool families.
- Do not key frontend display behavior off `UnknownToolUseMessage.rawName`.
- Keep agent-specific translation logic inside the owning `server-agents/<id>/` package.
- Keep `common/chat-types.ts` as the single shared contract for all rendered tool-use messages, including provider-specific explicit variants.
- Keep tool display action labels in `web/src/lib/chat/tools/tool-display-registry.ts` as canonical English provider vocabulary unless a dedicated localization project changes the registry and its tests.

Required for every known tool-use addition or change:

- Update `common/chat-types.ts` with the explicit message class, parser support, and union membership.
- Update the relevant agent converter to emit the explicit tool-use class instead of `UnknownToolUseMessage`.
- Update frontend display contracts and registry entries to resolve by message `type`, not agent raw name.
- Add or update converter tests, shared round-trip tests, and frontend rendering tests.
- Remove any client-side aliasing or raw-name rule that the new explicit type replaces.
- Bump `EXECUTOR_PROTOCOL_REVISION`: rendered messages cross the executor link, and a controller cannot read a message type it does not know.

## Clean Code Rules (Practical)

### Server Ownership

See `docs/file-structure.md` for the full layout. Former top-level server application domains now live under `server/controller/`. Former `server/lib/` helpers are split between shared primitives in `server/common/` and controller-only helpers in `server/controller/lib/`; do not recreate the retired paths.

- `server/controller/` owns application policy, durable controller state, HTTP APIs, and browser WebSocket delivery.
- `server/runtime/` owns machine services and provider hosting. Local and remote workers instantiate the same `ExecutionRuntime`.
- `server/controller/agents/` owns chat-facing orchestration; `server/runtime/agents/` hosts integrations. Provider implementations remain in `server-agents/<id>/`, not either core `agents/` directory.
- `server/remote/client/` implements `ExecutionRuntimeApi` over RPC; `server/remote/server/` dispatches onto an injected runtime. `server/remote/transport/` owns the shared encrypted channel and wire protocol.
- `server/common/` contains backend primitives. Runtime and remoting must not import controller modules; common must not import any of those owners. Only `server/remote/worker.ts` composes concrete runtime services into remoting.
- Keep browser/server DTOs in top-level `common/` and provider-specific code behind `@garcon/server-agent-interface` in `server-agents/`.
- Use executor terminology for execution targets and `executorId` for their identities. Graph nodes, DOM nodes, and linked carryover nodes are unrelated concepts.

### Remote Executor Contract

Every execution, machine-service, and related UI change must account for Local and remote executors, not just the controller's machine.

- Route machine operations through the selected `ExecutionRuntimeApi`, including Local. Paths, symlinks, native sessions, executables, environment, and `localhost` belong to that executor. Repository and model-generation targets can differ.
- Qualify executor-owned resources and their caches, recents, and recovery drafts with `executorId`; scope ephemeral handles to their declared runtime/session/binding. Capture the owning panel or operation's target, not global chat selection. Fence dispatch and publication across awaits; never retarget stale work or fall back from an explicit remote to Local.
- Treat readiness and capabilities per executor, independently of browser WebSocket connectivity. An unavailable executor must not block controller startup or healthy hosts. Preserve unavailable selections and drafts; invalidate affected catalogs and revalidate execution admission on every submit path without gating controller-only actions. Empty success is not an offline result.
- Reuse the shared Noise WebSocket in both dial directions; a worker may have no reachable inbound HTTP endpoint. Bound encoded payloads, queues, and in-flight work. Liveness must observe authenticated transfer progress. Do not add channels, schedulers, or replay as incidental feature work.
- Bump `EXECUTOR_PROTOCOL_REVISION` (`server/remote/transport/rpc-protocol.ts`) in any change to what the controller or worker sends or accepts over the link. Builds of one release share a package version, so without the bump a mismatched controller and worker pass the handshake and fail mid-session.
- Each disconnected socket retires its session; there is no transport replay. Continuity lives at the application layer: producer notifications and lost launch outcomes resume through the worker's `ProducerRelay`, journaled RPC replies through its `RpcReplyJournal`, and a request is sent again only when the worker proves it never arrived: a journaled call by its per-session sequence number, a launch by its relay's record of the launches it received. Classify every new RPC method in `rpcContinuity`: resources that end with their session stay `session`, and cleanup of a resource that outlives its session, such as a fork, a path preparation, or a producer binding, is `journaled`. Timeout, cancellation, and lost replies without a journal record are not rollback or proof of non-execution. Preserve definite versus unknown outcomes; retries require the operation's existing idempotency and generation guarantees. Start/resume/compaction have no implicit RPC deadline.
- Worker processes outlive connection authority. Disconnected native turns may continue. Within the reconnect grace the executor is `reconnecting`: calls wait for the replacement session within their own deadlines, except that an interactive operation holding a chat or queue-control lock bounds its waits by one `interactiveDeadline()` taken when it asks for the lock (its calls pass it as `dispatchDeadline`, and a turn's preparation does not count against it; read-only calls also end near it; background work passes none), runs stay active, pending permissions stay pending, Stop is delivered after resume, and the next session resumes each transcript binding from the controller's last received sequence number; retained output beyond the relay budget drops oldest rows first and surfaces as one gap notice. After the grace, or when the worker restarted, fence old publication and permissions, preserve native busy guards, report uncertainty, and retain explicit native Reload recovery. Remote PTYs survive browser/controller disconnects and restarts while the worker survives; preserve bounded terminal replay, not transport replay. Local shares the controller's process lifetime.
- Handle late success and failure against the captured operation. Clean up late remote resources only through their originating session, never a replacement; a journaled cleanup call that session loses is reconciled with the same worker instance, never another. Cancellation must not release process-owned mutation locks or admission while the underlying work remains unsettled.
- Provider profiles remain controller-owned; assignments and revisions gate execution and credential release on Local and remote executors. Derive reverse-RPC origin from the authenticated connection. CLI access is a separate, default-off workspace-wide grant. Revocation cannot erase disclosed credentials or undo admitted work.
- Reuse executor reference-publication guards when changing durable references or deletion. Retain protection through failed or uncertain writes; do not equate an in-memory change with durable removal or publish configuration grants before durability.

### CLI Forwarding Contract

Every CLI command and CLI-facing API change must account for both direct controller HTTP and the executor's loopback gateway. Working only against the controller is incomplete.

- Keep `cli/garcon-client.ts` HTTP-only and command logic transport-agnostic. `server/remote/server/cli-gateway.ts` forwards allowlisted requests over the existing Noise connection via `controllerCli.*`; `server/controller/executors/cli-dispatcher.ts` invokes the same controller handlers with delegated authority. Do not require worker access to the controller's HTTP listener, add a generic proxy, or duplicate command implementations on the worker.
- When adding or changing a client HTTP operation, review `CLI_OPERATIONS` and envelope validation in `server/remote/transport/cli-protocol.ts`, gateway adaptation, and controller dispatch together, and bump `EXECUTOR_PROTOCOL_REVISION` when forwarded operations or payloads change. Keep exact method/path allowlisting, typed payloads, executor-target validation, mutation classification, deadlines, admission pools, and encoded request/reply bounds aligned. A new controller route is not automatically available through the gateway; never widen forwarding to arbitrary routes or settings payloads.
- Derive CLI origin from the authenticated executor link and enforce the current default-off `allowControllerCli` grant. Preserve delegated-executor principals, session/authorization checks, and reply-publication guards. Never substitute Local authority, trust caller-supplied origin, forward the gateway bearer as controller authentication, or copy controller credentials to workers.
- Keep origin separate from execution target. New starts, standalone catalogs, and native-session lookup use authenticated `defaultExecutorId`; existing-chat operations use the chat's owning/target executor and ownership fences. Resolve cwd and read stdin/write output files on the CLI machine. Do not interpret worker paths on the controller or silently replace an omitted executor with Local.
- Preserve endpoint identity, captured controller `serverInstanceId`, and RPC-session fencing through dispatch, polling, and operation-specific recovery. Forward application status, JSON errors, and supported retry metadata without gateway-specific success envelopes. Disconnects, cancellation, or undeliverable mutation replies may mean unknown outcome; never add gateway replay, automatic retargeting, or retries outside the operation's existing identity guarantees.
- Discovery/configuration changes must preserve inherited config-root/role selection for controller and worker provider/PTY children, including gateway startup failure without fallback. Generated follow-up commands and explicit ticket retries must carry the resolved selector; switching from executor to controller changes authority and ticket retry identity. Update `docs/cli.md`, the executor CLI contract, and linked agent skill instructions when syntax or behavior changes.

### General

- Name by domain intent, not implementation detail.
- Keep functions small and single-purpose.
- Avoid boolean-flag overload APIs; prefer specific methods.
- Avoid duplicated business logic across components.
- Avoid "magic strings" crossing module boundaries without types/constants.
- Keep comments high-signal: explain why, not what.
- Remove dead paths quickly.

## Quality Gate

A task is not complete until:

- Scope and ownership are clear.
- New code follows Svelte 5 canonical patterns.
- Side effects are justified and cleaned up.
- Contracts are typed and tested.
- No un-rationalized `svelte-ignore` additions.
- Validation commands pass.

### Pre-Merge Checks for Chat UX

- Rapidly switch chats while queue and processing states change; verify dock and composer position remain stable.
- Verify no focus jump or scroll jump regressions on chat switch.
- Verify background-chat events still update intended caches and previews.
- Verify all submit paths (click, Enter, shortcuts) obey the same validation rules.

## Regression Tripwires

- Do not remount heavy/stateful chat UI on chat switch unless required for correctness.
- Avoid keyed remounts for composer and dock regions; prefer explicit state reset on identity change.
- Keep keyboard and button submit gates identical. If UI disables submit, Enter and shortcut paths must enforce the same predicate.
- Treat WebSocket handlers as per-socket. Guard against stale socket close/open races.
- For filtered event pipelines, add integration tests for filter + router + handler interaction, not only unit tests.
- If adding per-chat caches/maps in UI state, define and implement explicit pruning lifecycle.
- Any change that can move layout during chat switch must include a rapid-switch manual verification note.
- Never name a local variable `state`, `derived`, or `effect` in `.svelte` files -- these shadow Svelte runes and cause silent compilation errors.

## Refactoring Policy

Refactor when:

- a file becomes multi-responsibility.
- effect logic grows hard to reason about.
- protocol assumptions are duplicated.
- regression risk increases due to complexity.

Refactoring rules:

- preserve behavior with tests.
- move in small increments.
- do not intermingle unrelated refactors with feature changes unless required for correctness.

# Frontend Development

## Mission

`web/` must remain a clean, canonical Svelte 5 codebase with clear architecture, explicit contracts, and low maintenance cost.

## Non-Negotiables

- Use canonical Svelte 5 patterns.
- Preserve separation of concerns.
- Favor explicit contracts over implicit behavior.
- Optimize for maintainability over short-term speed.
- Prevent tech debt, do not defer obvious structural problems.
- Leave code better than it was found.
- Theme all UI with semantic design tokens (`background`, `foreground`, `muted`, `card`, `border`, `accent`) and avoid hard-coded color utility palettes in app surfaces.
- For domain/status/provider color accents (for example provider tags, unread indicators, warning states), define semantic intent tokens in `app.css` and consume those tokens in components instead of hard-coded palette classes.
- Use the global `transient-backdrop` class for modal, dialog, drawer, and overlay-sidebar scrims instead of local color or blur utilities; exclude interaction-only layers and opaque surfaces.
- Keep dialog and mobile-surface form controls at a computed font size of at least 16px on touch devices to prevent iPhone Safari from zooming on focus.

## What "Good" Looks Like in This Repo

- UI components are small and focused.
- Stateful behavior is isolated into stores/services with clear ownership.
- Effects exist only where side effects are unavoidable.
- Data flow is obvious from parent to child and from event to handler.
- Protocol contracts are typed and tested.
- Accessibility and keyboard behavior are first-class.
- Performance budgets are actively guarded.

## Architecture Map and Ownership Boundaries

### UI Layer

Location: `web/src/lib/components/**`

Responsibilities:

- Render state.
- Handle local interaction.
- Delegate side effects and business logic to stores/services.

Rules:

- Components do not own cross-feature business logic.
- Components do not duplicate backend mutation logic if a parent/store owns it.
- Prefer composition over one large "god component".

### State And Domain Placement

Location:

- `web/src/lib/<domain>/<concern>/**` -- reusable feature-domain state, controllers, services, and pure behavior
- `web/src/lib/stores/*.svelte.ts` -- app-wide state with no stronger dedicated domain owner
- Component-private state classes live beside their owning component

Responsibilities:

- Domain state and transitions.
- Reusable, testable logic.

Rules:

- Domain ownership determines source placement. Rune usage, root construction, or context provision does not by itself place a module in `lib/stores`.
- Once a dedicated domain home exists, keep that domain's reusable state and behavior together instead of splitting it between the domain and flat stores.
- New domains always use `lib/<domain>`. Do not create a new `lib/stores/<domain>` directory. Any surviving store-domain directory is grandfathered only until that domain migrates and must not gain new files.
- Root-owned lifetime is expressed by root construction and typed context.
- State used by exactly one component subtree stays beside that component.
- Components may import domain modules. Domain modules must not import from `lib/components`.
- Integration code stays in `lib/api`, `lib/ws`, or `lib/events`; normalize transport data before it reaches rendering components.
- Large domains use stable concern directories. Do not accumulate unrelated modules in a flat domain directory. `lib/workspace/` predates this rule and intentionally remains a flat domain directory; introduce concern directories when a domain spans multiple distinct user flows, as Chat and Git do, rather than retrofitting cohesive existing domains.
- Use direct module imports rather than domain barrel files.
- Name rune-backed classes by role: `State` for feature/component state, `Store` for shared stores, `Controller` for orchestration, and `Service` for reusable operations.
- Tests live in the nearest owning `__tests__` directory.
- Test doubles use `satisfies` against the production port, or a deliberate `Pick` of that port. Do not hide an incomplete double with `as never` or a double assertion. Deliberately malformed parser inputs are not test doubles.
- `bun run lint` enforces that production domain/store modules do not import the component layer, including type-only imports, and that utilities remain independent of higher layers.
- Public methods should be intention-revealing (`setProvider`, `clearAfterSubmit`, etc.).
- Hide implementation details (private fields, narrow APIs).
- Keep IO coordination out of stores unless that store explicitly owns the IO lifecycle.

### Chat Domain

`web/src/lib/chat/` is the canonical home for reusable Chat behavior and state. Its approved concerns are `actions`, `composer`, `conversation`, `file-links`, `new-chat`, `sessions`, `tools`, and `transcript`.

- `sessions` owns the root Chat session registry and read-receipt outbox.
- `conversation` owns the active conversation lifecycle and orchestration.
- `composer` owns input, attachments, controls, and command parsing.
- `transcript` owns transcript cache, active transcript state, feed models, scrolling, and transcript-derived presentation.
- `actions` accepts only reusable cross-owner user-intent policy or navigation; it does not accept identity generators, parsers, state, or miscellaneous helpers.
- Component-private Chat state remains in `components/chat`.
- Cohesive Chat UI concerns keep components, private helpers, and tests together in `components/chat/<concern>`. The component root retains conversation composition and cross-concern controls; these UI concerns do not replace the reusable `lib/chat` owners.
- Sidebar-only selection state remains in `components/sidebar`.
- Sidebar search renderers and private helpers live in `components/sidebar/search`; reusable search policy remains in `lib/sidebar/search`.

### Git Domain

`web/src/lib/git/` is the canonical home for reusable Git and Commit behavior and state. Its approved concerns are `commit`, `history`, `pull-requests`, `review`, `surface`, `targets`, and `workbench`.

- `commit` owns both the portable Commit controller and workbench commit action.
- `pull-requests` owns GitHub pull-request list/detail state and refresh orchestration.
- `review` owns diff row models, line selection, review drafts, and virtual review.
- `targets` owns repository, branch, and worktree selection.
- `workbench` owns changed-file state and staging orchestration.
- `surface` owns cross-projection invalidation and portable surface coordination.
- Git renderers and component-private presentation state remain in `components/git`.

### Supporting Domains

- `web/src/lib/files/` owns File sessions, editor controllers, and tree state.
- `web/src/lib/project-paths/` owns shared executor-qualified path selection, completion, validation, and pinned-path preferences. Its renderers live in `components/project-paths`; chat mutation dialogs remain under Chat.
- `web/src/lib/components/rich-text/` owns shared Markdown, code, math, and diagram presentation. Chat-reference policy and file-navigation callbacks remain explicit caller contracts.
- `web/src/lib/terminal/` owns Terminal runtimes, input controls, theme, and sessions.
- `web/src/lib/sidebar/` owns reusable Sidebar search parsing/state and the project-collapse store.
- `web/src/lib/chat-map/` owns chat-lineage normalization and retained Chat Map surface state.
- `web/src/lib/chat-canvas/` owns canvas documents, layout/membership rules, undo history, save coordination, and draft recovery. `server/controller/chat-canvas/` persists provider-neutral canvas documents independently of chats and transcript ledgers; renderers and graph-engine adapters live in `components/chat-canvas`.
- `web/src/lib/tickets/` owns the global ticket catalog, detail projections, mutation drafts, and tab-scoped recovery. `server/controller/tickets/` is the synchronous SQLite authority for workspace tickets, comments, relationships, attributed history, and durable operation results. Operation results support explicit retries only; they are never an execution queue or replayed at startup. Ticket renderers and DOM interaction state live in `components/tickets`; HTTP and WebSocket adaptation stay in the integration layer.
- Their Svelte renderers remain in the corresponding `components` directories.

### Utilities Layer

Location: `web/src/lib/utils/**`

Responsibilities:

- Pure helper functions shared across features (clipboard, classnames, etc.).

Rules:

- No reactive state. No side effects beyond the immediate operation.
- Prefer small, focused modules over a single utils barrel.

### Integration Layer

Location:

- `web/src/lib/api/**`
- `web/src/lib/ws/**`
- `web/src/lib/events/**`

Responsibilities:

- HTTP/WS transport.
- Event normalization and routing.
- Contract adaptation between server payloads and UI state.

Rules:

- Do not spread protocol shape assumptions through components.
- Normalize at boundaries, not in templates.
- All protocol changes must be reflected in types and tests.

## Svelte 5 Canonical Patterns

### Runes

- Use `$state` for mutable local state.
- Use `$derived` for computed state.
- Use `$derived.by(() => ...)` for multi-line/complex derivations.
- Use `$effect` only for side effects.
- Never name a local variable `state` in a `.svelte` file -- it shadows the `$state` rune and causes `store_rune_conflict` errors.

Do:

- derive presentation flags, labels, computed lists with `$derived`.

Do not:

- use `$effect` to synchronize state that can be derived.
- write "mirror state" effects unless unavoidable.

### Events and Component Communication

- Use event attributes (`onclick`, `onkeydown`) on elements.
- Use callback props for parent-child communication.

Do not:

- use `createEventDispatcher` for new code.
- use legacy `on:` directive in runes-mode components.

### Props Discipline

- Props are inputs; avoid mutating props directly.
- If two-way coupling is needed, make it explicit with callback props or `$bindable`.

### Context Discipline

- Use typed context factory wrappers in `$lib/context` (`createContext`-based).
- Prefer `getX()/setX()` helpers over raw string keys.

Do not:

- add new string-keyed `setContext/getContext` usage.

### Template Discipline

- Keep templates declarative.
- Move complex logic into script helpers/derived values.
- Avoid opaque inline logic when it harms readability.
- Wrap render-loop items that process external data in `<svelte:boundary>` with a `{#snippet failed(error)}` fallback to prevent a single bad item from breaking the entire list.

### Component Decomposition

When a `.svelte` file exceeds ~300 lines or manages complex state beyond rendering:

- Extract a companion state class into a sibling `.svelte.ts` file (e.g., `ShellRuntime`, `GitPanelStore`, `PromptComposerState`).
- The state class uses `$state` runes and getter-based derived values.
- Constructor options should use getter-backed interfaces (`get prop() { return value }`) to avoid stale prop captures in reactive contexts.
- The `.svelte` file becomes a thin rendering shell that instantiates the state class and binds the template.

## Side Effects and Async Policy

### Effect Policy

Use `$effect` for:

- DOM APIs and subscriptions
- timers
- imperative interop (editors, charts, terminals)
- controlled side-effect orchestration tied to reactive dependencies

Every non-trivial effect should answer:

- Why is this an effect instead of a derived/computed function?
- What are the dependencies?
- What is the cleanup behavior?

### Async Flow Policy

- Handle async failures at the boundary where user feedback is required.
- Await promises when UI state depends on completion (save states, loading flags, etc.).
- Keep optimistic updates explicit and reversible.

### Browser API Policy

`web` is currently SPA-mode (`ssr = false`), but code should still be intentional:

- Access browser globals in predictable places.
- Guard where ambiguity exists.
- Avoid hidden assumptions that would block future SSR work.

## Separation of Concerns Checklist

After completion of a task, verify:

- UI component contains only UI logic.
- Domain state transition lives in a store/class/module.
- API/WS shape conversion occurs in integration code, not templates.
- Parent owns shared mutations; children call callbacks.
- No duplicated flows for the same operation.

## Testing Standard

### Minimum

- `bun run check` must pass.
- `bun run test` must pass (root and `web` when applicable).
- New behavior in stores/event adapters must include tests.

### Where to test

- Store logic: unit tests near store domain.
- Event/router logic: adapter/normalization/reducer tests.
- Critical UI behavior: component-level tests for interactions and state transitions.
- Name DOM-free web tests `*.logic.test.ts` only when they avoid Svelte components, browser globals, and module mocks; these run in the shared Node threads project with `isolate: false`.

### Integration Tests

Integration coverage is mandatory when correctness crosses server, HTTP/WebSocket, persistence, provider, or SPA boundaries. Add black-box server tests under `integration-tests/tests/server` for chat lifecycle, queueing, reconnect, restart semantics (including empty execution state), provider failure, ownership-journal recovery, fork, and deletion behavior. Add Lightpanda tests under `integration-tests/tests/e2e` when the browser workflow itself is part of the contract. Every production regression in these flows must gain an integration test that reproduces it; unit tests remain required for the underlying component behavior.

A bug or flake first observed in a live suite or in production may only be closed by a change that reproduces it deterministically: extend the scripted-model fakes, add a scripted scenario, or add an interleaving test. Adjusting the failing test to tolerate the behavior is not a fix. New provider-behavior coverage goes on the scripted-model tier, not on the protocol-level fakes.

- Configure credential-backed Claude and Codex through their agent-specific `*_TESTING_KEY`, `*_TESTING_BASE_URL`, and `*_TESTING_MODEL` secrets. Never publish the live values in source, docs, logs, or uploaded diagnostics. Scripted-model tests use synthetic configuration.
- Always use the lowest supported reasoning effort in integration tests.
- Keep credential-backed agent suites under `test:live:*`, outside routine test commands.
- Never run live-agent tests locally unless actively changing those tests; rely on the PR CI live-provider gate otherwise.

### Remote Executor Coverage

- Exercise changed cross-boundary workflows through public controller/worker startup on Local and both remote dial directions. Protocol doubles alone do not establish integration correctness. Use each provider's documented test tier; reference-provider behavior requires pinned scripted coverage.
- CLI command/API changes require direct-controller and forwarded-path coverage. Keep `server/remote/transport/__tests__/cli-allowlist.test.ts` accounting for every `GarconClient` HTTP operation; extend gateway and dispatcher contract tests for validation, authority, response parity, and bounds. Exercise affected commands with real CLI processes in `integration-tests/tests/server/garcon-cli*.test.ts` and `executor-cli*.test.ts`, including both dial directions. Changes to discovery, grants, targeting, or recovery also need relevant provider/PTY inheritance, denial/revocation, restart, and uncertain-outcome regressions.
- Use deterministic barriers for disconnect before dispatch, side effects before reply, late settlement, session replacement, and separate controller/worker restarts. Assert no duplicate execution, false success, stale publication, or premature resource release.
- Test identical paths/IDs on different executors, partial outages, and unavailable-to-ready transitions. Browser workflows must preserve drafts and owning-panel identity across switches, reconnects, and provider revocation; click and keyboard admission must agree.
- Transport/bounds changes need slow progressing links, silent half-open connections, and mixed chat/Files/Git/PTY pressure. Assert bounded resources and process survival without claiming latency isolation.

### Regression Focus Areas

- Chat lifecycle transitions.
- Permission request/response flows.
- Queue controls and status handling.
- Editor save/diff states.
- Navigation and context wiring.

## Accessibility Baseline

- Interactive behavior must be keyboard reachable.
- Avoid non-semantic clickable containers when a button can be used.
- Use `focus-visible` instead of `focus` for focus ring styles. Keyboard users see the ring; mouse/touch users do not.
- Every `svelte-ignore` for a11y must include a rationale and a durable reference: a follow-up issue for unresolved defects, or a regression test for an intentional accessible interaction pattern.
- Do not add suppressions casually to silence lint noise.

## Performance and Bundle Discipline

- Watch chunk-size warnings and treat them as actionable.
- Split heavy features (editor/tooling/renderers) when practical.
- Prefer lazy initialization for expensive integrations.
- Avoid reactive churn from broad effects and unnecessary object recreation.
- Lazy-load heavy vendor modules (e.g., CodeMirror language packs) via dynamic `import()` rather than static imports. See `web/src/lib/highlighting/codemirror-language-registry.ts` for the established pattern.
- Vendor chunk boundaries are defined in `vite.config.ts` (`codeSplitting.groups`). When adding a new heavy dependency, add a corresponding vendor chunk entry.
- Gate expensive fetches behind user intent -- defer API calls until the UI that needs the data is actually visible or activated.

## Error Handling and UX Consistency

- Failures should surface as actionable user states.
- Avoid false-success UX (save, submit, execute).
- Keep loading/success/error states consistent across features.
- Ensure abort/cancel paths are real and contract-complete.
- Never use native `alert()`, `confirm()`, or `prompt()`. Use in-app confirmation dialogs and inline error banners.
- Differentiate HTTP errors by status code at API boundaries. Use `ApiError` for structured error propagation.
- All HTTP requests via `authenticatedFetch` carry a default timeout (30s). Pass a custom timeout only for operations known to be long-running.

## Reviewer Guidance

Reviewers should explicitly check:

- effect misuse vs derivation opportunities
- contract mismatches between frontend/backend payloads
- hidden mutable shared state
- duplicated logic and boundary leaks
- accessibility regressions
- missing tests for stateful behavior
- executor-qualified routing, authority/lifetime fences, uncertain outcomes, and Local/remote coverage
- CLI direct/gateway parity, allowlist and policy updates, executor origin versus target, and real forwarded-command coverage

## Practical Do/Don't Examples

Do:

- derive label/value from state with `$derived`.
- pass `onSave`, `onDecision`, `onSelect` callbacks from parent.
- use `createContext` wrappers from `$lib/context`.
- keep chat transport shape handling in ws/router layers.
- extract companion state classes when components grow beyond rendering.
- lazy-load heavy dependencies with dynamic `import()`.
- wrap list-rendered external data in `<svelte:boundary>`.

Don't:

- update computed state in `$effect` if it can be derived.
- embed backend message-shape assumptions directly in multiple UI components.
- add broad a11y ignores for convenience.
- treat tests as optional for behavioral changes.
- use `focus:ring` when `focus-visible:ring` is the correct pattern.
- call `alert()`, `confirm()`, or `prompt()` -- use component-level UI.
- statically import vendor modules that can be loaded on demand.

## Migration and Legacy Rules

- New/updated code should move toward runes-mode canonical patterns.
- Legacy style usage should be reduced when touched.
- Do not introduce new legacy idioms while migrating older code.

## Definition of Done

A task is done when:

- behavior is correct,
- architecture remains clean,
- contracts are explicit,
- tests and checks pass,
- documentation is updated where needed.

If any of these are missing, the task is not done.

## Keeping This Manifesto Useful

- Update this document when architecture/pattern decisions change.
- Prefer concrete rules over vague principles.
- Keep examples aligned with current codebase reality.
- Treat this as an engineering contract, not optional guidance.

## Regenerating Paraglide

- Regenerate Paraglide message modules whenever translation keys are renamed, added, or removed.
- Run this command from the repository root:
  - `cd web && bun run i18n:compile`
- Use the script rather than calling the compiler directly. It carries the `locale-modules`
  output structure that `vite.config.ts` regenerates with, and a bare `paraglide-js compile`
  emits a different layout.
- After regenerating, run validation:
  - `bun run check`
  - `bun run test`
