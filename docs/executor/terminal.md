# Terminals On Executors

Status: implemented on Local and remote executors, updated 2026-09-24. The contracts below describe the current transport and govern PTY lifetime, replay, session limits, creation targets, and host selection. Channel splitting remains a separate pending decision. Illustrative wire names are not a replacement for the typed service contract.

This follows [Executor Interfaces](./interface.md), [Executors In The App](./app-integration.md), and [Files On Executors](./files.md). The historical baseline was inspected at `808d869658325b62c60c23782e986f76ded8b7a3`. Terminals reuse the executor-scoped service and transport infrastructure shared with Files and agents.

## Decisions

- Agents, files, and terminals currently share one controller-to-executor Noise WebSocket. This does not settle the channel-splitting decision. Do not add scheduling or lifecycle machinery solely to compensate for sharing a channel.
- PTYs belong to the executor process, not its current controller connection or provider-serving generation. Browser network changes, controller restarts, and arbitrarily long disconnections must not terminate a surviving executor's shells.
- Preserve today's bounded output tail and visible truncation. Full-screen recovery is best effort; users can run `reset` themselves. Do not build screen snapshots or automatically send recovery commands.
- Allow eight retained terminal sessions per principal per executor, including exited sessions until removal.
- Create on the selected project's executor/path, otherwise Local. From an existing terminal, default to its executor and initial directory. When remote terminal hosts are available, desktop New Terminal and the mobile toolbar `+` open a host chooser containing Local and those executors.
- Default terminal labels use the host name and session number: `Local 1` or `<executor label> 1`, not `Terminal 1`. Preserve explicit user titles.

## Scope

Make the existing interactive terminal experience work on Local and remote executors:

- Create a shell in a validated directory on a selected executor.
- List, rename, attach, take over, resize, and explicitly terminate terminals.
- Stream output with bounded replay and visible truncation.
- Preserve desktop/mobile placement, retained xterm runtimes, keyboard/paste controls, and single-browser attachment ownership.
- Keep unrelated executors and chats usable when one terminal or executor becomes unavailable.

Terminals are executor-level machine services, independent of agents and chats. A chat may supply the initial executor and directory; it does not own the resulting shell. Chat handoff must not move an existing terminal or restart it elsewhere.

Out of scope: durable terminal recovery, command execution queues, cross-executor process migration, a general ProcessService, shared multi-writer terminals, arbitrary binary PTY transport, shell integration for tracking the live working directory, and terminal output in chat ledgers. Full terminal-screen reconstruction after missing output is not an initial requirement.

## Current Implementation

The process-owned [TerminalRuntime](../../server/runtime/terminals/runtime.ts) lends a service to each replaceable executor session. Local uses that service directly; [RemoteTerminalService](../../server/remote/client/remote-terminals.ts) adapts the same contract over Noise RPC and attachment-qualified events. [TerminalController](../../server/controller/terminals/controller.ts) owns browser routing and authentication, not remote PTY lifetime.

The [terminal service contract](../../server-agents/interface/src/contracts/terminals.ts) supports list, create, rename, terminate, attach, input, resize, and peer cleanup. Lists return process-runtime identity and an attachment epoch. Creates check the expected runtime; attaches check the listed epoch. Qualified IDs preserve executor, runtime, and session identity through browser state and layout.

The browser keeps per-executor inventories, bounded fragments, sequence-gap recovery, and retained xterm renderers. Creation menus offer available hosts with per-executor admission. Default names contain the host; custom titles retain host context in the mobile picker. An attachment indicator remains visible at narrow widths.

## Historical Baseline

This section describes the pre-remoting implementation at the revision above, not the current service boundary. Subsequent sections specify the implemented contract and deliberate limits.

### Controller And PTY

[TerminalManager](../../server/runtime/terminals/terminal-manager.ts) lived once in the controller, outside `ExecutionRuntime`. Its state was entirely in memory:

