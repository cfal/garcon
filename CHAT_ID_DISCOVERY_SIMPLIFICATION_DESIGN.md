# Chat ID Discovery Simplification

Status: implementation-ready

Target repository: `/garcon/.worktrees/right-align-menu`

Baseline: `origin/main` at `f4d81593ab0370b2ec6f12c9cf0cfd10f0434d6f`

## Problem

Chat-ID auto-discovery currently removes `<garcon-get-chat-id />` from an
assistant message and shows one success or failure notice. Revision 27 achieved
that visible result by deleting the durable request row and compensating for
its absence in two unrelated places:

- control delivery became a three-attempt route-selection state machine that
  watches execution ownership, retargets successor turns, and alternates
  between steering and a direct server-control turn;
- native-activity watermark logic began treating every discovery failure as
  provider evidence, and outcome notices acquired marker-anchored timestamps.

The visible transcript became simpler while the execution and ledger designs
became harder to reason about. The route watcher required new per-chat
ownership waiters, notifications from the queue drainer and coordinator, and
an `AgentEventBus` activity-cleared signal solely to ensure the watcher woke
after provider-only run state changed. The native-activity change coupled a
diagnostic outcome to an advisory drift detector even though the request
marker itself is the provider evidence.

The system should instead distinguish physical ledger rows from visible
transcript rows. One hidden request row can preserve the observed marker and
its timestamp without producing a second visible transcript row.

## Goals

- Preserve exactly one visible outcome row for each accepted discovery
  attempt.
- Persist one hidden `chat-id-request` row for every exact request marker.
- Commit the hidden request atomically with any cleaned assistant remainder
  before delivery starts.
- Keep the request row out of every user-facing and conversational read fold.
- Restore the native-activity watermark predicate and activation-only timing
  that existed before revision 27.
- Deliver once to the emitting captured turn, then make at most one direct
  server-control turn attempt after definitive non-delivery.
- Never retry, retarget a successor turn, or fall back after an ambiguous
  steering outcome.
- Retain lifecycle, deletion, view-replacement, queue, and recursion fences
  needed for correctness.
- Remove all infrastructure that existed only to support route watching and
  repeated route selection.

## Non-goals

- The hidden request row is not durable queued work. Restart does not replay or
  redispatch discovery.
- The direct control turn omits only a user-authored transcript input. Its
  processing and provider output retain the ordinary background turn lifecycle
  and may emit ordinary run errors or attention notifications.
- This change does not alter the settings surface, request marker syntax,
  disclosure envelope, provider interfaces, command ledger, user-input
  idempotency, or public WebSocket payload shape.
- This change does not add delivery acknowledgement or wait for the direct
  control turn to finish.
- This change does not infer whether an ambiguous steer reached the provider.
  It reports the existing generic discovery failure and does not risk a
  duplicate disclosure.
- Existing unrelated transcript, queue, and provider behavior is not
  refactored.

## Current System

### Marker canonicalization and ledger publication

`common/chat-id-discovery.ts` recognizes an exact leading assistant marker and
returns the stripped assistant remainder. `TranscriptLedgerService.#publish`
in `server/ledger/service.ts` currently appends only a nonempty remainder. A
marker-only message therefore advances no ledger ordinal. After that optional
append, it synchronously calls `ChatIdDiscoveryController.request`.

Native import in `server/ledger/imported-drafts.ts` follows the same policy:
the marker is removed, and a marker-only row becomes no imported row. An exact
synthetic `<garcon-chat-id>…</garcon-chat-id>` user input becomes a visible
success notice.

### Read folds

`server/ledger/presentation.ts` is the shared durable-row-to-message boundary.
Pages, replay, rendering snapshots, WebSocket fanout, shares, and ordinary
export all eventually call `ledgerRowToMessage` or its collection helpers.
Conversational context, preview, search, and resend already exclude all notice
rows. `server/ledger/projection.ts` carries only the quarantine notice through
frozen projections, so ordinary notices are already absent from Reload,
handoff, continuation, and fork seeds.