- Sessions are partitioned by server-derived principal and identified by a random terminal UUID.
- Each principal can retain eight sessions, including exited sessions not yet removed.
- Creation validates the initial directory against the controller's configured project base, resolves symlinks, and checks directory accessibility. Null means the project base.
- Shell selection uses the executor-local environment/configuration: on Unix, `GARCON_TERMINAL_SHELL`, then `SHELL`, then `/bin/bash`; Windows uses `powershell.exe`.
- `bun-pty` starts the shell with no extra arguments, an 80-by-24 initial size, inherited environment, and terminal/color variables. Creation does not wait for a browser attachment.
- Create and terminate results are cached for ten minutes. Cache capacity is bounded, and valid entries are not evicted merely to admit another request.
- Rename updates metadata and notifies subscribers. Natural exit preserves the session and its output; explicit termination removes the session and requests PTY cleanup.
- Graceful controller shutdown calls `shutdown()` and requests termination of remaining PTYs. Nothing reconstructs them after restart.

The installed `bun-pty` version is 0.4.10, recorded in [bun.lock](../../bun.lock). Its API delivers strings, uses a streaming UTF-8 decoder internally, and exposes `write`, `resize`, and `kill`. This is the existing implementation to reuse, not replace with pipes or a home-grown PTY engine. A kill request and the library's exit callback must not be treated as proof that every descendant process has died.

The executor contract then advertised `terminals: false`, and `getTerminalService()` was unsupported for both implementations. Local routes bypassed it; remote-target guards and project-resolution UI rejected remote terminal creation.

### Browser Protocol

There is one browser WebSocket endpoint, `/ws`. [PrimaryWsHandler](../../server/controller/ws/primary.ts) multiplexes terminal messages alongside Chat; terminals do not currently open a separate browser socket.

[HTTP routes](../../server/controller/routes/terminals.ts) provide list/create/rename/terminate at `/api/v1/terminals`. [Shared contracts](../../common/terminal.ts) define the stream messages:

```text
Browser -> controller: attach, input, resize
Controller -> browser: attached, output, replay batch/fragment,
                       status, taken-over, terminated,
                       replay-truncated, error
```

[TerminalStreamHandler](../../server/controller/ws/terminal-stream.ts) takes identity from the authenticated socket, not message fields. Authorization expires at the socket principal's token deadline: terminal queues/subscriptions are detached while the shared Chat connection stays open. Browser credential refresh takes effect through a replacement `/ws`, as described in [Security Notes](../security.md).

### Three Existing Lifetimes

| Lifetime | Current semantics |
| --- | --- |
| PTY/session | Continues without a browser attachment; natural exit is retained until explicit removal. |
| Input attachment | One owning peer/client at a time. A replacement socket with the same browser client ID can restore; a different client needs explicit takeover. Displaced subscribers can still receive status/termination, but not live output or input authority. |
| Renderer/placement | xterm is lazy-loaded and retained by the browser registry. Moving/hiding its surface parks the same runtime rather than creating another PTY. Releasing the placement of an exited session removes that session; hiding a running one is not termination. |

The manager serializes input and resize, coalesces only adjacent resizes, and rechecks attachment generation before queued operations reach the PTY. Browser socket closure detaches peers without killing their shells.

### Output And Recovery

Each PTY output callback receives a monotonically increasing terminal `sequence`. [TerminalReplayBuffer](../../server/runtime/terminals/terminal-replay-buffer.ts) retains a one-MiB tail per terminal. Attach supplies `afterSequence`; if that cursor is older than retained output, the server emits `terminal-replay-truncated` before replay.

[TerminalOutputQueue](../../server/controller/ws/terminal-output-queue.ts) already fragments large messages, batches replay, applies byte/count budgets, and rotates delivery across terminals. Ordinary per-terminal overflow detaches that terminal and reports an error; an inability to deliver even control/error traffic can still close the shared browser socket.

[TerminalRegistry](../../web/src/lib/terminal/sessions/terminal-registry.svelte.ts) lists before restoring attachments, fences delayed List responses against newer stream mutations, suppresses duplicate output, assembles fragments, and resends dimensions after attaching. A full page reload starts a new renderer and replays available history; a retained renderer resumes from its received sequence.

Current limits worth preserving or deliberately revisiting:

| Limit | Current value |
| --- | --- |
| Sessions | Eight per principal in the single manager. |
| PTY output replay | One MiB per terminal; oldest complete chunks are evicted. |
| Browser output queue | 256 messages / 16 MiB per socket, also 256 messages / two MiB per terminal. |
| Browser delivery target | 64 KiB of serialized message; larger output/replay is fragmented. |
| Input message | 64 KiB of UTF-8. |
| Pending PTY operations | 1,024 per session, currently a count bound rather than a byte budget. |
| Request-result cache | Ten minutes; 256 entries per principal and 4,096 total. |
| xterm scrollback | 4,096 lines, independent of server replay. |

## Implemented Boundary

```text
Browser terminal registry + retained xterm runtime
                |
      Controller HTTP / primary /ws
                |
    Executor-aware terminal controller adapter
                |
        ExecutionTerminalService
          /                  \
Local terminal manager     Remote facade
          |                  |
       bun-pty       Noise WebSocket / RPC + events
                             |
                    Executor terminal manager
                             |
                          bun-pty
```

`ExecutionRuntimeApi.getTerminalService()` exposes a typed executor service. PTY ownership, output sequence/replay, attachment arbitration, and idempotency live in its process-owned manager. Local routes call the same implementation directly. Do not split local and remote terminal behavior into independent managers with subtly different contracts.

The controller retains HTTP/browser authentication, trusted principal derivation, executor selection, socket delivery queues, and stream-to-browser routing. The executor receives an explicit delegated principal identity from the authenticated controller, not browser-supplied claims or a copied browser bearer token. Avoid importing server HTTP principal types into the shared executor interface; use a narrow transportable authority contract.

The executor process owns its root, shell/environment, PTYs, in-memory terminal registry, replay buffers, attachment authority, and operation ordering. Construct the terminal manager once for that process and lend its service to replaceable connection/provider facades; disposing one facade must not shut down the manager. Inject the actual executor configuration into the extracted implementation. Today's manager reads controller-global configuration and path helpers; merely constructing it in a worker would not establish the correct filesystem boundary.

No worker HTTP listener is needed. Both controller-dials and executor-dials modes use the existing shared Noise connection. The browser continues using its primary `/ws` for Chat and terminals; no new browser socket is introduced either.

## Identity And Authority

Use an executor-qualified terminal reference rather than a bare UUID:

```text
terminal reference:   (executorId, terminalRuntimeId, terminalId)
attachment reference: terminal reference + attachmentId
browser identity:     existing clientId
operation identity:   existing requestId, scoped to principal/executor/terminalRuntimeId
```

`terminalRuntimeId` identifies the process-lifetime terminal manager. It remains stable through controller reconnects/restarts and changes when the executor process restarts. The worker's provider `instanceId` now also has process lifetime, but terminal identity remains independent in the service's list/metadata contract.

Attachments additionally belong to one authenticated controller connection/session. A replacement controller obtains new attachment authority over the same surviving terminal reference; it never reuses an old connection's attachment. Partition sessions by the stable configured executor relationship and server-derived principal, not an ephemeral controller runtime ID. Reauthentication for the same relationship/principal restores access; a different executor identity or principal must not silently adopt another namespace's terminals.

Keep `clientId` distinct from attachment authority. It identifies a browser across socket replacement; it is neither a principal credential nor sufficient to write to a terminal. The executor arbitrates restore/takeover and validates the exact attachment on input, resize, and detach. A stale controller callback cannot detach a replacement attachment just because both use the same terminal/client ID.

All metadata, HTTP controls, stream events, browser maps, fragment accumulators, pending creates, and workspace placements must preserve the qualified reference. Display sequence numbers and titles are labels, not globally unique identities. `local` remains the default only when no executor was specified; an unavailable explicit remote never selects Local.

A controller route captures the terminal and attachment before dispatch. It must not look up the currently selected chat to decide where a keystroke, resize, rename, or termination goes. For create, capture executor plus initial directory once, retaining them through retries and asynchronous project inspection.

## Service And Wire Shape

The following is illustrative, not a finalized method schema:

```text
terminals.list(authority)                         -> terminalRuntimeId + metadata[]
terminals.create(authority, requestId,
                 expectedTerminalRuntimeId, target) -> terminal metadata
terminals.rename(authority, terminal, title)       -> updated title
terminals.terminate(authority, terminal, requestId) -> removal result
terminals.attach(authority, terminal, attachment,
                 clientId, afterSequence, intent) -> acceptance
terminals.input(attachment, data)                 -> acceptance
terminals.resize(attachment, cols, rows)           -> acceptance
terminals.detach(attachment)                      -> detached

executor -> controller: attachment-qualified terminal notifications
```