This boundary allows a notice-shaped support row to remain durable while being
absent from all presentation surfaces.

### Native activity

`server/ledger/native-activity-page-reader.ts` schedules a drift probe only
after a successful active newest-history page. It does not run on startup,
provider dispatch, background reads, replay, or timers. The probe is a
transient advisory.

Before revision 27, `server/ledger/native-activity-query.ts` recognized:

- provider rows, sessions, provider terminals, and provider permission rows;
- synthetic provider-originated inputs with no client message ID;
- `chat-id-request` and `chat-id-disclosure` notices;
- only the disabled discovery failure.

Revision 27 removed `chat-id-request` and broadened the final category to every
discovery failure. That made asynchronous diagnostics participate in provider
activity and created timestamp-clamping edge cases unrelated to delivery.

### Control delivery

`server/chat-execution/control-input-delivery.ts` currently performs up to
three attempts. It may capture a new target after a failed direct reservation,
wait on a per-chat route-change watcher, prefer an earlier unsupported error,
and retarget successor turns. Supporting that loop added:

- `ExecutionOwnership.watchOwnerChange` and per-chat waiter state;
- chat-scoped `notifyOwnersChanged` calls throughout coordinator release and
  queue installation paths;
- `AgentEventBus.onRunActivityCleared`, registry forwarding, and server-event
  wiring to wake a watcher when ledger run state clears without an ownership
  transition.

The direct control route itself is smaller. `#scheduleControlRun` reserves
ordinary direct ownership, checks deletion/drain/queue state, creates generated
turn identities, and calls the ordinary `runAgentTurn` path without admitting
user input. Its reservation and lifecycle checks remain necessary.

## Proposed Design

### Hidden request row

Every recognized marker produces this ledger-private notice draft:

```ts
{
  kind: 'notice',
  at: markerTimestamp,
  message: 'Agent requested chat ID',
  detail: { type: 'chat-id-request' },
  providerMeta: null,
}
```

The row is support data, not a shared `TranscriptNoticeDetail`. Its type never
crosses the ledger presentation boundary. A small ledger-local module owns the
durable spelling, draft construction, and row predicate:

```ts
// server/ledger/chat-id-request.ts
import type { LedgerRow, LedgerRowDraft } from './contracts.js';

export const CHAT_ID_REQUEST_NOTICE_TYPE = 'chat-id-request';

export function chatIdRequestNoticeDraft(at: string): LedgerRowDraft {
  return {
    kind: 'notice',
    at,
    message: 'Agent requested chat ID',
    detail: { type: CHAT_ID_REQUEST_NOTICE_TYPE },
    providerMeta: null,
  };
}

export function isChatIdRequestNoticeRow(row: LedgerRow): boolean {
  return row.kind === 'notice'
    && row.detail.type === CHAT_ID_REQUEST_NOTICE_TYPE;
}
```

Keeping the type ledger-private prevents an invisible support row from
becoming a public message contract merely because both use the physical
`notice` kind.

### Atomic publication

`TranscriptLedgerService.#publish` appends the cleaned assistant remainder,
when present, followed by the hidden request row in the same transaction. A
marker-only event therefore commits one hidden ordinal. Delivery starts only
after the append and commit fanout have been scheduled.

```ts
const request = transformChatIdRequest(row.message);
const message = request ? request.message : row.message;

if (message) {
  drafts.push({
    kind: 'provider-row',
    at: message.timestamp,
    message,
    providerMeta: row.providerMeta ?? null,
  });
}

if (request) {
  discoveryRequestAt ??= row.message.timestamp;
  drafts.push(chatIdRequestNoticeDraft(row.message.timestamp));
}
```

All drafts append once. The controller request remains synchronous after the
commit so steering captures the emitting attempt before terminal processing
can replace it.

Multiple markers in one producer batch each leave hidden evidence, while the
controller's same-run dedupe still starts only one delivery.

### Presentation and fold exclusion

`ledgerRowToMessage` drops the hidden request before constructing a
`TranscriptNoticeMessage`:

```ts
case 'notice': {
  if (isChatIdRequestNoticeRow(row)) return null;
  // Existing CLI-row and transcript-notice presentation follows.
}
```

That one boundary hides the row from:

- HTTP newest/older pages and replay;
- current rendering snapshots and reconnect;
- WebSocket `chat-messages` content;
- share snapshots;
- ordinary Markdown/XML export and handoff artifacts.

Existing kind-based folds already exclude it from:

- provider context and carryover;
- search and preview;
- resend scanning and submission lookup;
- Reload, handoff, continuation, and fork frozen projections.

Raw ordinal ranges still include the row. Empty page or WebSocket message
arrays advance their raw cursors exactly like existing hidden `session` and
`run-ended` rows.

### Native import

`server/ledger/imported-drafts.ts` reconstructs the same hidden request draft
at the native assistant timestamp. Import never calls the discovery
controller, so it cannot redispatch control.

```ts
if (request) {
  const at = original.timestamp || now();
  return [
    ...(request.message
      ? [{ kind: 'provider-row' as const, at, message: request.message, providerMeta }]
      : []),
    chatIdRequestNoticeDraft(at),
  ];
}
```

An exact native disclosure input continues to reconstruct one visible success
notice. A marker without a disclosure retains only hidden request evidence and
does not invent an outcome.

### Native drift behavior

Restore `server/ledger/native-activity-query.ts` to its pre-revision-27
predicate. The hidden request row again carries the marker's provider
timestamp, so no failure-category broadening or fallback watermark is needed.

The scheduling semantics remain unchanged: only a successful active newest
page may schedule the probe. Startup remains inert.

Outcome notices retain the marker timestamp because every ledger row requires
an `at`, the visible request/outcome ordering should remain stable, and the
restored predicate still recognizes legacy disclosure and disabled rows. The
hidden request—not generic delivery failure—is the authoritative marker
evidence.

### One-shot delivery policy

Delivery receives the emitting `runId` and captures a steering target once,
synchronously, before its first `await`.

```text
exact target for emitting run?
  no  -> attempt one direct control reservation
  yes -> attempt one steer
           accepted or prepared success -> finish
           ambiguous/unknown             -> fail, no fallback
           definitive non-delivery       -> await that exact attempt settlement
                                             -> attempt one direct control reservation
```

Definitive non-delivery consists only of:

- `STEER_TURN_UNAVAILABLE`;
- `STEER_TURN_CHANGED`;
- `STEER_TURN_NOT_STEERABLE`;
- `OPERATION_UNSUPPORTED`;
- `STEER_NOT_DELIVERED`.

`STEER_OUTCOME_UNKNOWN`, validation errors, provider rejection, shutdown, and
unexpected failures are terminal. They do not authorize another disclosure.

The implementation remains a small provider-neutral delivery class because it
is independently testable and keeps feature orchestration out of the
coordinator:

```ts
async deliver(
  chatId: string,
  content: string,
  transcriptViewId: string,
  emittingRunId: string | null,
  signal: AbortSignal,
  onControlRun: (turnId: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  const captured = emittingRunId === null
    ? null
    : this.options.captureTarget(chatId);
  const target = captured?.identity.turnId === emittingRunId ? captured : null;

  if (target) {
    try {
      await this.options.deliverSteer(chatId, content, transcriptViewId, target);
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!isDefinitiveNonDelivery(error)) throw error;
      await waitAbortably(target.attempt.waitUntilSettled(), signal);
    }
  }

  signal.throwIfAborted();
  await this.options.scheduleRun(
    chatId,
    content,
    transcriptViewId,
    onControlRun,
  );
}
```

The class contains no attempt counter, pending target, first-error preference,
route watch, ownership-acquired callback, or successor capture.

### Direct route

`ChatExecutionCoordinator.#scheduleControlRun` keeps the existing direct
reservation and lifecycle path. It drops only route-watch bookkeeping and the
special blocked-error subclass.