Control calls reuse typed executor RPC. Streaming output uses an explicit terminal notification variant, not provider `producer` bindings or generic untyped method invocation. Input acceptance is not shell-command completion, and an RPC response is not evidence that a command succeeded.

An attachment also represents the controller's peer subscription for status/termination. Losing input ownership does not remove the existing displaced-client status behavior. Closing the browser socket removes that peer's subscriptions, including any non-owning subscriptions.

Install the controller's notification route before dispatching attach, just as other asynchronous producers require a receiver before they can emit. At the executor, capture the replay frontier and establish the live subscription without a gap. Emit truncation/attached/replay/live events in the defined per-attachment order. Do not return an unbounded replay array inside one RPC result and then attempt to subscribe afterward.

An attach reply arriving after browser close, logout, takeover, or a newer attach must not resurrect the old route. Retire routes synchronously on the controller, perform detach best effort, and fence late events by attachment identity. Keep a single owner of each subscription's cleanup; browser, controller proxy, and executor must not each invent an unrelated terminal lifecycle.

Existing terminal errors remain typed across RPC and HTTP. Extend the contract for executor unavailability, stale terminal runtimes, and uncertain outcomes where needed. Preserve the distinction between a terminal that exited and an executor whose process state cannot currently be observed.

## Process Lifetime

The terminal manager lives for the executor process. Its sessions, replay tails, sequence counters, titles, principal ownership, and unexpired operation results survive replacement of the controller transport and provider-serving generation. They remain in memory; no durable terminal database or process supervisor is required.

| Event | Result |
| --- | --- |
| Browser tab/socket disconnect or authorization expiry | Detach that browser; keep the PTY and bounded replay. |
| Renderer move/hide | Keep the existing runtime/process behavior; no new PTY. |
| Executor-link interruption | Detach transport-bound authority; keep the PTY and bounded replay for as long as the executor process lives. |
| Fresh logical session or provider-serving generation | Replace connection adapters and attachments only. Preserve the terminal runtime, PTYs, and terminal references. |
| Remote controller restart or shutdown | Keep remote PTYs. The new controller lists the surviving runtime and obtains fresh attachments. |
| Executor connector disabled, removed, or reconfigured while worker survives | Remove access/attachments, not the PTYs. Connector management is not an implicit Terminate command. |
| Natural shell exit | Retain exited metadata/replay until explicit removal, as today. |
| Explicit terminal termination | Remove that terminal and request PTY cleanup. |
| Executor process shutdown/restart or crash | Runtime state is lost; orderly shutdown requests PTY cleanup. Do not claim descendant-process death solely from a crash or lost connection. |

There is no executor-link replay grace or detached-terminal timeout that kills long-running jobs. Switching between mobile data and Wi-Fi, or losing the controller for hours, may lose old output from the bounded terminal replay tail but must not kill the shell or reset its terminal identity.

For Local, the controller process is also the executor process. Restarting it ends Local terminal management as today. Remote workers are separate processes, so controller restart does not end their terminals. This is the same process-lifetime rule, not a requirement to introduce a Local supervisor.

Worker composition retains one `ExecutionRuntime` and terminal runtime for the process. Connection cleanup releases that session's terminal attachments, not the manager. Worker shutdown alone owns manager shutdown; controller-side remote-facade disposal must not request remote manager shutdown.

Distinguish process retirement from a lost caller during create. Fence admissions and clean up late spawns when the terminal manager itself is shutting down. If only the controller connection disappears after creation was dispatched, keep the created PTY/result discoverable by the same principal; do not compensate for an unknown reply by killing a possibly running job. Cancel pending attachment publication and old browser routes independently.

Disabling or removing a connector can leave live terminals inaccessible. State that consequence without reporting them terminated. Reconnecting the same executor identity/principal can rediscover them; creating a new executor UUID does not automatically migrate the old namespace. Users should explicitly terminate unwanted terminals before removing access, or stop the worker. Do not add an implicit cleanup timer to avoid this consequence.

Cleanup is best effort, not rollback or verified process-tree termination. Keep normal exit distinct from explicit removal, do not synthesize exit code zero after transport loss, and do not automatically recreate a shell after executor restart.

## Input, Resize, And Reconnect

Preserve one ordered operation path per terminal. Do not dispatch each remote input/resize as unrelated async work and assume WebSocket arrival order guarantees PTY execution order. Resize coalescing stops at an input boundary; input is never coalesced, reordered, or retried as a shell command.

Check attachment generation, authorization, process state, and retirement immediately before native writes. Enforce decoded input bytes, queued bytes/count, and sane dimensions at the executor, not only in the browser parser. A long paste needs bounded ordered chunks or an explicit error; it must not be silently truncated or turn into one oversized RPC.

On a detected executor-link interruption, retire affected input attachments, disable browser input, and reattach with fresh authority after recovery. Keep the PTY, but do not queue new keystrokes while disconnected or resend uncertain input.

This is not instantaneous distributed revocation: input already dispatched or executed before the worker observes the break may have taken effect. Never resend it to resolve uncertainty. Fresh connections preserve the terminal reference but invalidate old attachments; an actual terminal-runtime change invalidates both.

When an executor reconnects, list that executor's terminal runtime and restore eligible attachments even if the browser's primary `/ws` stayed connected throughout. Browser-socket readiness alone does not describe remote terminal readiness. Reconcile only the affected executor, without blocking Local or another healthy executor.

Authorization expiry must survive the extra hop. The controller stops delivery/input and detaches at token expiry as today; delegated attachment authority also needs a bounded expiry checked on the worker so delayed messages cannot extend authorization while the controller is unreachable. Fresh credentials create fresh attachment authority. Browser principal filtering is application access control, not separate OS-user isolation.

## Output Sequences And Replay

Keep these identities independent:

| Identifier | Purpose |
| --- | --- |
| RPC UUID | Correlates one control call and result/error. |
| Terminal output sequence | Orders retained PTY output and browser catch-up for one terminal within its process-lifetime runtime. |
| Fragment index/count | Reassembles one output sequence; never advances the received sequence until complete. |
| Attachment ID | Fences which browser subscription may consume events and send input. |

The authoritative terminal replay tail belongs on the executor. Controller socket queues are bounded delivery state, not a second terminal history. A browser reconnect uses its terminal output cursor, never the transcript ledger cursor.

Split large PTY notifications and replay into bounded application messages before passing them to the executor transport. Keep UTF-8 and ANSI data intact; transport fragments may split bytes, but decode only after complete reassembly or through a streaming decoder. The existing PTY API is UTF-8 text, not a promise of arbitrary lossless binary transport.

The browser registry discards duplicate complete sequences. A jump without an explicit truncation boundary stops that attachment and triggers bounded reattach/replay, rather than silently skipping output. Fragment count, assembled bytes, and lifetime are bounded; attachment/session replacement discards incomplete fragments.

Output loss is allowed only with visible truncation, unlike normalized chat rows. Retained text is a tail, not an emulator snapshot: a full-screen program or ANSI mode may depend on discarded output. Preserve the existing warning and best-effort restoration. Users can run `reset` themselves after connectivity problems; do not automatically inject that command, reset a retained renderer, or add screen-state reconstruction.

Preserve output-before-exit-status order at each delivery boundary. Natural exit does not immediately remove metadata or replay. Verify native trailing-output behavior with a real PTY; neither transport acknowledgement nor a mocked exit callback proves all native output was drained. Explicit termination may discard subsequent output as today.

## Current Transport And Bounds

The current implementation shares one Noise channel for terminal control/output, Files, and agent traffic. Do not introduce priority lanes, weighted queues, adaptive scheduling, or a new cross-service scheduler. Keep the existing browser terminal queue and its round-robin behavior; preserving that code is not a request to generalize it into executor-wide traffic scheduling.

Terminal output is an unbounded producer, unlike a bounded file snapshot. Every channel arrangement needs basic size/admission limits, not a promise to queue every byte until delivery. The minimum policy is:

- Bound output queues per attachment/terminal and per executor, plus input bytes and pending control calls.
- Use small serialized frames; the current 64-KiB browser target is a reasonable starting point, with allowance for the extra executor envelope.
- Admit terminal output only while bounded transport capacity is available. If it is not, detach that output delivery and require replay/reattach instead of adding a scheduler or an unbounded wait queue.
- Make that decision before assigning transport ordinals. Never discard or reorder already-numbered reliable messages to make space, and preserve per-terminal output/status order.
- Keep the PTY draining into its bounded replay tail while delivery is detached. Emit truncation when needed on reattach; dropping delivery must not kill or indefinitely block the user's job.
- Check the browser renderer boundary too: xterm `write()` is asynchronous, and a drained network socket does not prove the renderer has consumed its queued text. Keep queued renderer work bounded; a render-credit protocol is not automatically required.