The direct disclosure has no separate transcript input row. Garcon
passes the disclosure envelope directly to `runAgentTurn`; the one visible
success notice is the durable audit and presentation of that accepted control
delivery. It is a server-control turn: no user-authored `user-input` row is
fabricated, while processing and provider output remain ordinary.

The route:

- generates fresh request, message, and turn IDs;
- reserves direct ownership through the coordinator's sole public busy
  predicate;
- rejects deletion/drain suppression, missing chats, aborted admission,
  pending queue entries, and paused queues;
- registers the control turn ID before dispatch for recursion fencing;
- calls `#runDirect` with the exact disclosure envelope and a fresh
  `clientMessageId` that cannot match prepared user input;
- returns after the run is scheduled, not after provider completion;
- releases ownership on every pre-dispatch error;
- leaves provider/run failure to ordinary lifecycle history.

A busy reservation, queued successor, pause, deletion, or shutdown becomes the
generic discovery failure. No watcher waits for another route and no retry
targets later work.

### Alternatives considered

#### Use the success notice as the physical provider input

The visible success notice corresponds semantically to the direct disclosure,
but it should not be the same physical row. The provider input must be known
before dispatch, while “Sent chat ID …” becomes truthful only after direct
ownership and scheduling succeed. An append-only row cannot transition from a
pending input into an outcome. Appending it before reservation would declare
false success on contention; appending it afterward cannot serve as
durable-before-dispatch input. The hidden request row supplies the pre-dispatch
durable evidence without conflating request, payload, and outcome.

#### Prepend a hidden control item to the ordinary queue

Rejected. The current queue is a shared public contract for editable,
reorderable user work. `QueueEntry` contains public content; dequeue calls
`registerQueued`, creates a `user-input` row, participates in command-ledger
settlement, pause/recovery, recently-dispatched state, WebSocket projection,
and queue UI. A hidden control item would require a new discriminated entry
type and policy across all of those layers:

- hide it from queue payloads while retaining internal ordering;
- prevent edit, delete, reorder, and manual steer controls;
- bypass user-input admission and resend/context folds;
- define whether manual pause blocks it and whether it jumps existing work;
- define success timing while it remains queued;
- settle or discard it on stop, deletion, view replacement, and shutdown;
- keep queue counts, recently-dispatched state, and failure pauses truthful.

That is a second queue protocol, not reuse. It also changes semantics from
immediate best-effort disclosure to delayed delivery that may occur after
unrelated successor work. Waiting for the exact rejected attempt and then
making one direct reservation provides the only useful queue-like behavior
without storing or exposing another queue entry.

#### Keep revision 27 route alternation

Rejected. Retargeting successor turns can deliver a stale control request to
unrelated work, and route watching creates liveness dependencies on every
ownership and provider-running transition. Three attempts do not establish a
stronger correctness property than one definitive fallback.

### Controller state

`ChatIdDiscoveryController` retains only irreducible state:

- one per-chat in-flight attempt and abort controller;
- same-non-null-run deduplication;
- abort/cleanup on view replacement or deletion;
- the control turn ID recursion fence.

The redundant stored `hasRun` flag is removed; `runId !== null` carries the
same information. A pending attempt still suppresses overlapping markers to
avoid duplicate control delivery. Markers from the control turn, and later
uncorrelated markers that cannot be distinguished from its late output, remain
suppressed until view replacement or deletion.

Unsupported steering is no longer a terminal feature outcome. It is a
definitive reason to try the direct route. If that route cannot reserve the
chat, the actual terminal condition is generic delivery failure. Remove the
unreachable `unsupported` failure reason and copy from the shared contract.

### Removed infrastructure

Delete or revert all route-watch-only machinery:

- the three-attempt logic and most tests in
  `server/chat-execution/control-input-delivery.ts`;
- `ExecutionOwnership.watchOwnerChange`, per-chat waiter storage, and
  chat-scoped notification signatures;
- route-change notifications from direct reservation, queue installation,
  idle checks, and ownership releases;
- `AgentEventBus.onRunActivityCleared` and registry forwarding;
- server-event wiring and tests added only to wake the route watcher.