The renderer admits up to 16 MiB of queued UTF-16 text, leaving headroom above a full one-MiB UTF-8 replay tail. If that queue fills, the registry detaches delivery without advancing the rejected sequence. Once xterm drains accepted text, it automatically restores from the last accepted cursor. A throttled hidden tab resumes when parsing runs again. This does not retain rejected output locally; the executor's bounded tail and explicit truncation policy still apply.

The current executor send path treats exhausted socket/replay budgets as continuity failure. Basic output admission must stop avoidable terminal overload before handing more messages to that path; it is a bounded accept-or-detach check, not prioritized delivery. If the shared connection nevertheless fails, recover attachments through the normal reconnect path without terminating PTYs.

The installed PTY abstraction has no general pause/resume interface. Do not add OS-level flow control now: blocking a long-running program to preserve every output byte is not the intended policy. Reuse straightforward message-size and capacity checks introduced for Files where suitable, without imposing terminal truncation on provider rows or treating terminal input like retryable file reads.

The current shared channel does not guarantee latency or failure isolation between workloads. Observe terminal input/chat latency during file transfers and PTY floods to inform the pending channel decision; do not preemptively build scheduling machinery. Terminal process identity and lifetime must remain independent of channel arrangement.

## Control Outcomes And Enumeration

Retain create/terminate request IDs end to end, independently of the RPC UUID. Cache them in the process-owned terminal manager where side effects occur, preserving unexpired entries across controller sessions. Retry only the same captured operation within its known terminal-runtime/cache lifetime; bind the request ID to its original target, and reject changed parameters rather than silently creating a different shell. Create includes the terminal runtime expected from List so a request for a crashed worker cannot silently create a new shell on its replacement.

The browser distinguishes typed `terminal-outcome-unknown` create errors from definitive refusals, preserving the pending create and its request ID when dispatch is uncertain. A retry after idempotency expiry or terminal-runtime change requires authoritative list reconciliation and a deliberate new create, not automatic replay into an empty cache. A mere provider-serving generation change must not clear terminal idempotency or cause another spawn.

Termination success means the terminal session was removed and cleanup requested, not that all descendants were verified dead. If the reply is lost, retain the target/request ID and reconcile against that executor's list; do not remove the UI and claim success solely because the executor is offline. A stale terminal runtime is different from an idempotent removal of an already-missing terminal in the current runtime.

Make list authority executor-local. A successful Local response must not prune remote sessions merely because an offline worker supplied no list. Either query executors independently or return explicit per-executor ready/unavailable snapshots with their terminal runtime identity. An empty successful list is authoritative only for the stated executor and terminal runtime. Preserve existing mutation-version fencing for create, rename, exit, and removal races.

The browser's retained entries can show disconnected/unavailable state, but cannot establish that a remote process still exists. Reconcile and prune only from the appropriate authoritative snapshot, explicit removal, or a confirmed terminal-runtime change. A provider-serving generation change or expired transport replay window is not such evidence. Bound retained maps/queues and clear controller-side routes when an executor is removed, without terminating its remote PTYs; do not add a durable controller terminal registry just to support presentation.

## Executor Selection And Workspace UX

### Host Picker

Use the existing creation entry points, not a separate executor-selection dialog:

- Desktop: when at least one enabled, ready remote executor advertises terminal support, the inline New Terminal button opens a host menu. Where New Terminal is already a menu item, turn it into a submenu with the same choices.
- Mobile: under the same condition, the terminal toolbar `+` opens a touch-accessible host menu rather than immediately creating a shell. Preserve this choice when responsive layout moves the action into an overflow menu.
- Show `Local` first, followed by remote executor labels in the executor list's order. A connection alone is insufficient: a remote must advertise terminal support. Executors without that capability are not creation targets.
- Selecting a host creates on that host using the directory rules below. Opening or dismissing the menu creates nothing. With no remote terminal hosts available, keep the existing direct-create interaction and its target validation; do not silently redirect an unavailable remote context to Local.
- Creation availability is per host. Keep hosts at their eight-session limit visible but disabled with the limit reason. One full or unavailable executor must not disable the chooser or creation on another executor. Revalidate capability, readiness, and quota on selection; if the selected executor disconnects, fail for that executor rather than creating elsewhere.
- A host that becomes unavailable while the menu is open must not turn the same interaction into an implicit Local create. Disable its entry and keep the selected executor identity explicit through dispatch and retries.