Restore the pre-revision-27 global `notifyOwnersChanged()` behavior used by
existing snapshot/drain waiters. Keep the `node:crypto` import because the
coordinator directly generates identities.

Keep the accepted-without-prepare steer classification as `unknown`. Positive
provider acceptance cannot honestly be called not-sent, and treating it as
definitive would permit duplicate direct fallback. This also preserves the
ordinary queued-steer pause-for-review behavior introduced with revision 27.

## Failure Semantics

| Condition | Outcome |
| --- | --- |
| Discovery disabled | Hidden request persists; one visible disabled failure; no delivery. |
| Exact emitting target accepts steer | One visible success; no control turn. |
| Steer definitively rejects | Wait for the captured attempt to settle, then attempt one direct reservation. |
| Steer outcome unknown | One generic visible failure; no direct fallback. |
| Captured target missing or mismatched | Attempt one direct reservation without steering another run. |
| Successor or queue wins the direct reservation race | One generic visible failure; no retarget or retry. |
| Queue paused or contains pending work | One generic visible failure; reservation released. |
| View replacement or deletion aborts while waiting | No stale outcome notice; controller state is discarded. |
| Control turn schedules | One visible success immediately; later provider failure remains ordinary run history. |
| Control turn emits the request marker | Hidden request row persists; controller recursion fence suppresses delivery and outcome. |
| Restart after request commit, before outcome | Hidden evidence remains; no redispatch and no fabricated outcome. |
| Native Reload sees marker-only request | Hidden request reconstructed; no redispatch and no fabricated outcome. |

## Data, API, and Compatibility

- SQLite schema remains version 1. The new row uses the existing `notice`
  payload and needs no migration.
- `chat-id-request` is a ledger-private durable detail, not a shared WebSocket
  or `ChatMessage` union member.
- No HTTP or WebSocket payload changes. Raw ordinal ranges may include a
  hidden row, which existing paging and replay contracts already support.
- Remove `unsupported` from `ChatIdDiscoveryFailureReason`; server and client
  ship together, so no compatibility shim is required.
- The public settings shape and defaults remain unchanged.
- Existing revision-26 request rows become hidden by the same presentation
  predicate. Existing revision-27 ledgers are not rewritten.

## Security and Privacy

The hidden row contains no chat ID, prompt content, provider metadata, native
path, credentials, or transcript excerpt. It records only that the agent
requested disclosure. The actual chat ID remains in the visible success notice
and provider-native control input as before.

Hiding is enforced server-side at the ledger projection boundary, not only in
the web renderer. Shares, exports, API pages, replay, and WebSocket events
therefore cannot expose the support row accidentally.

## Performance

- One marker adds one small SQLite row and no schema/index work.
- Live publication remains one transaction; the hidden row does not add a
  second commit.
- Presentation performs one constant-time detail comparison per notice.
- Removing per-chat watchers, route notifications, retries, and successor
  captures reduces memory, fanout, and interleaving surface.
- Marker-only pages may contain no visible messages, which the raw-cursor
  paging contract already supports.

## Observability

- Visible success/failure notices remain the user diagnostic.
- A control-turn provider failure remains an ordinary `turn-failed` row/log.
- Existing structured `onError` logging remains for failed discovery
  delivery and notice append.
- No new metric or persisted retry state is required.

## Rollback

The implementation can be reverted as one feature change because it adds no
schema migration. Hidden request rows left by a rollback degrade to ordinary
untyped notices only if the hiding predicate is removed; therefore any rollback
must retain the presentation exclusion until those rows are deliberately
supported or deleted. Reverting only the routing simplification is safe and
does not affect stored data.

## Implementation Plan

### Add the hidden ledger row and fold exclusion

Files:

- `server/ledger/chat-id-request.ts`
- `server/ledger/service.ts`
- `server/ledger/presentation.ts`
- `server/ledger/imported-drafts.ts`

Work:

- Add the ledger-private draft constructor and predicate.
- Append one hidden draft per marker in the same producer transaction.
- Drop the row at `ledgerRowToMessage`.
- Reconstruct the row during native import without dispatch.