Keep the existing list of retained/unplaced terminals separate from the host choices for creating a new one. Reopening an existing terminal always uses its own reference, not a selected creation host. The empty terminal launcher and other New Terminal entry points must use the same host-selection policy and creation admission rules.

The relevant existing entry points are [WorkspaceWindowAddMenu](../../web/src/lib/components/workspace/WorkspaceWindowAddMenu.svelte), the toolbar in [TerminalSurface](../../web/src/lib/components/terminal/TerminalSurface.svelte), and [TerminalLauncherSurface](../../web/src/lib/components/terminal/TerminalLauncherSurface.svelte). Share the host choices and admission policy rather than duplicating executor filtering and quota rules in each renderer. Preserve keyboard navigation, touch selection, focus return, and the retained terminal renderer when a menu opens or closes.

### Creation Target

The host choice overrides the default executor, not the filesystem namespace:

- New Terminal from a project/chat context captures that context's executor and validated directory. With no project target, use Local and its configured base; explicit remote failures never fall back.
- Choosing the context's executor keeps its validated directory. Choosing a different executor uses that executor's configured base unless the user explicitly supplies a directory for that executor. Never copy a Local or another executor's path merely because its string might also exist on the chosen host.
- The host menu can create at a remote base even without a selected chat. Directory browsing may reuse Files when available; terminal creation itself only requires project inspection and a valid path.
- New Terminal from an existing terminal makes its executor explicit and defaults to the same executor and initial directory unless the user chooses another target. Do not claim to know its current shell directory after `cd`.
- Existing terminals remain on their captured executor across chat switches, handoffs, desktop/mobile moves, and renderer parking.

[TerminalPlacementService](../../web/src/lib/workspace/terminal-placement-service.ts) obtains a captured executor/path target from [workspace project resolution](../../web/src/lib/workspace/workspace-project-path-resolution.ts). Retry state preserves that target, and placement rollback and termination cleanup remain scoped to the created terminal.

### Labels And Placement

Replace the default `Terminal <number>` label with `<host label> <number>` in the terminal toolbar/session picker, workspace tabs, and retained-terminal menus. Local uses the literal host label `Local`; remote executors use their configured display label. For example, `Local 1`, `Local 2`, and `Build Server 1` can coexist.

Use the existing executor/principal-scoped `displaySequence`, not a list index or a controller-global counter. Closing another terminal, taking over an attachment, or reconnecting must not renumber surviving sessions. An executor-label edit updates default display labels without renaming the shell, changing terminal identity, or remounting xterm. Labels are presentation, never routing keys.

Preserve explicit user titles from Rename; clearing a title restores the host-based default. Keep the host identifiable in terminal context even when a custom title replaces the default. Centralize this in the existing [terminal display-name helper](../../web/src/lib/terminal/sessions/terminal-display-name.ts), rather than giving mobile and desktop separate naming rules. Model/agent selection remains irrelevant.

Qualify [workspace surface references](../../web/src/lib/workspace/surface-types.ts) and list-driven layout reconciliation. Do not key a retained xterm solely by a potentially colliding terminal ID, and do not remount it on unrelated chat/executor selection. Keep tab close, hide, process exit, and explicit terminate as distinct operations. A disconnected remote tab can still be hidden without falsely claiming its process was terminated.

The session cap is eight per principal per executor, counting exited retained sessions. UI admission applies to the selected executor; aggregate controller queue budgets remain independent. Do not introduce distributed controller-wide terminal quotas. Detached sessions still count; reaching the limit asks the user to terminate a session, not evict a long-running job.

## Security And Operational Limits

A terminal is a shell with the executor OS user's privileges. Validating its initial directory does not sandbox it: the shell can `cd` elsewhere, run programs, and access anything that OS user can access. Principal ownership prevents one app user attaching to another's terminal; it is not machine isolation.