Tests:

- Update `server/ledger/__tests__/service.test.js` to assert physical row order,
  marker timestamp, synchronous dispatch-after-commit, and no visible message.
- Update `server/ledger/__tests__/imported-drafts.test.js` for remainder and
  marker-only imports.
- Extend `server/ledger/__tests__/read-fold-matrix.test.js` across rendering,
  export, conversation, search, resend, frozen projection, and native
  watermark.
- Add a store reopen assertion proving the hidden row survives restart.

Validation:

```sh
bun test server/ledger/__tests__/service.test.js \
  server/ledger/__tests__/imported-drafts.test.js \
  server/ledger/__tests__/read-fold-matrix.test.js \
  server/ledger/__tests__/native-activity.test.js
```

### Restore native-activity behavior

Files:

- `server/ledger/native-activity-query.ts`
- `server/ledger/__tests__/native-activity.test.js`

Work:

- Restore the pre-revision-27 SQL predicate exactly.
- Keep activation timing and probe orchestration untouched.
- Pin request/disclosure/disabled qualification and generic-failure exclusion.

Expected assertions:

```ts
expect(state.providerWatermark).toEqual({ ordinal: requestOrdinal, at: REQUEST_AT });
expect(genericFailureState.providerWatermark).toEqual(previousProviderWatermark);
expect(startupProbeCalls).toBe(0);
```

### Replace route alternation with one-shot delivery

Files:

- `server/chat-execution/control-input-delivery.ts`
- `server/chat-execution/__tests__/control-input-delivery.test.js`
- `server/chat-execution/chat-execution-coordinator.ts`
- `server/chat-execution/__tests__/chat-execution-coordinator.test.js`

Work:

- Add emitting-run correlation to `deliverControlInput`.
- Capture only once.
- Keep ambiguous outcomes terminal.
- Wait only for the rejected captured attempt.
- Schedule only one direct route.
- Remove retry, retarget, and watcher plumbing.
- Keep direct reservation, queue/pause, deletion, and release checks.

Required unit cases:

- accepted steer returns without direct scheduling;
- unsupported, not-steerable, changed, unavailable, and confirmed-not-sent
  each settle the exact target then schedule once;
- ambiguous steer rejects without scheduling;
- mismatched successor is never steered;
- direct busy rejects immediately without a watch or retry;
- abort interrupts settlement wait and prevents direct scheduling;
- direct schedule registers the control turn before provider dispatch;
- direct queue and pause blocks release ownership;
- no user-input admission, prepared-input match, or queue row occurs.

### Remove route-watch infrastructure

Files:

- `server/chat-execution/execution-ownership.ts`
- `server/chat-execution/__tests__/execution-ownership.test.js`
- `server/chat-execution/queue-drainer.ts`
- `server/agents/event-bus.ts`
- `server/agents/registry.ts`
- `server/agents/__tests__/event-bus.test.js`
- `server/server-event-wiring.ts`
- `server/__tests__/server-event-wiring.test.js`

Work:

- Revert only revision-27 watcher APIs, state, notifications, and tests.
- Restore terminal `checkChatIdle` calls in finished/failed handlers.
- Preserve all unrelated lifecycle behavior.

Validation:

```sh
bun test server/chat-execution/__tests__/execution-ownership.test.js \
  server/chat-execution/__tests__/queue-drainer.test.js \
  server/agents/__tests__/event-bus.test.js \
  server/__tests__/server-event-wiring.test.js
```

### Simplify controller and shared outcomes

Files:

- `server/chats/chat-id-discovery-controller.ts`
- `server/chats/__tests__/chat-id-discovery-controller.test.js`
- `common/chat-id-discovery.ts`
- `common/transcript-notice-details.ts`
- `common/__tests__/transcript-notice-contract.test.js`
- `server/server.ts`

Work:

- Pass the emitting run ID into delivery.
- Remove redundant attempt state and unsupported classification.
- Preserve enabled gating, abort, same-run dedupe, pending gate, notice identity
  fencing, and control-turn recursion fencing.
- Remove unreachable unsupported copy and contract variants.

### Update normative design and conformance traceability

Files:

- `docs/transcript-ledger-v5-design.md`
- `docs/transcript-ledger-v5-cts.md`
- `scripts/conformance/transcript-ledger-v5-cases.txt`

Work:

- Add revision 28 describing one visible outcome plus one hidden request row.
- Replace three-attempt routing and route-watch language with one steer and one
  direct attempt.
- Restore native-activity text to marker evidence and remove revision-27
  limitations caused by marker loss, failure-watermark broadening, retargeting,
  and overlapping route waits.
- Keep the control-turn recursion and ordinary-background-lifecycle limitations.
- Update the design SHA-256 pin and exact CTS evidence mapping.
- Rename or replace cases where their semantics changed; keep every inventory
  ID backed by one real tagged test.

### Validate end to end

Focused server and contract checks:

```sh
bun test common/__tests__/chat-id-discovery.test.js \
  common/__tests__/transcript-notice-contract.test.js \
  server/chats/__tests__/chat-id-discovery-controller.test.js \
  server/chat-execution/__tests__/control-input-delivery.test.js \
  server/chat-execution/__tests__/chat-execution-coordinator.test.js \
  server/ledger/__tests__/service.test.js \
  server/ledger/__tests__/imported-drafts.test.js \
  server/ledger/__tests__/read-fold-matrix.test.js \
  server/ledger/__tests__/native-activity.test.js \
  server/__tests__/architecture-budgets.test.js
```

Scripted and black-box checks:

```sh
bun test tests/server/claude-scripted-chat-id-discovery.test.ts
bun test tests/server/codex-scripted-steer.test.ts -t "requested chat ID"
bun test tests/server/opencode-scripted-steer.test.ts -t "requested chat ID"
bun test tests/server/pi-scripted-queue.test.ts -t "requested chat ID"
bun test tests/server/chat-lifecycle.test.ts -t "direct control turn"
```

Run those from `integration-tests/`. Then run repository gates:

```sh
bun run test
bun run typecheck
bun run check
bun run test:transcript-inventory
```

Finally start an isolated server with a fresh disk-backed workspace,
`GARCON_BIND_ADDRESS=0.0.0.0`, and port `0`. Do not disturb an existing server.

## Resolved Decisions

- “One row” means one visible transcript row. A hidden physical support row is
  allowed and preferred.
- The request row is durable evidence, not durable execution intent.
- The row is ledger-private and hidden at the server projection boundary.
- Native drift remains activation-only and returns to its pre-revision-27
  predicate.
- Outcomes keep marker-anchored timestamps but generic failures do not become
  provider evidence.
- Delivery targets only the emitting run, once.
- Definitive non-delivery permits one direct fallback after exact-attempt
  settlement.
- Ambiguous delivery never permits fallback.
- Direct contention fails immediately; no successor retarget, route watch, or
  retry exists.
- Control-turn scheduling is success; provider completion remains ordinary
  lifecycle.
- Unsupported steering is a fallback trigger, not a terminal feature reason.
- Recursion fencing, in-flight serialization, deletion/view abort, and direct
  ownership remain because they prevent duplicate or stale control work.
- The accepted-without-prepare steer outcome remains `unknown` for both control
  and ordinary queued steering.

## Deferred Risks

- A provider attempt that never settles can keep the single delivery pending
  until view replacement or deletion aborts it. No timeout is added because a
  timeout cannot prove non-delivery and would reintroduce duplicate risk.
- The direct control turn may create a second processing/attention lifecycle
  notification. Suppressing it would require a separate lifecycle contract and
  is outside this simplification.
- The conservative recursion fence may suppress a later uncorrelated genuine
  marker after a control turn. Durable rows do not carry run attribution, so
  relaxing it would risk recursive disclosure.
- A crash after the hidden request commit and before an outcome leaves no
  visible outcome. Restart intentionally does not replay ephemeral execution.