Use the worker's shell, environment, and root, not values silently inherited from controller configuration. Do not send the controller's environment or credentials as part of terminal creation. Keep the worker's existing remote-CLI restrictions: a remote shell does not automatically gain a functioning controller-connected `garcon` CLI. That requires a separate authenticated CLI design.

Noise covers controller-to-executor traffic, not the browser hop or terminal contents at rest/in memory. Do not log keystrokes, output, tokens, or connection secrets. Preserve existing browser token-expiry behavior after remoting, including passive output detachment.

Advertise terminal capability accurately for the executor platform/build. Validate the real native `bun-pty` dependency and shell in the public worker/executable packaging, not only a fake `IPty`. Failure to load/spawn should be terminal-local and typed; it must not prevent unrelated provider execution or Files use.

## Deferred Work

Channel splitting remains a separate pending decision, not a prerequisite for this implementation. A new traffic scheduler is out of scope. Exact queue/frame tuning and wire method names are implementation details, not reasons to expand scope.

Terminal survival across executor process restart, full-screen snapshots, automatic shell reset, and stronger process-tree termination guarantees remain out of scope. Process-lifetime ownership must not accidentally grow into durable execution recovery.

## Verification Criteria

Existing focused coverage lives under [terminal manager tests](../../server/runtime/terminals/__tests__/terminal-manager.test.js), [stream tests](../../server/controller/ws/__tests__/terminal-stream.test.js), [registry tests](../../web/src/lib/terminal/sessions/__tests__/terminal-registry.test.ts), and the [terminal window lifecycle E2E](../../integration-tests/tests/e2e/terminal-window-lifecycle.test.ts). Retain those behaviors and add cross-executor evidence:

- Local plus two workers, colliding terminal/path/title fixtures, and two principals: every control, output event, placement, and replay remains scoped correctly.
- Both connection directions through public worker startup; actual shell startup, Unicode/ANSI output, resize, input, natural exit, and cleanup with the real PTY dependency.
- Same-client browser replacement, different-client takeover, stale detach/attach replies, queued input during takeover, and delayed input at authorization expiry.
- Input/resize order and adjacent-resize coalescing across RPC dispatch; bounded paste without character loss or duplicate execution.
- Output/replay interleaving, explicit truncation, unexplained gaps, duplicate/partial fragments, and trailing output before natural exit presentation.
- Browser network switches, executor disconnect beyond replay grace, fresh logical session, and remote controller restart: the same PTY, terminal runtime/ID, output sequence, and running job survive; only attachments change.
- Worker restart/crash versus controller restart: only the actual terminal-runtime change invalidates terminal references. Local controller restart ends Local management because it is the executor process.
- Executor disable/removal preserves remote jobs while removing access; worker shutdown performs cleanup. A lost create reply preserves the PTY, while process shutdown during an awaited create cleans up a late spawn.
- Lost create/terminate responses, typed uncertain errors, retry expiry, parameter mismatch under reused request IDs, and reconciliation without duplicate PTYs.
- One offline executor during List, stale snapshots after stream mutations, and no pruning or gating of healthy Local/other-executor sessions.
- One shared channel under file transfers, noisy PTYs, and a slow browser: bounded memory/queues, explicit delivery detachment under pressure, reconnect without killing jobs, and measured input/chat latency. No assertion of cross-workload latency isolation or dependency on a new scheduler.
- Desktop inline and submenu creation plus mobile toolbar/overflow creation: consistent Local/remote host choices, capability filtering, per-executor limits, keyboard/touch access, and no spawn on menu dismissal. Disconnect during selection must not redirect creation; choosing a different host must use its own directory target.
- Toolbar, tabs, and terminal menus use `Local <number>` / `<executor label> <number>` consistently; custom titles survive, clearing a title restores the default, and executor-label edits or terminal removal do not renumber or remount surviving sessions.
- Rapid chat/executor switches and desktop/mobile renderer moves without focus loss, unnecessary xterm remount, retargeted input, or a hidden terminal being accidentally terminated.

Deterministic ownership/interleaving coverage lives in the manager, executor-service, controller, registry, and placement tests. Isolated real-worker and browser coverage lives in `integration-tests/tests/server/executor-terminals.test.ts`, `integration-tests/tests/e2e/executor-terminals.test.ts`, and the terminal lifecycle Chromium tests. The criteria above remain a verification checklist, not a claim that every possible interleaving is covered. No paid provider calls are required for terminal-service acceptance.
